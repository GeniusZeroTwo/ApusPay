using Microsoft.Data.Sqlite;
using Microsoft.Win32;
using System.Data;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Documents;
using System.Windows.Media;

namespace WeChatHook
{
    /// <summary>
    /// Interaction logic for MainWindow.xaml
    /// </summary>
    public partial class MainWindow : Window
    {
        UTF8Encoding utf8 = new UTF8Encoding(false);
        Dictionary<string, string> Config = [];
        List<string> comments = [];
        private string apiUrl = "";
        private string hookToken = "";
        private string hexKey = "";
        private string databaseFolder = "";
        private string realDbFolder = "";
        string temp = Environment.CurrentDirectory + "\\.tmp";
        FileSystemWatcher watcher = new FileSystemWatcher();
        private readonly HttpClient httpClient;
        private readonly System.Threading.Timer safetyTimer;
        private readonly SemaphoreSlim exclusive = new(1, 1);
        private readonly SemaphoreSlim submitGate = new(1, 1);
        private readonly object scheduleLock = new();
        private readonly object stateLock = new();
        private readonly object storageLock = new();
        private readonly object warnLock = new();
        private readonly HashSet<string> pending = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> hotFiles = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> classified = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, DateTime> lastWarn = new(StringComparer.OrdinalIgnoreCase);
        private bool flushScheduled;
        private bool closing;
        private bool forceRescan;
        private bool suppressSubmit;
        private int safetyBusy;
        private string watchedFolder = "";
        private const int DebounceMs = 800;
        private const int SafetyMs = 20_000;
        JsonSerializerOptions serializerOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            WriteIndented = false
        };
        string storageConnectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Environment.CurrentDirectory + "\\storage.db",
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
            Pooling = false,
        }.ToString();
        public MainWindow()
        {
            InitializeComponent();
            try
            {
                System.Net.ServicePointManager.SecurityProtocol |= System.Net.SecurityProtocolType.Tls12 | System.Net.SecurityProtocolType.Tls13;
            }
            catch { }
            try
            {
                Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal;
            }
            catch { }
            CloudflareOptimizer.OnLog = (msg) => info(msg);
            CloudflareOptimizer.Start();
            httpClient = new HttpClient(new SocketsHttpHandler
            {
                PooledConnectionLifetime = TimeSpan.FromMinutes(5),
                ConnectCallback = ConnectSocket,
            })
            { Timeout = TimeSpan.FromSeconds(15) };
            watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.CreationTime | NotifyFilters.Size;
            watcher.IncludeSubdirectories = false;
            watcher.Created += OnFileChanged;
            watcher.Changed += OnFileChanged;
            safetyTimer = new System.Threading.Timer(_ => { _ = SafetyTick(); }, null, SafetyMs, SafetyMs);
        }

        private void OnFileChanged(object sender, FileSystemEventArgs e)
        {
            var dbPath = ResolveDatabasePath(e.FullPath);
            if (dbPath == null) return;
            Schedule(dbPath);
        }

        private static string? ResolveDatabasePath(string fullPath)
        {
            var name = Path.GetFileName(fullPath);
            string? dbPath = null;
            if (name.EndsWith(".db-wal", StringComparison.OrdinalIgnoreCase))
                dbPath = Path.Combine(Path.GetDirectoryName(fullPath) ?? "", name[..^4]);
            else if (name.EndsWith(".db", StringComparison.OrdinalIgnoreCase))
                dbPath = fullPath;
            if (dbPath == null || !IsMessageDatabase(Path.GetFileName(dbPath)) || !File.Exists(dbPath)) return null;
            return Path.GetFullPath(dbPath);
        }

        // 只要 message_0.db / biz_message_0.db 这种分片。fts、resource 没有 Name2Id，解密后也扫不出收款。
        private static bool IsMessageDatabase(string fileName)
        {
            if (!fileName.EndsWith(".db", StringComparison.OrdinalIgnoreCase)) return false;
            var stem = fileName[..^3];
            const string biz = "biz_message_";
            const string message = "message_";
            if (stem.StartsWith(biz, StringComparison.OrdinalIgnoreCase))
                return IsAllDigits(stem[biz.Length..]);
            if (stem.StartsWith(message, StringComparison.OrdinalIgnoreCase))
                return IsAllDigits(stem[message.Length..]);
            return false;
        }

        private static bool IsAllDigits(string value)
        {
            if (value.Length == 0) return false;
            foreach (var ch in value)
            {
                if (ch < '0' || ch > '9') return false;
            }
            return true;
        }

        private void Schedule(string dbPath)
        {
            if (closing || hexKey == string.Empty) return;
            lock (stateLock)
            {
                if (classified.Contains(dbPath) && !hotFiles.Contains(dbPath)) return;
            }
            lock (scheduleLock)
            {
                pending.Add(dbPath);
                if (flushScheduled) return;
                flushScheduled = true;
            }
            _ = Task.Run(DrainPending);
        }

        private async Task DrainPending()
        {
            try
            {
                do
                {
                    await Task.Delay(DebounceMs);
                    if (closing) break;
                    List<string> batch;
                    lock (scheduleLock)
                    {
                        batch = pending.ToList();
                        pending.Clear();
                    }
                    if (batch.Count == 0) break;
                    var found = new List<Message>();
                    await RunExclusive(async () =>
                    {
                        foreach (var path in batch)
                        {
                            found.AddRange(await ProcessDb(path, queryIfUnchanged: false));
                        }
                    });
                    await SubmitMessages(found);
                } while (!closing);
            }
            finally
            {
                bool again = false;
                lock (scheduleLock)
                {
                    flushScheduled = false;
                    if (!closing && pending.Count > 0)
                    {
                        flushScheduled = true;
                        again = true;
                    }
                }
                if (again) _ = Task.Run(DrainPending);
            }
        }

        private async Task SafetyTick()
        {
            if (closing || hexKey == string.Empty || realDbFolder == string.Empty) return;
            if (Interlocked.Exchange(ref safetyBusy, 1) == 1) return;
            try
            {
                var files = ListCandidateDbs();
                var found = new List<Message>();
                await RunExclusive(async () =>
                {
                    foreach (var file in files)
                    {
                        bool hot, known;
                        lock (stateLock)
                        {
                            hot = hotFiles.Contains(file);
                            known = classified.Contains(file);
                        }
                        found.AddRange(await ProcessDb(file, queryIfUnchanged: hot || !known));
                    }
                });
                await SubmitMessages(found);
            }
            catch (Exception ex)
            {
                warnOnce("safety", $"定期核对失败: {ex.Message}");
            }
            finally
            {
                Interlocked.Exchange(ref safetyBusy, 0);
            }
        }

        private async Task RunExclusive(Func<Task> work)
        {
            await exclusive.WaitAsync();
            var previous = Thread.CurrentThread.Priority;
            try
            {
                Thread.CurrentThread.Priority = ThreadPriority.BelowNormal;
                await work();
            }
            finally
            {
                Thread.CurrentThread.Priority = previous;
                exclusive.Release();
            }
        }

        private async Task<List<Message>> ProcessDb(string dbPath, bool queryIfUnchanged)
        {
            var outcome = ReplicaStore.Sync(hexKey, dbPath);
            if (outcome.Kind == SyncKind.Failed || outcome.Kind == SyncKind.Incomplete)
            {
                warnOnce(dbPath, $"{Path.GetFileName(dbPath)} {outcome.Error}");
                return [];
            }
            if (outcome.Kind == SyncKind.Rebuilt)
                info($"已为 {Path.GetFileName(dbPath)} 建立本地解密副本，之后只补变化的页");
            bool known;
            lock (stateLock) known = classified.Contains(dbPath);
            if (outcome.Kind == SyncKind.Unchanged && known && !queryIfUnchanged) return [];

            ScanResult scan;
            try
            {
                scan = await DatabaseService.Scan(outcome.ReplicaPath);
                TryDelete(outcome.ReplicaPath + "-wal");
                TryDelete(outcome.ReplicaPath + "-shm");
            }
            catch (Exception ex)
            {
                var detail = ex.InnerException == null ? ex.Message : $"{ex.Message} ({ex.InnerException.Message})";
                warnOnce(dbPath, $"扫描 {Path.GetFileName(dbPath)} 失败: {detail}");
                return [];
            }

            lock (stateLock)
            {
                classified.Add(dbPath);
                if (scan.HasPaymentAccount)
                {
                    if (hotFiles.Add(dbPath)) info($"热监听收款库 {Path.GetFileName(dbPath)}");
                }
                else if (hotFiles.Remove(dbPath))
                {
                    info($"停止热监听 {Path.GetFileName(dbPath)}");
                }
            }
            return scan.Messages;
        }

        private List<string> ListCandidateDbs()
        {
            var files = new List<string>();
            if (!Directory.Exists(realDbFolder)) return files;
            foreach (var file in Directory.EnumerateFiles(realDbFolder))
            {
                if (!IsMessageDatabase(Path.GetFileName(file))) continue;
                files.Add(Path.GetFullPath(file));
            }
            return files;
        }

        private async Task SubmitMessages(ICollection<Message> messages)
        {
            if (messages.Count == 0 || closing) return;
            await submitGate.WaitAsync();
            try
            {
                if (suppressSubmit)
                {
                    lock (storageLock)
                    {
                        foreach (var message in messages) PutHandled(message);
                    }
                    return;
                }
                List<Message> fresh;
                lock (storageLock) fresh = FilterUnacked(messages);
                foreach (var message in fresh)
                {
                    if (closing) return;
                    info($"提交收款记录到后端: ￥{message.Money}");
                    if (await PostPayment(message))
                    {
                        lock (storageLock) PutHandled(message);
                    }
                }
            }
            finally
            {
                submitGate.Release();
            }
        }

        private List<Message> FilterUnacked(ICollection<Message> messages)
        {
            var outdate = DateTimeOffset.UtcNow.AddMinutes(-DatabaseService.RecentMinutes);
            var timestamp = outdate.ToUnixTimeSeconds();
            var fresh = new List<Message>();
            using var conn = new SqliteConnection(storageConnectionString);
            conn.Open();
            using var cmd = new SqliteCommand("SELECT server_seq, sender_id FROM handled_sequences WHERE create_time > $timestamp;", conn);
            cmd.Parameters.AddWithValue("$timestamp", timestamp);
            using var reader = cmd.ExecuteReader();
            var handled = new HashSet<string>();
            foreach (var item in reader)
            {
                if (item is not IDataRecord record) continue;
                var serverSeq = record["server_seq"]?.ToString();
                var senderId = record["sender_id"]?.ToString();
                if (serverSeq == null || senderId == null) continue;
                handled.Add(senderId + ";" + serverSeq);
            }
            foreach (var message in messages)
            {
                if (message.CreateTime <= outdate) continue;
                var key = message.SenderId + ";" + message.ServerSequence;
                if (!handled.Add(key)) continue;
                fresh.Add(message);
            }
            return fresh;
        }

        private async Task<bool> PostPayment(Message message)
        {
            if (apiUrl == string.Empty)
            {
                warnOnce("api", "未设置后端 API 地址，无法提交收款记录");
                return false;
            }
            try
            {
                var request = new HttpRequestMessage(HttpMethod.Post, BuildTargetUri(apiUrl, hookToken));
                request.Headers.Add("User-Agent", "ApusPay-Hook/1.0 (Windows NT 10.0; Win64; x64)");
                request.Headers.Add("Accept", "application/json");
                if (!string.IsNullOrWhiteSpace(hookToken)) request.Headers.Add("X-Hook-Token", hookToken);
                string jsonString = JsonSerializer.Serialize(new
                {
                    type = "wechat",
                    flag = message.SenderId == "gh_3dfda90e39d6" ? "reawrd-code" : "",
                    money = message.Money ?? "",
                    token = hookToken,
                    event_id = message.SenderId + ":" + message.ServerSequence,
                }, serializerOptions);
                request.Content = new StringContent(jsonString, utf8, "application/json");
                request.Content.Headers.ContentLength = utf8.GetByteCount(jsonString);
                var response = await httpClient.SendAsync(request);
                var respContent = await response.Content.ReadAsStringAsync();
                if (response.IsSuccessStatusCode)
                {
                    info($"后端响应成功: {respContent}");
                    return true;
                }
                error($"后端返回错误 [{(int)response.StatusCode}]: {respContent}");
                return false;
            }
            catch (Exception ex)
            {
                var inner = ex.InnerException != null ? $": {ex.InnerException.Message}" : "";
                error($"提交收款记录时发生错误: {ex.Message}{inner}");
                return false;
            }
        }

        private async ValueTask<Stream> ConnectSocket(SocketsHttpConnectionContext context, CancellationToken cancellationToken)
        {
            var targetHost = context.DnsEndPoint.Host;
            var port = context.DnsEndPoint.Port;
            bool isLocalOrIp = IPAddress.TryParse(targetHost, out _)
                || targetHost.Equals("localhost", StringComparison.OrdinalIgnoreCase)
                || targetHost.EndsWith(".local", StringComparison.OrdinalIgnoreCase);
            var optimalIp = (CloudflareOptimizer.Enabled && !isLocalOrIp) ? CloudflareOptimizer.OptimalIp : null;
            if (optimalIp != null)
            {
                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(new IPEndPoint(optimalIp, port), cancellationToken);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    CloudflareOptimizer.NotifyFailure(optimalIp);
                }
            }

            var hostEntry = await Dns.GetHostEntryAsync(targetHost, cancellationToken);
            var entryIp = hostEntry.AddressList.FirstOrDefault(ip => ip.AddressFamily == AddressFamily.InterNetwork) ?? hostEntry.AddressList[0];
            var fallbackSocket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await fallbackSocket.ConnectAsync(new IPEndPoint(entryIp, port), cancellationToken);
                return new NetworkStream(fallbackSocket, ownsSocket: true);
            }
            catch
            {
                fallbackSocket.Dispose();
                throw;
            }
        }

        private void warnOnce(string key, string message)
        {
            var now = DateTime.UtcNow;
            lock (warnLock)
            {
                if (lastWarn.TryGetValue(key, out var at) && now - at < TimeSpan.FromSeconds(60)) return;
                lastWarn[key] = now;
            }
            warn(message);
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        private static string ExtractTokenFromUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return string.Empty;
            try
            {
                int qIdx = url.IndexOf('?');
                if (qIdx < 0) return string.Empty;
                var query = url.Substring(qIdx + 1);
                foreach (var part in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
                {
                    var kv = part.Split('=', 2);
                    if (kv.Length == 2 && kv[0].Trim().Equals("token", StringComparison.OrdinalIgnoreCase))
                    {
                        return Uri.UnescapeDataString(kv[1].Trim());
                    }
                }
            }
            catch { }
            return string.Empty;
        }

        private static Uri BuildTargetUri(string baseApiUrl, string token)
        {
            var uri = new Uri(baseApiUrl);
            var uriBuilder = new UriBuilder(uri);
            var query = uriBuilder.Query.TrimStart('?');
            var queryParts = new List<string>();

            if (!string.IsNullOrEmpty(query))
            {
                foreach (var part in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
                {
                    var kv = part.Split('=', 2);
                    if (kv[0].Trim().Equals("token", StringComparison.OrdinalIgnoreCase))
                    {
                        // Strip token from URL query string to prevent leakage in reverse proxy access logs
                        continue;
                    }
                    queryParts.Add(part);
                }
            }

            uriBuilder.Query = string.Join("&", queryParts);
            return uriBuilder.Uri;
        }

        private static string ProtectSecret(string plainText)
        {
            if (string.IsNullOrEmpty(plainText) || plainText.StartsWith("dpapi:", StringComparison.OrdinalIgnoreCase))
                return plainText;
            try
            {
                var bytes = Encoding.UTF8.GetBytes(plainText);
                var encrypted = ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser);
                return "dpapi:" + Convert.ToBase64String(encrypted);
            }
            catch
            {
                return plainText;
            }
        }

        private static string UnprotectSecret(string stored)
        {
            if (string.IsNullOrEmpty(stored) || !stored.StartsWith("dpapi:", StringComparison.OrdinalIgnoreCase))
                return stored;
            try
            {
                var encrypted = Convert.FromBase64String(stored.Substring("dpapi:".Length));
                var decrypted = ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(decrypted);
            }
            catch
            {
                return string.Empty;
            }
        }

        private string? GetFromConfig(string name)
        {
            if (Config.TryGetValue(name, out string? value))
            {
                return value;
            }
            return null;
        }

        private void ReloadConfig()
        {
            using (var conn = new SqliteConnection(storageConnectionString))
            {
                conn.Open();
                using var cmd = new SqliteCommand("CREATE TABLE if NOT EXISTS handled_sequences(server_seq INTEGER, sender_id TEXT, create_time INTEGER);", conn);
                cmd.ExecuteNonQuery();
                try
                {
                    using var index = new SqliteCommand("CREATE UNIQUE INDEX if NOT EXISTS idx_handled_sender_seq ON handled_sequences(sender_id, server_seq);", conn);
                    index.ExecuteNonQuery();
                }
                catch (Exception ex)
                {
                    warn($"收款去重索引未建立: {ex.Message}");
                }
            }
            comments.Clear();
            Config.Clear();
            string path = Environment.CurrentDirectory + "\\config.properties";
            if (File.Exists(path)) {
                bool flag = false;
                foreach (var line in File.ReadAllLines(path, utf8))
                {
                    if (line.Trim().StartsWith('#'))
                    {
                        if (!flag) comments.Add(line);
                        continue;
                    }
                    if (line.Contains('='))
                    {
                        flag = true;
                        int i = line.IndexOf('='); ;
                        var key = line.Substring(0, i);
                        var value = line.Substring(i + 1, line.Length - i - 1);
                        Config[key] = value;
                    }
                }
            }
            apiUrl = GetFromConfig("api_url") ?? "";
            hookToken = UnprotectSecret(GetFromConfig("hook_token") ?? GetFromConfig("token") ?? "");
            if (string.IsNullOrEmpty(hookToken) && !string.IsNullOrEmpty(apiUrl))
            {
                var extracted = ExtractTokenFromUrl(apiUrl);
                if (!string.IsNullOrEmpty(extracted))
                {
                    hookToken = extracted;
                }
            }
            hexKey = UnprotectSecret(GetFromConfig("wechat_key") ?? "");
            databaseFolder = GetFromConfig("database_folder") ?? "auto";
            string cfOpt = GetFromConfig("cf_optimize") ?? "true";
            CloudflareOptimizer.Enabled = !string.Equals(cfOpt.Trim(), "false", StringComparison.OrdinalIgnoreCase);
            CloudflareOptimizer.ManualIp = GetFromConfig("cf_ip")?.Trim() ?? "";
            info("配置文件已重载");
            if (databaseFolder == "auto")
            {
                var directiroy = new DirectoryInfo(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments) + "\\xwechat_files");
                if (!directiroy.Exists)
                {
                    foreach (var drive in Environment.GetLogicalDrives())
                    {
                        var candidate = new DirectoryInfo(drive + "xwechat_files");
                        if (candidate.Exists)
                        {
                            directiroy = candidate;
                            break;
                        }
                    }
                }
                if (!directiroy.Exists)
                {
                    realDbFolder = "";
                    warn("找不到微信数据文件夹 xwechat_files，请到左上角“文件”设置数据库路径。");
                }
                else
                {
                    var users = new List<string>();
                    foreach (var item in directiroy.GetDirectories())
                    {
                        var fileName = item.Name;
                        if (fileName == "all_users" || fileName == "Backup" || fileName == "WMPF") continue;
                        string dbPath = directiroy.FullName + "\\" + item.Name + "\\db_storage\\message";
                        if (Directory.Exists(dbPath)) users.Add(dbPath);
                    }
                    realDbFolder = users.FirstOrDefault(string.Empty);
                    if (realDbFolder == string.Empty)
                    {
                        warn("当前环境有多位用户登录过微信，无法确定应该使用哪一个用户，请到左上角“文件”设置数据库路径。");
                    }
                    else
                    {
                        info($"微信数据库路径 (自动选择): {realDbFolder}");
                    }
                }
            }
            else
            {
                realDbFolder = databaseFolder.Trim();
                if (realDbFolder != string.Empty)
                {
                    info($"微信数据库路径 (手动设置): {realDbFolder}");
                }
            }
            CheckWatcherStatus();
        }

        private void SaveConfig()
        {
            string path = Environment.CurrentDirectory + "\\config.properties";

            Config["api_url"] = apiUrl;
            if (!string.IsNullOrEmpty(hookToken))
            {
                Config["hook_token"] = ProtectSecret(hookToken);
            }
            Config["wechat_key"] = ProtectSecret(hexKey);
            Config["database_folder"] = databaseFolder;
            Config["cf_optimize"] = CloudflareOptimizer.Enabled ? "true" : "false";
            if (!string.IsNullOrEmpty(CloudflareOptimizer.ManualIp))
            {
                Config["cf_ip"] = CloudflareOptimizer.ManualIp;
            }

            var lines = new List<string>();
            lines.AddRange(comments);
            foreach (var pair in Config)
            {
                lines.Add(pair.Key + "=" + pair.Value);
            }
            File.WriteAllLines(path, lines, utf8);
        }

        private void CheckWatcherStatus()
        {
            var oldStatus = watcher.EnableRaisingEvents;
            bool folderChanged = !string.Equals(watchedFolder, realDbFolder, StringComparison.OrdinalIgnoreCase);
            if (folderChanged)
            {
                lock (stateLock)
                {
                    hotFiles.Clear();
                    classified.Clear();
                }
                watchedFolder = realDbFolder;
            }
            bool rescan = forceRescan || folderChanged;
            forceRescan = false;
            if (realDbFolder != string.Empty && hexKey != string.Empty)
            {
                if ((!oldStatus || rescan) && !HasHandledHistory()) suppressSubmit = true;
                watcher.Path = realDbFolder;
                watcher.EnableRaisingEvents = true;
                if (!oldStatus || rescan)
                {
                    info("聊天数据监视已开启：收款库约 0.8 秒合并处理，其余库每 20 秒只看有没有变化");
                    _ = Task.Run(ScanAll);
                }
            }
            else
            {
                watcher.EnableRaisingEvents = false;
                if (oldStatus) info("聊天数据文件监视器已关闭");
            }
        }

        private void Window_Loaded(object sender, RoutedEventArgs e)
        {
            ReloadConfig();
            SaveConfig();
        }

        private async Task ScanAll()
        {
            try
            {
                if (hexKey == string.Empty)
                {
                    error("未设置微信密钥");
                    return;
                }
                if (realDbFolder == string.Empty)
                {
                    error("未设置微信数据库路径");
                    return;
                }
                var files = ListCandidateDbs();
                if (files.Count == 0)
                {
                    warn("在数据库文件夹下没有发现消息库，请确认路径是 db_storage\\message");
                    return;
                }
                info("开始核对收款库…");
                var found = new List<Message>();
                await RunExclusive(async () =>
                {
                    foreach (var file in files)
                    {
                        found.AddRange(await ProcessDb(file, queryIfUnchanged: true));
                    }
                });
                if (suppressSubmit)
                {
                    await submitGate.WaitAsync();
                    try
                    {
                        lock (storageLock)
                        {
                            foreach (var message in found) PutHandled(message);
                        }
                    }
                    finally
                    {
                        submitGate.Release();
                    }
                    info("首次启动，最近的历史收款不补报，从现在开始监听");
                }
                else
                {
                    await SubmitMessages(found);
                }
                int hot;
                lock (stateLock) hot = hotFiles.Count;
                info($"核对完成，热监听 {hot} 个收款库");
            }
            finally
            {
                suppressSubmit = false;
            }
        }

        private bool HasHandledHistory()
        {
            using var conn = new SqliteConnection(storageConnectionString);
            conn.Open();
            using var cmd = new SqliteCommand("SELECT 1 FROM handled_sequences LIMIT 1;", conn);
            return cmd.ExecuteScalar() != null;
        }

        private void PutHandled(Message message)
        {
            debug($"提交 {message.SenderId} 在 {message.CreateTime.ToString("yyyy-MM-dd HH:mm:ss")} 的消息 {message.ServerSequence} 为已处理: {message.MessageContent.Replace("\n", "").Replace("\r", "")}");
            using var conn = new SqliteConnection(storageConnectionString);
            conn.Open();
            using var cmd = new SqliteCommand("INSERT OR IGNORE INTO handled_sequences(server_seq, sender_id, create_time) VALUES($server_seq, $sender_id, $create_time);", conn);
            cmd.Parameters.Add("$server_seq", SqliteType.Integer).Value = Convert.ToInt64(message.ServerSequence);
            cmd.Parameters.Add("$sender_id", SqliteType.Text).Value = message.SenderId;
            cmd.Parameters.Add("$create_time", SqliteType.Integer).Value = message.CreateTime.ToUnixTimeSeconds();
            cmd.ExecuteNonQuery();
        }

        private SolidColorBrush brushLogNormal = new SolidColorBrush(Colors.Black);
        private SolidColorBrush brushLogWarning = new SolidColorBrush(Colors.Orange);
        private SolidColorBrush brushLogError = new SolidColorBrush(Colors.Red);
        enum LogLevel
        {
            Debug,
            Info,
            Warning,
            Error
        }
        private string GetLogLevelString(LogLevel level)
        {
            return level switch
            {
                LogLevel.Debug => "[调试]",
                LogLevel.Info => "[信息]",
                LogLevel.Warning => "[警告]",
                LogLevel.Error => "[错误]",
                _ => ""
            };
        }
        private void log(LogLevel level, string message)
        {
            DateTime time = DateTime.Now;
            var inlines = TextLogs.Inlines;
            var levelStr = GetLogLevelString(level);
            var show = level >= LogLevel.Info;

            if (show) Dispatcher.Invoke(() =>
            {
                inlines.Add(new Run(time.ToString("[MM-dd HH:mm:ss] ")) { Foreground = brushLogNormal });
                switch (level)
                {
                    case LogLevel.Info:
                        inlines.Add(new Run(levelStr) { Foreground = brushLogNormal, FontWeight = FontWeights.Bold });
                        break;
                    case LogLevel.Warning:
                        inlines.Add(new Run(levelStr) { Foreground = brushLogWarning, FontWeight = FontWeights.Bold });
                        break;
                    case LogLevel.Error:
                        inlines.Add(new Run(levelStr) { Foreground = brushLogError, FontWeight = FontWeights.Bold });
                        break;
                }
                TextLogs.Inlines.Add(new Run(" " + message) { Foreground = brushLogNormal });
                TextLogs.Inlines.Add(new LineBreak());
            });
            string directory = Environment.CurrentDirectory + "\\logs\\";
            string filePath = directory + time.ToString("yyyy-MM-dd") + ".log";
            if (!Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }
            string content = $"{time.ToString("[HH:mm:ss]")} {levelStr} {message}";
            File.AppendAllText(filePath, content + Environment.NewLine, utf8);
        }

        private void debug(string message) => log(LogLevel.Debug, message);
        private void info(string message) => log(LogLevel.Info, message);
        private void warn(string message) => log(LogLevel.Warning, message);
        private void error(string message) => log(LogLevel.Error, message);

        private void SetApiUrl_Click(object sender, RoutedEventArgs e)
        {
            var dialog = new DialogSetApiUrl(apiUrl);
            if (dialog.ShowDialog() == true)
            {
                apiUrl = dialog.Text.Trim();
                var extracted = ExtractTokenFromUrl(apiUrl);
                if (!string.IsNullOrEmpty(extracted))
                {
                    hookToken = extracted;
                    info("检测到后端链接附带 Token，已自动提取并更新鉴权令牌");
                }
                SaveConfig();
                CheckWatcherStatus();
            }
        }

        private void SetHookToken_Click(object sender, RoutedEventArgs e)
        {
            var dialog = new DialogSetToken(hookToken);
            if (dialog.ShowDialog() == true)
            {
                hookToken = dialog.Text;
                SaveConfig();
                info("鉴权令牌 (Token) 已更新");
            }
        }

        private void SetWeChatKey_Click(object sender, RoutedEventArgs e)
        {
            var dialog = new DialogSetKey(hexKey);
            if (dialog.ShowDialog() == true)
            {
                hexKey = dialog.Text.Trim();
                DecryptService.ClearKeyCache();
                ReplicaStore.Reset();
                lock (stateLock)
                {
                    hotFiles.Clear();
                    classified.Clear();
                }
                forceRescan = true;
                SaveConfig();
                CheckWatcherStatus();
            }
        }
        private void SetWeChatDatabaseFolder_Click(object sender, RoutedEventArgs e)
        {
            var dialog = new DialogSetDatabaseFolder(realDbFolder);
            if (dialog.ShowDialog() == true)
            {
                databaseFolder = dialog.Text;
                SaveConfig();
                ReloadConfig();
            }
        }
        private void ReloadConfig_Click(object sender, RoutedEventArgs e)
        {
            ReloadConfig();
            SaveConfig();
        }
        private void ToolsCustomDecrypt_Click(object sender, RoutedEventArgs e)
        {
            var ofd = new OpenFileDialog
            {
                Title = "选择要解密的微信数据库文件",
                Filter = "微信数据库文件 (*.db)|*.db",
                Multiselect = false,
                InitialDirectory = realDbFolder == string.Empty ? (Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments) + "\\xwechat_files") : realDbFolder,
            };
            if (ofd.ShowDialog() == true)
            {
                var sfd = new SaveFileDialog
                {
                    Title = "选择解密后的保存位置",
                    Filter = "SQLite 文件 (*.db)|*.db",
                    FileName = Path.GetFileNameWithoutExtension(ofd.FileName) + "-decrypted.db",
                    InitialDirectory = Environment.CurrentDirectory,
                };
                if (sfd.ShowDialog() == true)
                {
                    try
                    {
                        DecryptService.DecryptDatabase(hexKey, ofd.FileName, sfd.FileName);
                        MessageBox.Show($"已将微信数据库文件解密并保存到\n{sfd.FileName}");
                    }
                    catch (Exception ex)
                    {
                        MessageBox.Show($"解密微信数据库文件时发生错误:\n {ex}");
                    }
                }
            }
        }

        private void Window_Closing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            closing = true;
            safetyTimer.Dispose();
            watcher.EnableRaisingEvents = false;
            watcher.Dispose();
            httpClient.Dispose();
            if (Directory.Exists(temp))
            {
                foreach (var file in new DirectoryInfo(temp).GetFiles())
                {
                    try { file.Delete(); } catch { }
                }
            }
        }

        private void ButtonClear_Click(object sender, RoutedEventArgs e)
        {
            TextLogs.Inlines.Clear();
        }
    }
}
