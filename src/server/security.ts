import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPair,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { AppError } from "./errors";

const generateKeyPairAsync = promisify(generateKeyPair);

const OMIT_FROM_SIGNATURE = new Set(["sign", "sign_type"]);

export function canonicalize(parameters: Record<string, unknown>) {
  return Object.entries(parameters)
    .filter(([key, value]) => {
      if (OMIT_FROM_SIGNATURE.has(key)) return false;
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value) || value instanceof Uint8Array) return false;
      return typeof value !== "object";
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}

export function md5Sign(parameters: Record<string, unknown>, key: string) {
  return createHash("md5").update(`${canonicalize(parameters)}${key}`, "utf8").digest("hex");
}

export function secureEqual(valueA: string, valueB: string) {
  const a = Buffer.from(valueA);
  const b = Buffer.from(valueB);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyMd5(parameters: Record<string, unknown>, key: string) {
  const actual = typeof parameters.sign === "string" ? parameters.sign.toLowerCase() : "";
  return actual.length === 32 && secureEqual(actual, md5Sign(parameters, key));
}

export type PemKind = "private" | "public";

export function normalizePem(value: string, kind: PemKind) {
  const clean = value.trim().replace(/\r/g, "");
  if (clean.includes("-----BEGIN")) return `${clean}\n`;
  const body = clean.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? clean;
  const label = kind === "private" ? "PRIVATE KEY" : "PUBLIC KEY";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export interface RsaKeyPair {
  privateKey: string;
  publicKey: string;
}

const MAX_KEY_CACHE_SIZE = 64;
const privateKeyCache = new Map<string, KeyObject>();
const publicKeyCache = new Map<string, KeyObject>();

export function getCachedPrivateKey(value: string): KeyObject {
  const pem = normalizePem(value, "private");
  const hit = privateKeyCache.get(pem);
  if (hit) return hit;
  const parsed = createPrivateKey(pem);
  if (privateKeyCache.size >= MAX_KEY_CACHE_SIZE) {
    const oldest = privateKeyCache.keys().next().value;
    if (oldest !== undefined) privateKeyCache.delete(oldest);
  }
  privateKeyCache.set(pem, parsed);
  return parsed;
}

export function getCachedPublicKey(value: string): KeyObject {
  const clean = value.trim().replace(/\r/g, "");
  const pem = clean.includes("-----BEGIN CERTIFICATE-----") ? `${clean}\n` : normalizePem(clean, "public");
  const hit = publicKeyCache.get(pem);
  if (hit) return hit;
  const parsed = createPublicKey(pem);
  if (publicKeyCache.size >= MAX_KEY_CACHE_SIZE) {
    const oldest = publicKeyCache.keys().next().value;
    if (oldest !== undefined) publicKeyCache.delete(oldest);
  }
  publicKeyCache.set(pem, parsed);
  return parsed;
}

export function generateRsaKeyPair(): RsaKeyPair {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

export async function generateRsaKeyPairAsync(): Promise<RsaKeyPair> {
  const pair = await generateKeyPairAsync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

export function rsaSign(parameters: Record<string, unknown>, privateKey: string) {
  const signer = createSign("RSA-SHA256");
  signer.update(canonicalize(parameters), "utf8");
  signer.end();
  return signer.sign({ key: getCachedPrivateKey(privateKey), padding: 1 }, "base64");
}

export function rsaVerify(parameters: Record<string, unknown>, publicKey: string) {
  if (typeof parameters.sign !== "string" || !parameters.sign) return false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(canonicalize(parameters), "utf8");
    verifier.end();
    return verifier.verify(
      { key: getCachedPublicKey(publicKey), padding: 1 },
      parameters.sign,
      "base64",
    );
  } catch {
    return false;
  }
}

export function validatePrivateKey(value: string) {
  getCachedPrivateKey(value);
}

export function validatePublicKey(value: string) {
  getCachedPublicKey(value);
}

export function toPkcs8PrivateKey(value: string) {
  return getCachedPrivateKey(value).export({ type: "pkcs8", format: "pem" }).toString();
}

export function toSpkiPublicKey(value: string) {
  return getCachedPublicKey(value).export({ type: "spki", format: "pem" }).toString();
}

export function encryptSecret(plaintext: string, masterKey: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(envelope: string, masterKey: Buffer) {
  if (!envelope) return "";
  const [version, rawIv, rawTag, rawCiphertext] = envelope.split(".");
  if (version !== "v1" || !rawIv || !rawTag || !rawCiphertext) throw new Error("密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(rawIv, "base64url"));
  decipher.setAuthTag(Buffer.from(rawTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(rawCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function randomDigits(length: number) {
  let output = "";
  while (output.length < length) output += String(randomInt(0, 10));
  return output.slice(0, length);
}

export function randomMerchantPid() {
  return `${randomInt(1, 10)}${randomDigits(9)}`;
}

export function randomAlphaNumeric(length: number) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let output = "";
  while (output.length < length) output += alphabet[randomInt(0, alphabet.length)];
  return output;
}

export function parseMoneyToCents(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(raw)) {
    throw new AppError(400, "INVALID_MONEY", "金额格式错误，必须是最多两位小数的正数");
  }
  const [yuan, fraction = ""] = raw.split(".");
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new AppError(400, "INVALID_MONEY", "金额必须大于 0");
  }
  return cents;
}

export function centsToMoney(cents: number) {
  return (cents / 100).toFixed(2);
}

export function isAllowedCallbackHost(hostname: string, allowedHosts?: string[]): boolean {
  const host = hostname.toLowerCase();
  const configured = allowedHosts ?? (process.env.ALLOWED_CALLBACK_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return configured.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

const DANGEROUS_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 138, 139,
  143, 179, 389, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 556, 563, 587,
  601, 636, 993, 995, 2049, 3306, 3659, 4045, 5432, 6000, 6379, 6665, 6666, 6667,
  6668, 6669, 6697, 11211, 27017, 28017,
]);

export function validateCallbackUrl(value: string, allowPrivate: boolean, allowedHosts?: string[]) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, "INVALID_CALLBACK_URL", "回调地址不是有效 URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new AppError(400, "INVALID_CALLBACK_URL", "回调地址只允许 HTTP/HTTPS");
  }
  if (url.username || url.password) {
    throw new AppError(400, "INVALID_CALLBACK_URL", "回调地址不能包含用户名或密码");
  }
  if (url.port) {
    const portNum = Number.parseInt(url.port, 10);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535 || DANGEROUS_PORTS.has(portNum)) {
      throw new AppError(400, "INVALID_CALLBACK_URL", "回调地址端口受限或不安全");
    }
  }
  if (!allowPrivate && !isAllowedCallbackHost(url.hostname, allowedHosts) && isPrivateHostname(url.hostname)) {
    throw new AppError(400, "PRIVATE_CALLBACK_FORBIDDEN", "回调地址不能指向本机或私有网络");
  }
  return url;
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  return isIP(normalized) > 0 && isPrivateAddress(normalized);
}

function ipv4FromGroups(hi: number, lo: number) {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.includes(":")) {
    const groups = expandIpv6(value);
    if (!groups) return true;
    // Unspecified (::) or Loopback (::1)
    if (groups.every((group) => group === 0) || (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1)) return true;
    // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
    if ((groups[0]! & 0xfe00) === 0xfc00 || (groups[0]! & 0xffc0) === 0xfe80 || (groups[0]! & 0xff00) === 0xff00) return true;
    // Documentation (2001:db8::/32) and Teredo (2001:0000::/32)
    if (groups[0] === 0x2001 && (groups[1] === 0x0db8 || groups[1] === 0x0000)) return true;
    // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d)
    if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0x0000)) {
      return isPrivateAddress(ipv4FromGroups(groups[6]!, groups[7]!));
    }
    // NAT64 Well-Known Prefix (64:ff9b::/96) and Local-Use NAT64 (64:ff9b:1::/48)
    if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
      if (groups[2] === 1) return true;
      if (groups.slice(2, 6).every((group) => group === 0)) {
        return isPrivateAddress(ipv4FromGroups(groups[6]!, groups[7]!));
      }
    }
    // 6to4 (2002::/16) embedding IPv4 in groups[1..2]
    if (groups[0] === 0x2002) {
      return isPrivateAddress(ipv4FromGroups(groups[1]!, groups[2]!));
    }
    return false;
  }
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function expandIpv6(address: string) {
  let normalized = address;
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const bytes = dotted.split(".").map(Number);
    if (bytes.length !== 4 || bytes.some((byte) => byte < 0 || byte > 255)) return null;
    normalized = normalized.slice(0, -dotted.length) + `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const sections = normalized.split("::");
  if (sections.length > 2) return null;
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections[1] ? sections[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((sections.length === 1 && missing !== 0) || missing < 0) return null;
  const raw = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  const groups = raw.map((group) => /^[a-f\d]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN);
  return groups.length === 8 && groups.every(Number.isFinite) ? groups : null;
}

export async function resolvePublicDestination(
  url: URL,
  allowPrivate: boolean,
  allowedHosts?: string[],
): Promise<LookupAddress[] | null> {
  if (allowPrivate) return null;
  if (isAllowedCallbackHost(url.hostname, allowedHosts)) return null;
  const normalizedHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipFamily = isIP(normalizedHost);
  if (ipFamily > 0) {
    if (isPrivateAddress(normalizedHost)) {
      throw new AppError(400, "PRIVATE_CALLBACK_FORBIDDEN", "回调地址解析到了私有或保留地址");
    }
    return [{ address: normalizedHost, family: ipFamily }];
  }
  const results = await lookup(url.hostname, { all: true, verbatim: true });
  if (results.length === 0 || results.some((result) => isPrivateAddress(result.address))) {
    throw new AppError(400, "PRIVATE_CALLBACK_FORBIDDEN", "回调域名解析到了私有或保留地址");
  }
  return results;
}

export async function assertPublicDestination(url: URL, allowPrivate: boolean, allowedHosts?: string[]) {
  await resolvePublicDestination(url, allowPrivate, allowedHosts);
}
