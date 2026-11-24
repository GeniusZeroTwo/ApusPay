using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace WeChatHook
{
    /// <summary>
    /// Cloudflare 内存级动态优选直连引擎
    /// 在不修改系统 hosts、无需管理员权限、不触发杀毒软件报警的前提下，
    /// 自动测速并直连 Cloudflare 国内优质节点，彻底解决小云朵 TLS 阻断与连接重置 (10054) 问题。
    /// </summary>
    public static class CloudflareOptimizer
    {
        // 针对国内三大运营商优化的 Cloudflare 官方优质 Anycast 候选节点池
        private static readonly string[] CandidateIps =
        [
            "104.16.160.1",
            "104.16.161.1",
            "104.16.162.1",
            "104.17.200.1",
            "104.17.201.1",
            "104.17.202.1",
            "162.159.153.1",
            "162.159.153.2",
            "172.64.150.1",
            "172.64.150.2",
            "104.18.20.1",
            "104.18.21.1",
            "198.41.214.1",
            "198.41.215.1",
            "104.19.18.1",
            "104.19.19.1"
        ];

        // Cloudflare 官方 IPv4 Anycast 网段列表（仅当目标域名本身解析至 Cloudflare 网段时才允许优选直连）
        private static readonly (uint Network, uint Mask)[] OfficialCloudflareCidrs =
        [
            ParseCidr("173.245.48.0/20"),
            ParseCidr("103.21.244.0/22"),
            ParseCidr("103.22.200.0/22"),
            ParseCidr("103.31.4.0/22"),
            ParseCidr("141.101.64.0/18"),
            ParseCidr("108.162.192.0/18"),
            ParseCidr("190.93.240.0/20"),
            ParseCidr("188.114.96.0/20"),
            ParseCidr("197.234.240.0/22"),
            ParseCidr("198.41.128.0/17"),
            ParseCidr("162.158.0.0/15"),
            ParseCidr("104.16.0.0/13"),
            ParseCidr("104.24.0.0/14"),
            ParseCidr("172.64.0.0/13"),
            ParseCidr("131.0.72.0/22"),
        ];

        public static bool Enabled { get; set; } = false;
        public static string ManualIp { get; set; } = "";

        private static (uint Network, uint Mask) ParseCidr(string cidr)
        {
            var parts = cidr.Split('/');
            var bytes = IPAddress.Parse(parts[0]).GetAddressBytes();
            int prefix = int.Parse(parts[1]);
            uint ip = ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
            uint mask = prefix == 0 ? 0u : (0xFFFFFFFFu << (32 - prefix));
            return (ip & mask, mask);
        }

        public static bool IsCloudflareIp(IPAddress ip)
        {
            if (ip.AddressFamily != AddressFamily.InterNetwork) return false;
            var bytes = ip.GetAddressBytes();
            uint val = ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
            foreach (var (network, mask) in OfficialCloudflareCidrs)
            {
                if ((val & mask) == network) return true;
            }
            return false;
        }
        
        private static IPAddress? _optimalIp;
        private static long _optimalLatency = -1;
        private static readonly HashSet<string> _failedIps = [];
        private static readonly object _lock = new();
        private static Timer? _autoRefreshTimer;
        private static bool _isProbing = false;

        public static Action<string>? OnLog;

        public static IPAddress? OptimalIp
        {
            get
            {
                lock (_lock)
                {
                    return _optimalIp;
                }
            }
        }

        public static long OptimalLatency
        {
            get
            {
                lock (_lock)
                {
                    return _optimalLatency;
                }
            }
        }

        /// <summary>
        /// 启动优化器后台守护
        /// </summary>
        public static void Start()
        {
            // 立即在后台触发一次初始优选
            _ = Task.Run(() => RefreshAsync(silent: false));

            // 每 20 分钟定期巡检与刷新优选节点
            _autoRefreshTimer?.Dispose();
            _autoRefreshTimer = new Timer(_ =>
            {
                if (Enabled)
                {
                    _ = Task.Run(() => RefreshAsync(silent: true));
                }
            }, null, TimeSpan.FromMinutes(20), TimeSpan.FromMinutes(20));
        }

        /// <summary>
        /// 标记当前优选 IP 失效并触发秒级自愈重选
        /// </summary>
        public static void NotifyFailure(IPAddress ip)
        {
            lock (_lock)
            {
                _failedIps.Add(ip.ToString());
                if (_optimalIp != null && _optimalIp.Equals(ip))
                {
                    _optimalIp = null;
                    _optimalLatency = -1;
                }
            }

            OnLog?.Invoke($"[CF优选] 检测到当前节点 {ip} 响应异常，正在自动无缝切换备用优质节点...");
            _ = Task.Run(() => RefreshAsync(silent: false));
        }

        /// <summary>
        /// 多线程并发测速并锁定最优 IP
        /// </summary>
        public static async Task RefreshAsync(bool silent = false)
        {
            if (!Enabled) return;

            lock (_lock)
            {
                if (_isProbing) return;
                _isProbing = true;
            }

            try
            {
                // 1. 如果手动指定了固定优选 IP
                if (!string.IsNullOrWhiteSpace(ManualIp))
                {
                    var manualTarget = ManualIp.Trim();
                    var test = await ProbeSingleIpAsync(manualTarget, 2000);
                    if (test.HasValue)
                    {
                        lock (_lock)
                        {
                            _optimalIp = test.Value.Ip;
                            _optimalLatency = test.Value.Latency;
                        }
                        if (!silent) OnLog?.Invoke($"[CF优选] 已应用手动指定节点: {manualTarget} (延迟: {test.Value.Latency}ms)");
                        return;
                    }
                    else
                    {
                        OnLog?.Invoke($"[CF优选] 手动指定节点 {manualTarget} 无法连通，将自动从官方优质池中优选...");
                    }
                }

                // 2. 从官方候选池中并发测速
                List<string> pool;
                lock (_lock)
                {
                    pool = CandidateIps.Where(ip => !_failedIps.Contains(ip)).ToList();
                    if (pool.Count == 0)
                    {
                        // 如果所有节点都被标记过失败，重置失败记录
                        _failedIps.Clear();
                        pool = CandidateIps.ToList();
                    }
                }

                var tasks = pool.Select(ip => ProbeSingleIpAsync(ip, 1200)).ToList();
                var results = await Task.WhenAll(tasks);
                var validResults = results.Where(r => r.HasValue).Select(r => r!.Value).OrderBy(r => r.Latency).ToList();

                if (validResults.Count > 0)
                {
                    var best = validResults.First();
                    lock (_lock)
                    {
                        _optimalIp = best.Ip;
                        _optimalLatency = best.Latency;
                    }
                    if (!silent)
                    {
                        OnLog?.Invoke($"[CF优选] 已自动锁定最优 Cloudflare 节点: {best.Ip} (延迟: {best.Latency}ms)");
                    }
                }
                else
                {
                    lock (_lock)
                    {
                        _optimalIp = null;
                        _optimalLatency = -1;
                    }
                    if (!silent)
                    {
                        OnLog?.Invoke("[CF优选] 暂无可连通的优选节点，将自动降级为系统默认网络解析。");
                    }
                }
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"[CF优选] 测速过程异常: {ex.Message}");
            }
            finally
            {
                lock (_lock)
                {
                    _isProbing = false;
                }
            }
        }

        private static async Task<(IPAddress Ip, long Latency)?> ProbeSingleIpAsync(string ipStr, int timeoutMs)
        {
            if (!IPAddress.TryParse(ipStr, out var ip)) return null;

            var sw = Stopwatch.StartNew();
            using var socket = new Socket(SocketType.Stream, ProtocolType.Tcp)
            {
                NoDelay = true,
                SendTimeout = timeoutMs,
                ReceiveTimeout = timeoutMs
            };

            using var cts = new CancellationTokenSource(timeoutMs);
            try
            {
                await socket.ConnectAsync(new IPEndPoint(ip, 443), cts.Token);
                sw.Stop();
                return (ip, sw.ElapsedMilliseconds);
            }
            catch
            {
                return null;
            }
        }
    }
}
