using System.Security.Cryptography;
using System.Text;

namespace WeChatHook
{
    internal enum SyncKind
    {
        Unchanged,
        Updated,
        Rebuilt,
        Incomplete,
        Failed,
    }

    internal sealed class SyncOutcome
    {
        public SyncKind Kind { get; init; }
        public string ReplicaPath { get; init; } = "";
        public string Error { get; init; } = "";
    }

    /// <summary>
    /// 在本地保留一份明文副本。主库只在文件时间或长度变化时按页补差，
    /// 新消息只解密 WAL 里新增的帧。不向微信的库执行 checkpoint，也不以写方式打开它。
    /// </summary>
    internal static class ReplicaStore
    {
        private const int WalHeaderSize = 32;
        private const int FrameHeaderSize = 24;
        private const uint WalMagicLe = 0x377f0682;
        private const uint WalMagicBe = 0x377f0683;
        private const int MaxPage = 2_000_000;

        private static readonly object Gate = new();
        private static readonly Dictionary<string, Slot> Slots = new(StringComparer.OrdinalIgnoreCase);

        internal static string CacheRoot => Path.Combine(Environment.CurrentDirectory, ".cache", "wechat-db");

        internal static void Reset()
        {
            lock (Gate) Slots.Clear();
            try
            {
                if (Directory.Exists(CacheRoot)) Directory.Delete(CacheRoot, true);
            }
            catch
            {
                // 下次同步会因为密钥指纹不符而重建副本。
            }
        }

