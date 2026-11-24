import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface RuntimeEnv {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  uploadDir: string;
  publicBaseUrl: string;
  allowPrivateCallbacks: boolean;
  allowedCallbackHosts: string[];
  trustProxy: boolean;
  trustedProxyCidrs: string[];
  trustCloudflare: boolean;
  setupToken: string;
  masterKey: Buffer;
}

function boolEnv(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true";
}

function decodeMasterKey(raw: string) {
  if (/^[a-f\d]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  throw new Error("APP_MASTER_KEY 必须是 32 字节 Base64 或 64 位十六进制，不能使用普通密码");
}

function loadMasterKey(dataDir: string) {
  const fromEnv = process.env.APP_MASTER_KEY?.trim();
  if (fromEnv) return decodeMasterKey(fromEnv);

  const keyPath = resolve(dataDir, ".master-key");
  if (existsSync(keyPath)) return decodeMasterKey(readFileSync(keyPath, "utf8").trim());

  const generated = randomBytes(32).toString("base64");
  try {
    writeFileSync(keyPath, `${generated}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return decodeMasterKey(readFileSync(keyPath, "utf8").trim());
    }
    throw error;
  }
  return Buffer.from(generated, "base64");
}

function loadSetupToken(dataDir: string, nodeEnv: RuntimeEnv["nodeEnv"]) {
  const fromEnv = process.env.SETUP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (nodeEnv !== "production") return "";

  const tokenPath = resolve(dataDir, ".setup-token");
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();

  const generated = randomBytes(24).toString("base64url");
  try {
    writeFileSync(tokenPath, `${generated}\n`, { flag: "wx", mode: 0o600 });
    console.info(JSON.stringify({
      level: "info",
      event: "setup_token_created",
      token_file: tokenPath,
      message: "已生成首次安装安全令牌文件，请查看该文件内容或配置 SETUP_TOKEN 环境变量完成初始化",
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readFileSync(tokenPath, "utf8").trim();
    }
    throw error;
  }
  return generated;
}

export function consumeSetupToken(dataDir = getRuntimeEnv().dataDir) {
  try {
    rmSync(resolve(dataDir, ".setup-token"), { force: true });
  } catch {
    // Ignore cleanup errors
  }
  if (cached && !process.env.SETUP_TOKEN?.trim()) {
    cached.setupToken = "";
  }
}

let cached: RuntimeEnv | undefined;

export function getRuntimeEnv(): RuntimeEnv {
  if (cached) return cached;
  const rawNodeEnv = process.env.NODE_ENV ?? "development";
  const nodeEnv: RuntimeEnv["nodeEnv"] = rawNodeEnv === "production" || rawNodeEnv === "test" ? rawNodeEnv : "development";
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const dataDir = resolve(process.env.DATA_DIR ?? "./data");
  const uploadDir = resolve(dataDir, "uploads");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700);
    chmodSync(uploadDir, 0o700);
  } catch {
    // Ignore permission errors on non-POSIX or restricted filesystems
  }

  const rawPublicUrl = process.env.PUBLIC_BASE_URL?.trim();
  const defaultPublicUrl = nodeEnv === "production" ? "" : `http://localhost:${Number.isFinite(port) ? port : 3000}`;

  cached = {
    nodeEnv,
    host: process.env.HOST ?? "0.0.0.0",
    port: Number.isFinite(port) ? port : 3000,
    dataDir,
    databasePath: existsSync(resolve(dataDir, "apuspay.sqlite"))
      ? resolve(dataDir, "apuspay.sqlite")
      : existsSync(resolve(dataDir, "alimpay.sqlite"))
        ? resolve(dataDir, "alimpay.sqlite")
        : resolve(dataDir, "apuspay.sqlite"),
    uploadDir,
    publicBaseUrl: (rawPublicUrl || defaultPublicUrl).replace(/\/$/, ""),
    allowPrivateCallbacks: boolEnv(process.env.ALLOW_PRIVATE_CALLBACKS),
    allowedCallbackHosts: (process.env.ALLOWED_CALLBACK_HOSTS ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    trustProxy: boolEnv(process.env.TRUST_PROXY),
    trustedProxyCidrs: (process.env.TRUSTED_PROXY_CIDRS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    trustCloudflare: boolEnv(process.env.TRUST_CLOUDFLARE),
    setupToken: loadSetupToken(dataDir, nodeEnv),
    masterKey: loadMasterKey(dataDir),
  };
  return cached;
}

export function resetRuntimeEnvForTests() {
  cached = undefined;
}
