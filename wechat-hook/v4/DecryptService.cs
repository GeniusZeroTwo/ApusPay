using System.Collections.Concurrent;
using System.Data;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace WeChatHook
{
    /// <summary>
    /// <para>转译自 EchoTrace</para>
    /// 
    /// <para>https://github.com/ycccccccy/echotrace/blob/main/lib/services/decrypt_service.dart</para> 
    /// <para>https://github.com/ycccccccy/echotrace/blob/main/lib/models/message.dart</para> 
    /// </summary>
    public class DecryptService
    {
        // 微信 4.x 版本常量
        public const int PageSize = 4096;
        public const int IterCount = 256000;
        public const int HmacSize = 64;
        public const int SaltSize = 16;
        public const int IvSize = 16;
        public const int KeySize = 32;
        public const int ReserveSize = 80;
        public static readonly byte[] SqliteHeader = {
            83, 81, 76, 105, 116, 101, 32, 102,
            111, 114, 109, 97, 116, 32, 51, 0
        }; // "SQLite format 3\x00" 的字节表示
        private static readonly ZstdNet.Decompressor Zstd = new ZstdNet.Decompressor();
        private static readonly ConcurrentDictionary<string, DerivedKeys> KeyCache = new();

        internal readonly struct DerivedKeys
        {
            public byte[] EncKey { get; init; }
            public byte[] MacKey { get; init; }
        }

        private DecryptService() { }

        internal static void ClearKeyCache() => KeyCache.Clear();

        /// <summary>
        /// PBKDF2-SHA512 256000 次只跟盐有关。同一个库的盐不变，派生结果可以一直复用。
        /// </summary>
        internal static DerivedKeys GetKeys(string hexKey, byte[] salt)
        {
            var cacheKey = hexKey + ":" + Convert.ToHexString(salt);
            return KeyCache.GetOrAdd(cacheKey, _ =>
            {
                var key = HexToBytes(hexKey);
                if (key.Length != KeySize)
                    throw new ArgumentException("密钥必须为64字符（32字节）的16进制字符串", nameof(hexKey));
                var encKey = DeriveEncryptionKey(key, salt);
                return new DerivedKeys
                {
                    EncKey = encKey,
                    MacKey = DeriveMacKey(encKey, salt),
                };
            });
        }

        /// <summary>
        /// 把一页密文还原成 4096 字节明文页。HMAC 失败返回 null，调用方保留旧页并稍后重试。
        /// </summary>
        internal static byte[]? MaterializePage(byte[] page, DerivedKeys keys, int pageNum, bool skipHmacValidation)
        {
            if (IsAllZeros(page)) return new byte[PageSize];
            try
            {
                var segment = DecryptPage(page, keys.EncKey, keys.MacKey, pageNum, skipHmacValidation);
                if (pageNum != 0) return segment.Length == PageSize ? segment : FitPage(segment);
                var full = new byte[PageSize];
                Buffer.BlockCopy(SqliteHeader, 0, full, 0, SqliteHeader.Length);
                Buffer.BlockCopy(segment, 0, full, SqliteHeader.Length, Math.Min(segment.Length, PageSize - SqliteHeader.Length));
                return full;
            }
            catch (CryptographicException)
            {
                return null;
            }
        }

        internal static byte[] ReadFileShared(string filePath) => ReadFileBytesSafely(filePath);

        private static byte[] FitPage(byte[] segment)
        {
            var padded = new byte[PageSize];
            Buffer.BlockCopy(segment, 0, padded, 0, Math.Min(segment.Length, PageSize));
            return padded;
        }

        public static bool ValidateKey(string dbPath, string hexKey)
        {
            try
            {
                var key = HexToBytes(hexKey);
                if (key.Length != KeySize) return false;

                var file = new FileInfo(dbPath);
                if (!file.Exists) return false;

                var firstPage = ReadPage(file, 0);
                if (IsAlreadyDecrypted(firstPage)) return false;

                var salt = new byte[SaltSize];
                Array.Copy(firstPage, 0, salt, 0, SaltSize);
                var keys = GetKeys(hexKey, salt);
                return ValidatePageHmac(firstPage, keys.MacKey, 0);
            }
            catch
            {
                return false;
            }
        }

        public static void DecryptDatabase(
            string hexKey,
            string dbPath,
            string outputPath,
            bool skipHmacValidation = true)
        {
            var key = HexToBytes(hexKey);
            if (key.Length != KeySize)
                throw new ArgumentException("密钥必须为64字符（32字节）的16进制字符串", nameof(hexKey));

            var inputFile = new FileInfo(dbPath);
            if (!inputFile.Exists)
                throw new FileNotFoundException("加密数据库文件不存在", dbPath);

            var directory = new FileInfo(outputPath).Directory;
            if (directory?.Exists == false)
                directory.Create();

            using (var outputStream = new FileStream(outputPath, FileMode.Create, FileAccess.Write))
            {
                byte[] encryptedData = ReadFileBytesSafely(dbPath);
                var totalPages = (int)Math.Ceiling((double)encryptedData.Length / PageSize);
                var salt = new byte[SaltSize];
                Array.Copy(encryptedData, 0, salt, 0, SaltSize);
                var keys = GetKeys(hexKey, salt);

                for (int pageNum = 0; pageNum < totalPages; pageNum++)
                {
                    var plain = MaterializePage(ExtractPage(encryptedData, pageNum), keys, pageNum, skipHmacValidation);
                    if (plain == null)
                        throw new CryptographicException($"页面 {pageNum} HMAC 验证失败（数据篡改或密钥错误）");
                    outputStream.Write(plain, 0, plain.Length);
                }
            }
        }

        public static string GetString(IDataRecord record, string name)
        {
            var obj = record[name];
            if (obj is string v1) return RemoveInvalidUTF16(v1);

            if (obj is byte[] v2) return DecodeBinaryContent(v2);

            return RemoveInvalidUTF16(obj?.ToString() ?? "");
        }

        private static byte[] ExtractPage(byte[] encryptedData, int pageNum)
        {
            var start = pageNum * PageSize;
            var end = Math.Min(start + PageSize, encryptedData.Length);
            var page = new byte[PageSize];

            Array.Copy(encryptedData, start, page, 0, end - start);
            return page;
        }

        private static byte[] DecryptPage(
            byte[] page,
            byte[] encKey,
            byte[] macKey,
            int pageNum,
            bool skipHmacValidation)
        {
            var offset = pageNum == 0 ? SaltSize : 0;

            var shouldValidate = pageNum == 0 || !skipHmacValidation;
            if (shouldValidate && !ValidatePageHmac(page, macKey, pageNum))
                throw new CryptographicException($"页面 {pageNum} HMAC 验证失败（数据篡改或密钥错误）");

            var ivStart = PageSize - ReserveSize;
            var iv = new byte[IvSize];
            Array.Copy(page, ivStart, iv, 0, IvSize);

            var encryptedDataLength = PageSize - ReserveSize - offset;
            var encryptedData = new byte[encryptedDataLength];
            Array.Copy(page, offset, encryptedData, 0, encryptedDataLength);

            var decryptedData = AesCbcDecrypt(encryptedData, encKey, iv);

            var reserveData = new byte[ReserveSize];
            Array.Copy(page, ivStart, reserveData, 0, ReserveSize);

            var result = new byte[decryptedData.Length + reserveData.Length];
            Array.Copy(decryptedData, 0, result, 0, decryptedData.Length);
            Array.Copy(reserveData, 0, result, decryptedData.Length, reserveData.Length);

            return result;
        }

        private static byte[] AesCbcDecrypt(byte[] encryptedData, byte[] key, byte[] iv)
        {
            using (var aes = Aes.Create())
            {
                aes.KeySize = KeySize * 8;
                aes.Mode = CipherMode.CBC;
                aes.Padding = PaddingMode.None;
                aes.Key = key;
                aes.IV = iv;

                using (var decryptor = aes.CreateDecryptor())
                using (var ms = new MemoryStream())
                using (var cs = new CryptoStream(ms, decryptor, CryptoStreamMode.Write))
                {
                    cs.Write(encryptedData, 0, encryptedData.Length);
                    cs.FlushFinalBlock();
                    return ms.ToArray();
                }
            }
        }

        private static byte[] DeriveEncryptionKey(byte[] masterKey, byte[] salt)
        {
            using (var pbkdf2 = new Rfc2898DeriveBytes(
                masterKey,
                salt,
                IterCount,
                HashAlgorithmName.SHA512))
            {
                return pbkdf2.GetBytes(KeySize);
            }
        }

        private static byte[] DeriveMacKey(byte[] encKey, byte[] salt)
        {
            var macSalt = new byte[salt.Length];
            for (int i = 0; i < salt.Length; i++)
                macSalt[i] = (byte)(salt[i] ^ 0x3a);

            using (var pbkdf2 = new Rfc2898DeriveBytes(
                encKey,
                macSalt,
                iterations: 2,
                HashAlgorithmName.SHA512))
            {
                return pbkdf2.GetBytes(KeySize);
            }
        }

        private static bool ValidatePageHmac(byte[] page, byte[] macKey, int pageNum)
        {
            var offset = pageNum == 0 ? SaltSize : 0;
            var dataEnd = PageSize - ReserveSize + IvSize;

            var pageNoBytes = BitConverter.GetBytes(pageNum + 1);
            if (!BitConverter.IsLittleEndian)
                Array.Reverse(pageNoBytes);

            var message = new List<byte>();
            message.AddRange(page.AsSpan(offset, dataEnd - offset).ToArray());
            message.AddRange(pageNoBytes);

            using (var hmac = new HMACSHA512(macKey))
            {
                var calculatedMac = hmac.ComputeHash(message.ToArray());
                var storedMac = new byte[HmacSize];
                Array.Copy(page, dataEnd, storedMac, 0, HmacSize);

                return CryptographicOperations.FixedTimeEquals(calculatedMac, storedMac);
            }
        }

        private static byte[] ReadFileBytesSafely(string filePath, int maxRetries = 3, int delayMs = 60)
        {
            for (int attempt = 0; attempt < maxRetries; attempt++)
            {
                try
                {
                    using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    using var memoryStream = new MemoryStream((int)Math.Min(fs.Length, 1024 * 1024 * 128));
                    fs.CopyTo(memoryStream);
                    return memoryStream.ToArray();
                }
                catch (IOException) when (attempt < maxRetries - 1)
                {
                    Thread.Sleep(delayMs * (attempt + 1));
                }
            }
            throw new IOException($"无法安全读取微信数据库文件，可能处于高并发写入锁定中: {filePath}");
        }

        private static byte[] ReadPage(FileInfo file, int pageNum)
        {
            using (var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var page = new byte[PageSize];
                var position = pageNum * (long)PageSize;
                stream.Position = position;

                var bytesRead = stream.Read(page, 0, PageSize);
                if (bytesRead < PageSize)
                    Array.Fill(page, (byte)0, bytesRead, PageSize - bytesRead);

                return page;
            }
        }

        private static bool IsAlreadyDecrypted(byte[] firstPage)
        {
            if (firstPage.Length < SqliteHeader.Length) return false;
            for (int i = 0; i < SqliteHeader.Length - 1; i++)
                if (firstPage[i] != SqliteHeader[i]) return false;
            return true;
        }

        private static bool IsAllZeros(byte[] bytes)
        {
            foreach (var b in bytes)
                if (b != 0) return false;
            return true;
        }

        private static byte[] HexToBytes(string hex)
        {
            if (hex.Length % 2 != 0)
                throw new ArgumentException("16进制字符串长度必须为偶数", nameof(hex));

            var bytes = new byte[hex.Length / 2];
            for (int i = 0; i < hex.Length; i += 2)
                bytes[i / 2] = Convert.ToByte(hex.Substring(i, 2), 16);

            return bytes;
        }

        private static string DecodeBinaryContent(byte[] data)
        {
            if (data == null || data.Length == 0)
                return string.Empty;

            try
            {
                if (data.Length >= 4)
                {
                    uint magic = (uint)((data[3] << 24) | (data[2] << 16) | (data[1] << 8) | data[0]);
                    if (magic == 0x28B52FFD || magic == 0xFD2FB528)
                    {
                        try
                        {
                            byte[] decompressed = Zstd.Unwrap(data);
                            return DecodeUtf8AllowMalformed(decompressed);
                        }
                        catch { }
                    }
                }

                string directResult = DecodeUtf8AllowMalformed(data);
                int replacementCount = directResult.Split('\uFFFD').Length - 1;
                if (replacementCount < directResult.Length * 0.2)
                {
                    return directResult.Replace("\uFFFD", string.Empty);
                }

                return Encoding.GetEncoding("ISO-8859-1").GetString(data);
            }
            catch
            {
                return "[解码失败]";
            }
        }
        private static string DecodeUtf8AllowMalformed(byte[] data)
        {
            Encoding utf8 = new UTF8Encoding(
                encoderShouldEmitUTF8Identifier: false,
                throwOnInvalidBytes: false
            );
            return utf8.GetString(data);
        }

        private static string RemoveInvalidUTF16(string input)
        {
            if (string.IsNullOrEmpty(input))
                return input;

            try
            {
                string cleaned = Regex.Replace(input, @"[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]", string.Empty);

                char[] codeUnits = cleaned.ToCharArray();
                List<char> validUnits = new List<char>();

                for (int i = 0; i < codeUnits.Length; i++)
                {
                    char unit = codeUnits[i];
                    if (char.IsHighSurrogate(unit))
                    {
                        if (i + 1 < codeUnits.Length && char.IsLowSurrogate(codeUnits[i + 1]))
                        {
                            validUnits.Add(unit);
                            validUnits.Add(codeUnits[i + 1]);
                            i++;
                            continue;
                        }
                        continue;
                    }

                    if (char.IsLowSurrogate(unit)) continue;
                    validUnits.Add(unit);
                }
                return new string(validUnits.ToArray());
            }
            catch
            {
                return Regex.Replace(input, @"[^\u0020-\u007E\u4E00-\u9FFF\u3000-\u303F]", string.Empty);
            }
        }
    }
}