        internal static SyncOutcome Sync(string hexKey, string dbPath)
        {
            try
            {
                return SyncCore(hexKey, dbPath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or CryptographicException or ArgumentException)
            {
                return new SyncOutcome { Kind = SyncKind.Failed, Error = ex.Message };
            }
        }

        private static SyncOutcome SyncCore(string hexKey, string dbPath)
        {
            var full = Path.GetFullPath(dbPath);
            var dbInfo = new FileInfo(full);
            if (!dbInfo.Exists) return new SyncOutcome { Kind = SyncKind.Failed, Error = "数据库文件不存在" };

            var walPath = full + "-wal";
            long walLength = 0;
            long walTicks = 0;
            if (File.Exists(walPath))
            {
                var walInfo = new FileInfo(walPath);
                walLength = walInfo.Length;
                walTicks = walInfo.LastWriteTimeUtc.Ticks;
            }

            var slot = GetSlot(full);
            lock (slot)
            {
            var fingerprint = Fingerprint(hexKey);
            bool metaSame = slot.Ready
                && slot.DbLength == dbInfo.Length
                && slot.DbTicks == dbInfo.LastWriteTimeUtc.Ticks
                && slot.WalLength == walLength
                && slot.WalTicks == walTicks
                && fingerprint.AsSpan().SequenceEqual(slot.KeyPrint)
                && File.Exists(slot.ReplicaPath);

            if (metaSame && !slot.Force)
                return new SyncOutcome { Kind = SyncKind.Unchanged, ReplicaPath = slot.ReplicaPath };

            bool rebuilt = false;
            bool dbTouched = !slot.Ready
                || slot.DbLength != dbInfo.Length
                || slot.DbTicks != dbInfo.LastWriteTimeUtc.Ticks
                || !fingerprint.AsSpan().SequenceEqual(slot.KeyPrint)
                || !File.Exists(slot.ReplicaPath);
            // WAL 换代说明微信做过 checkpoint，主库页可能已变，不能只补帧。
            if (!dbTouched && walLength >= WalHeaderSize && TryReadWalSalt(walPath, out uint liveSalt1, out uint liveSalt2)
                && (slot.WalSalt1 != liveSalt1 || slot.WalSalt2 != liveSalt2))
            {
                dbTouched = true;
            }

            if (dbTouched)
            {
                var encrypted = DecryptService.ReadFileShared(full);
                if (encrypted.Length < DecryptService.PageSize)
                    return new SyncOutcome { Kind = SyncKind.Failed, Error = "数据库文件过小" };

                var salt = new byte[DecryptService.SaltSize];
                Buffer.BlockCopy(encrypted, 0, salt, 0, salt.Length);
                var keys = DecryptService.GetKeys(hexKey, salt);
                var pageCount = (encrypted.Length + DecryptService.PageSize - 1) / DecryptService.PageSize;
                bool saltChanged = slot.Salt.Length != salt.Length || !salt.AsSpan().SequenceEqual(slot.Salt);
                bool keyChanged = !fingerprint.AsSpan().SequenceEqual(slot.KeyPrint);
                if (!slot.Ready || saltChanged || keyChanged || !File.Exists(slot.ReplicaPath))
                {
                    if (!Rebuild(encrypted, keys, pageCount, slot))
                    {
                        slot.Force = true;
                        return new SyncOutcome { Kind = SyncKind.Incomplete, Error = "页面校验失败，可能密钥不对或微信正在写入" };
                    }
                    rebuilt = true;
                }
                else if (!Patch(encrypted, keys, pageCount, slot))
                {
                    slot.Force = true;
                    return new SyncOutcome { Kind = SyncKind.Incomplete, Error = "主库页面不完整，等待微信写完后重试" };
                }

                slot.Salt = salt;
                slot.KeyPrint = fingerprint;
                slot.DbLength = dbInfo.Length;
                slot.DbTicks = dbInfo.LastWriteTimeUtc.Ticks;
                // 主库副本刚按当前文件重写过，WAL 从这一代的第一帧重新铺上去。
                slot.WalFrames = 0;
            }

            var walChanged = false;
            if (walLength > 0)
            {
                var wal = ReadWal(walPath);
                if (wal.Torn)
                {
                    slot.Force = true;
                    return new SyncOutcome { Kind = SyncKind.Incomplete, ReplicaPath = slot.ReplicaPath, Error = "WAL 尚未写完" };
                }

                var keys = DecryptService.GetKeys(hexKey, slot.Salt);
                bool generationChanged = slot.WalSalt1 != wal.Salt1 || slot.WalSalt2 != wal.Salt2;
                int start = generationChanged ? 0 : slot.WalFrames;
                if (!ApplyFrames(slot.ReplicaPath, keys, wal.Frames, start))
                {
                    slot.Force = true;
                    return new SyncOutcome { Kind = SyncKind.Incomplete, ReplicaPath = slot.ReplicaPath, Error = "WAL 帧校验失败" };
                }
                walChanged = generationChanged || wal.Frames.Count != slot.WalFrames;
                slot.WalSalt1 = wal.Salt1;
                slot.WalSalt2 = wal.Salt2;
                slot.WalFrames = wal.Frames.Count;
            }
            else if (slot.WalFrames != 0 || slot.WalLength != 0)
            {
                walChanged = true;
                slot.WalSalt1 = 0;
                slot.WalSalt2 = 0;
                slot.WalFrames = 0;
            }

            slot.WalLength = walLength;
            slot.WalTicks = walTicks;
            slot.Force = false;
            slot.Ready = true;
            Save(slot);

            var kind = rebuilt ? SyncKind.Rebuilt : (walChanged || dbTouched ? SyncKind.Updated : SyncKind.Unchanged);
            return new SyncOutcome { Kind = kind, ReplicaPath = slot.ReplicaPath };
            }
        }

        private static bool TryReadWalSalt(string walPath, out uint salt1, out uint salt2)
        {
            salt1 = 0;
            salt2 = 0;
            using var stream = OpenShared(walPath);
            var header = new byte[WalHeaderSize];
            if (ReadFull(stream, header) != WalHeaderSize) return false;
            uint magic = ReadBe(header, 0);
            if (magic != WalMagicLe && magic != WalMagicBe) return false;
            salt1 = ReadBe(header, 16);
            salt2 = ReadBe(header, 20);
            return true;
        }

        private static bool Rebuild(byte[] encrypted, DecryptService.DerivedKeys keys, int pageCount, Slot slot)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(slot.ReplicaPath)!);
            var building = slot.ReplicaPath + ".building";
            var hashes = new List<byte[]>(pageCount);
            using (var output = new FileStream(building, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                for (int pageNum = 0; pageNum < pageCount; pageNum++)
                {
                    var page = SlicePage(encrypted, pageNum);
                    var plain = DecryptService.MaterializePage(page, keys, pageNum, skipHmacValidation: false);
                    if (plain == null)
                    {
                        output.Dispose();
                        TryDelete(building);
                        return false;
                    }
                    output.Write(plain, 0, plain.Length);
                    hashes.Add(SHA256.HashData(page));
                }
            }
            File.Move(building, slot.ReplicaPath, overwrite: true);
            slot.PageHashes = hashes;
            return true;
        }

