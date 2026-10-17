using Microsoft.Data.Sqlite;
using System.Data;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace WeChatHook
{
    public class Message
    {
        public string ServerSequence { get; set; }
        public string SenderId { get; set; }
        public DateTimeOffset CreateTime { get; set; }
        public string MessageContent { get; set; }

        private static Regex patternNormal = new Regex("收款(到账)?(\\d+\\.\\d{2})元");
        private static Regex patternReward = new Regex("二维码赞赏到账(\\d+\\.\\d{2})元");

        public Message(IDataRecord record)
        {
            var server_seq = record["server_seq"].ToString();
            if (server_seq is null)
            {
                throw new ArgumentException("Record does not contain server_seq");
            }
            var create_time_unix = Convert.ToInt64(record["create_time"].ToString());
            DateTimeOffset unixEpoch = new DateTimeOffset(1970, 1, 1, 0, 0, 0, TimeSpan.Zero);
            DateTimeOffset create_time = unixEpoch.AddSeconds(create_time_unix).ToLocalTime();
            var sender_id = DecryptService.GetString(record, "sender_id");
            if (sender_id == string.Empty)
            {
                throw new ArgumentException("Record does not contain sender_id");
            }
            var message_content = DecryptService.GetString(record, "message_content");
            ServerSequence = server_seq;
            SenderId = sender_id;
            CreateTime = create_time;
            MessageContent = message_content;
        }

        public string? Money
        {
            get
            {
                var content = MessageContent;
                // 微信收款助手 消息
                if (SenderId == "gh_f0a92aa7146c" && content.Contains("<appname><![CDATA[微信收款助手]]></appname>"))
                {
                    // 同时满足 微信支付收款 和 店员消息 的格式
                    var match = patternNormal.Match(content);
                    if (match.Success)
                    {
                        return match.Groups[2].Value;
                    }

                }
                // 微信支付 消息
                if (SenderId == "gh_3dfda90e39d6" && content.Contains("<appname><![CDATA[微信支付]]></appname>"))
                {
                    // 二维码赞赏格式
                    var match = patternReward.Match(content);
                    if (match.Success)
                    {
                        return match.Groups[1].Value;
                    }
                    // 普通收款码 / 微信支付到账格式
                    var matchNormal = patternNormal.Match(content);
                    if (matchNormal.Success)
                    {
                        return matchNormal.Groups[2].Value;
                    }
                }
                return null;
            }
        }

        public override bool Equals(object? obj)
        {
            if (obj == null) return false;
            if (obj is not Message other) return false;

            return ServerSequence.Equals(other.ServerSequence) && SenderId.Equals(other.SenderId);
        }

        public override int GetHashCode()
        {
            return HashCode.Combine(ServerSequence, SenderId);
        }
    }
    public sealed class ScanResult
    {
        public List<Message> Messages { get; init; } = [];
        public bool HasPaymentAccount { get; init; }
    }

    public class DatabaseService
    {
        private static readonly string[] AllowSenders = ["gh_f0a92aa7146c", "gh_3dfda90e39d6"];
        public static int RecentMinutes = 15;

        public static async Task<ScanResult> Scan(string dbFile)
        {
            var connectionString = new SqliteConnectionStringBuilder
            {
                DataSource = dbFile,
                Mode = SqliteOpenMode.ReadOnly,
                Cache = SqliteCacheMode.Private,
                Pooling = false,
            }.ToString();
            await using var conn = new SqliteConnection(connectionString);
            await conn.OpenAsync();

            Dictionary<long, string> senders;
            try
            {
                senders = ReadPaymentSenders(conn);
            }
            catch (Exception e)
            {
                throw new Exception($"在读取数据库文件 {new FileInfo(dbFile).Name} 的 Name2Id 时出现异常", e);
            }
            if (senders.Count == 0)
                return new ScanResult();

            List<string> tables;
            try
            {
                tables = ChooseTables(conn, senders.Values);
            }
            catch (Exception e)
            {
                throw new Exception($"在读取数据库文件 {new FileInfo(dbFile).Name} 的所有数据表时出现异常", e);
            }

            var messages = new List<Message>();
            var timestamp = DateTimeOffset.UtcNow.AddMinutes(-RecentMinutes).ToUnixTimeSeconds();
            foreach (var tableName in tables)
            {
                if (!IsSafeIdentifier(tableName)) continue;
                try
                {
                    ReadTable(conn, tableName, senders.Keys, timestamp, messages);
                }
                catch (Exception e)
                {
                    throw new Exception($"在读取数据库文件 {new FileInfo(dbFile).Name} 的数据表 {tableName} 时出现异常", e);
                }
            }
            return new ScanResult { Messages = messages, HasPaymentAccount = true };
        }

        private static Dictionary<long, string> ReadPaymentSenders(SqliteConnection conn)
        {
            var senders = new Dictionary<long, string>();
            using var cmd = new SqliteCommand("SELECT rowid, user_name FROM Name2Id WHERE user_name IN ($a, $b)", conn);
            cmd.Parameters.AddWithValue("$a", AllowSenders[0]);
            cmd.Parameters.AddWithValue("$b", AllowSenders[1]);
            using var reader = cmd.ExecuteReader();
            foreach (var item in reader)
            {
                if (item is not IDataRecord record) continue;
                var name = DecryptService.GetString(record, "user_name");
                if (!AllowSenders.Contains(name)) continue;
                senders[Convert.ToInt64(record["rowid"])] = name;
            }
            return senders;
        }

        private static List<string> ChooseTables(SqliteConnection conn, IEnumerable<string> usernames)
        {
            var all = new List<string>();
            using (var cmd = new SqliteCommand("SELECT name FROM sqlite_master WHERE type='table'", conn))
            using (var reader = cmd.ExecuteReader())
            {
                foreach (var item in reader)
                {
                    if (item is not IDataRecord record) continue;
                    var name = record["name"]?.ToString() ?? "";
                    if (name.StartsWith("Msg_", StringComparison.OrdinalIgnoreCase)) all.Add(name);
                }
            }

            var preferred = new List<string>();
            var known = new HashSet<string>(all, StringComparer.OrdinalIgnoreCase);
            foreach (var username in usernames)
            {
                var md5 = Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(username))).ToLowerInvariant();
                var table = "Msg_" + md5;
                if (known.Contains(table)) preferred.Add(table);
            }
            return preferred.Count > 0 ? preferred : all;
        }

        private static void ReadTable(SqliteConnection conn, string tableName, ICollection<long> senderIds, long timestamp, List<Message> messages)
        {
            var names = new string[senderIds.Count];
            var index = 0;
            foreach (var id in senderIds)
            {
                names[index] = "$id" + index;
                index++;
            }
            using var cmd = new SqliteCommand(
                $"SELECT m.server_seq, m.create_time, m.message_content, n.user_name AS sender_id " +
                $"FROM \"{tableName}\" m " +
                $"LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid " +
                $"WHERE m.create_time > $ts AND m.real_sender_id IN ({string.Join(",", names)})", conn);
            cmd.Parameters.AddWithValue("$ts", timestamp);
            index = 0;
            foreach (var id in senderIds)
            {
                cmd.Parameters.AddWithValue(names[index], id);
                index++;
            }
            using var reader = cmd.ExecuteReader();
            foreach (var item in reader)
            {
                if (item is not IDataRecord record) continue;
                var senderId = DecryptService.GetString(record, "sender_id");
                if (!AllowSenders.Contains(senderId)) continue;
                try
                {
                    var message = new Message(record);
                    if (message.Money != null) messages.Add(message);
                }
                catch { }
            }
        }

        private static bool IsSafeIdentifier(string name) =>
            name.Length > 0 && name.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '_');
    }
}
