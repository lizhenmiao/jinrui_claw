/**
 * 配置敏感字段加解密：AES-256-GCM 按字段包裹。
 * 主密钥保存在 U 盘数据目录 secret.key，通过 HKDF 派生字段子密钥；
 * 运行时提供给 openclaw 网关的是解密净化后的临时配置副本。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getPaths } = require("../paths");
const VERSION = 1;
const MARKER = "zgy-secret-v1";
const KEY_FILE = "secret.key";
const HKDF_INFO = "zgy-openclaw-config-field-v1";

function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function keyPath() {
  return path.join(getPaths().stateDir, KEY_FILE);
}

function getOrCreateMasterKey() {
  const file = keyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const key = Buffer.from(stripBom(fs.readFileSync(file, "utf8")).trim(), "base64");
    if (key.length >= 32) return key.subarray(0, 32);
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString("base64") + "\n", "utf8");
  try { fs.chmodSync(file, 0o600); } catch { /* 文件权限仅 POSIX 生效 */ }
  return key;
}

function deriveKey(salt) {
  return crypto.hkdfSync("sha256", getOrCreateMasterKey(), Buffer.from(salt, "base64"), Buffer.from(HKDF_INFO), 32);
}

function isEncryptedEnvelope(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && value.$zgyEncrypted === MARKER);
}

function encryptString(value) {
  if (typeof value !== "string" || value === "") return value;
  const salt = crypto.randomBytes(16).toString("base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    $zgyEncrypted: MARKER,
    version: VERSION,
    algorithm: "aes-256-gcm",
    salt,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

function decryptString(envelope) {
  if (!isEncryptedEnvelope(envelope)) return envelope;
  if (envelope.version !== VERSION || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("不支持的加密字段格式");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(envelope.salt), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
}

function normalizeKey(key) {
  return String(key || "").toLowerCase().replace(/[-_\s]/g, "");
}

function isSensitiveKey(key) {
  return new Set([
    "apikey", "secret", "token", "password", "webhook",
    "credential", "credentials", "appsecret", "clientsecret",
    "accesstoken", "refreshtoken",
  ]).has(normalizeKey(key));
}

/** 递归加密对象中的敏感字符串字段（已加密的包络原样保留）。 */
function encryptConfigSecrets(value) {
  if (isEncryptedEnvelope(value)) return value;
  if (Array.isArray(value)) return value.map((item) => encryptConfigSecrets(item));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) && typeof item === "string" && item !== ""
      ? encryptString(item)
      : encryptConfigSecrets(item);
  }
  return result;
}

/** encryptConfigSecrets 的逆操作。 */
function decryptConfigSecrets(value) {
  if (isEncryptedEnvelope(value)) return decryptString(value);
  if (Array.isArray(value)) return value.map((item) => decryptConfigSecrets(item));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = decryptConfigSecrets(item);
  }
  return result;
}

/** openclaw 校验 provider 对象严格，剔除仅产品 UI 使用的元数据字段。 */
function sanitizeRuntimeConfig(config) {
  const out = JSON.parse(JSON.stringify(config || {}));
  const providers = out.models && out.models.providers;
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    for (const provider of Object.values(providers)) {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
      delete provider.displayName;
      delete provider.keyMode;
      delete provider.requiresClientKey;
    }
  }
  return out;
}

/** 生成解密净化后的运行时配置副本，返回文件路径（供网关子进程读取）。 */
function prepareRuntimeConfig() {
  const { configPath, stateDir } = getPaths();
  const runtimeDir = path.join(stateDir, "runtime");
  const config = sanitizeRuntimeConfig(decryptConfigSecrets(readJson(configPath)));
  fs.mkdirSync(runtimeDir, { recursive: true });
  writeJsonAtomic(path.join(runtimeDir, "openclaw.runtime.json"), config);
  return path.join(runtimeDir, "openclaw.runtime.json");
}

function readJson(file) {
  return JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
}

/** 原子写：同目录写临时文件后 rename，避免 U 盘拔出时留下半个文件。 */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

module.exports = {
  decryptConfigSecrets,
  encryptConfigSecrets,
  isEncryptedEnvelope,
  prepareRuntimeConfig,
  sanitizeRuntimeConfig,
  writeJsonAtomic,
};