        private static bool Patch(byte[] encrypted, DecryptService.DerivedKeys keys, int pageCount, Slot slot)
        {
            var dirty = new List<(int PageNum, byte[] Page, byte[] Hash)>();
            for (int pageNum = 0; pageNum < pageCount; pageNum++)
            {
                var page = SlicePage(encrypted, pageNum);
                var hash = SHA256.HashData(page);
                if (pageNum < slot.PageHashes.Count && HashEquals(slot.PageHashes[pageNum], hash)) continue;
                dirty.Add((pageNum, page, hash));
            }

            using var replica = new FileStream(slot.ReplicaPath, FileMode.Open, FileAccess.ReadWrite, FileShare.Read | FileShare.Delete);
            replica.SetLength((long)pageCount * DecryptService.PageSize);
            foreach (var item in dirty)
            {
                var plain = DecryptService.MaterializePage(item.Page, keys, item.PageNum, skipHmacValidation: false);
                if (plain == null) return false;
                replica.Position = (long)item.PageNum * DecryptService.PageSize;
                replica.Write(plain, 0, plain.Length);
            }

            if (slot.PageHashes.Count > pageCount) slot.PageHashes.RemoveRange(pageCount, slot.PageHashes.Count - pageCount);
            foreach (var item in dirty)
            {
                while (slot.PageHashes.Count <= item.PageNum) slot.PageHashes.Add(Array.Empty<byte>());
                slot.PageHashes[item.PageNum] = item.Hash;
            }
            return true;
        }

        private static bool ApplyFrames(string replicaPath, DecryptService.DerivedKeys keys, List<(int Pgno, byte[] Page)> frames, int start)
        {
            if (start >= frames.Count) return true;
            using var replica = new FileStream(replicaPath, FileMode.Open, FileAccess.ReadWrite, FileShare.Read | FileShare.Delete);
            for (int i = Math.Max(0, start); i < frames.Count; i++)
            {
                var (pgno, page) = frames[i];
                var plain = DecryptService.MaterializePage(page, keys, pgno - 1, skipHmacValidation: false);
                if (plain == null) return false;
                long offset = (long)(pgno - 1) * DecryptService.PageSize;
                if (replica.Length < offset + DecryptService.PageSize) replica.SetLength(offset + DecryptService.PageSize);
                replica.Position = offset;
                replica.Write(plain, 0, plain.Length);
            }
            return true;
        }

        private readonly struct WalRead
        {
            public uint Salt1 { get; init; }
            public uint Salt2 { get; init; }
            public List<(int Pgno, byte[] Page)> Frames { get; init; }
            public bool Torn { get; init; }
        }

        private static WalRead ReadWal(string walPath)
        {
            using var stream = OpenShared(walPath);
            var header = new byte[WalHeaderSize];
            if (ReadFull(stream, header) != WalHeaderSize)
                return new WalRead { Frames = [], Torn = true };

            uint magic = ReadBe(header, 0);
            uint pageSize = ReadBe(header, 8);
            if ((magic != WalMagicLe && magic != WalMagicBe) || pageSize != DecryptService.PageSize)
                return new WalRead { Frames = [], Torn = true };

            uint salt1 = ReadBe(header, 16);
            uint salt2 = ReadBe(header, 20);
            var frames = new List<(int, byte[])>();
            var frameHeader = new byte[FrameHeaderSize];
            while (stream.Position < stream.Length)
            {
                long remaining = stream.Length - stream.Position;
                if (remaining < FrameHeaderSize) return new WalRead { Salt1 = salt1, Salt2 = salt2, Frames = frames, Torn = true };
                if (ReadFull(stream, frameHeader) != FrameHeaderSize)
                    return new WalRead { Salt1 = salt1, Salt2 = salt2, Frames = frames, Torn = true };

                uint pgno = ReadBe(frameHeader, 0);
                uint frameSalt1 = ReadBe(frameHeader, 8);
                uint frameSalt2 = ReadBe(frameHeader, 12);
                if (pgno == 0 || frameSalt1 != salt1 || frameSalt2 != salt2) break;
                if (pgno > MaxPage) break;
                if (stream.Length - stream.Position < DecryptService.PageSize)
                    return new WalRead { Salt1 = salt1, Salt2 = salt2, Frames = frames, Torn = true };

                var page = new byte[DecryptService.PageSize];
                if (ReadFull(stream, page) != DecryptService.PageSize)
                    return new WalRead { Salt1 = salt1, Salt2 = salt2, Frames = frames, Torn = true };
                frames.Add(((int)pgno, page));
            }
            return new WalRead { Salt1 = salt1, Salt2 = salt2, Frames = frames };
        }

        private static byte[] SlicePage(byte[] encrypted, int pageNum)
        {
            var page = new byte[DecryptService.PageSize];
            int start = pageNum * DecryptService.PageSize;
            int count = Math.Min(DecryptService.PageSize, encrypted.Length - start);
            if (count > 0) Buffer.BlockCopy(encrypted, start, page, 0, count);
            return page;
        }

        private static Slot GetSlot(string fullPath)
        {
            lock (Gate)
            {
                if (Slots.TryGetValue(fullPath, out var existing)) return existing;
                var dir = SlotDir(fullPath);
                var slot = new Slot
                {
                    DbPath = fullPath,
                    ReplicaPath = Path.Combine(dir, "replica.db"),
                    StatePath = Path.Combine(dir, "state.bin"),
                };
                Load(slot);
                Slots[fullPath] = slot;
                return slot;
            }
        }

        private static string SlotDir(string fullPath)
        {
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(fullPath.ToLowerInvariant())))[..16];
            var name = Path.GetFileName(fullPath);
            foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return Path.Combine(CacheRoot, name + "-" + hash);
        }

        private static byte[] Fingerprint(string hexKey)
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(hexKey));
            var print = new byte[8];
            Buffer.BlockCopy(hash, 0, print, 0, print.Length);
            return print;
        }

        private static void Load(Slot slot)
        {
            if (!File.Exists(slot.StatePath) || !File.Exists(slot.ReplicaPath)) return;
            try
            {
                using var stream = File.OpenRead(slot.StatePath);
                using var reader = new BinaryReader(stream);
                var magic = reader.ReadBytes(4);
                if (magic.Length != 4 || magic[0] != (byte)'W' || magic[1] != (byte)'X' || magic[2] != (byte)'R' || magic[3] != (byte)'2')
                    return;
                var salt = reader.ReadBytes(DecryptService.SaltSize);
                var print = reader.ReadBytes(8);
                long dbLength = reader.ReadInt64();
                long dbTicks = reader.ReadInt64();
                long walLength = reader.ReadInt64();
                long walTicks = reader.ReadInt64();
                uint walSalt1 = reader.ReadUInt32();
                uint walSalt2 = reader.ReadUInt32();
                int walFrames = reader.ReadInt32();
                int pageCount = reader.ReadInt32();
                if (salt.Length != DecryptService.SaltSize || print.Length != 8 || pageCount < 0 || pageCount > MaxPage)
                    return;
                var hashes = new List<byte[]>(pageCount);
                for (int i = 0; i < pageCount; i++)
                {
                    var hash = reader.ReadBytes(32);
                    if (hash.Length != 32) return;
                    hashes.Add(hash);
                }
                if (new FileInfo(slot.ReplicaPath).Length < (long)pageCount * DecryptService.PageSize) return;
                slot.Salt = salt;
                slot.KeyPrint = print;
                slot.DbLength = dbLength;
                slot.DbTicks = dbTicks;
                slot.WalLength = walLength;
                slot.WalTicks = walTicks;
                slot.WalSalt1 = walSalt1;
                slot.WalSalt2 = walSalt2;
                slot.WalFrames = walFrames;
                slot.PageHashes = hashes;
                slot.Ready = true;
            }
            catch
            {
                slot.Ready = false;
            }
        }

        private static void Save(Slot slot)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(slot.StatePath)!);
            var temp = slot.StatePath + ".tmp";
            using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            using (var writer = new BinaryWriter(stream))
            {
                writer.Write(new byte[] { (byte)'W', (byte)'X', (byte)'R', (byte)'2' });
                writer.Write(slot.Salt);
                writer.Write(slot.KeyPrint);
                writer.Write(slot.DbLength);
                writer.Write(slot.DbTicks);
                writer.Write(slot.WalLength);
                writer.Write(slot.WalTicks);
                writer.Write(slot.WalSalt1);
                writer.Write(slot.WalSalt2);
                writer.Write(slot.WalFrames);
                writer.Write(slot.PageHashes.Count);
                foreach (var hash in slot.PageHashes)
                {
                    if (hash.Length == 32) writer.Write(hash);
                    else writer.Write(new byte[32]);
                }
            }
            File.Move(temp, slot.StatePath, overwrite: true);
        }

        private static FileStream OpenShared(string path) =>
            new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);

        private static int ReadFull(Stream stream, byte[] buffer)
        {
            int offset = 0;
            while (offset < buffer.Length)
            {
                int read = stream.Read(buffer, offset, buffer.Length - offset);
                if (read == 0) return offset;
                offset += read;
            }
            return offset;
        }

        private static uint ReadBe(byte[] buffer, int offset) =>
            ((uint)buffer[offset] << 24) | ((uint)buffer[offset + 1] << 16) | ((uint)buffer[offset + 2] << 8) | buffer[offset + 3];

        private static bool HashEquals(byte[] left, byte[] right) =>
            left.Length == right.Length && left.AsSpan().SequenceEqual(right);

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        private sealed class Slot
        {
            public string DbPath = "";
            public string ReplicaPath = "";
            public string StatePath = "";
            public byte[] Salt = [];
            public byte[] KeyPrint = [];
            public long DbLength;
            public long DbTicks;
            public long WalLength;
            public long WalTicks;
            public uint WalSalt1;
            public uint WalSalt2;
            public int WalFrames;
            public List<byte[]> PageHashes = [];
            public bool Ready;
            public bool Force;
        }
    }
}
