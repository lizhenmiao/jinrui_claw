/**
 * 授权校验与绑定：HMAC-SHA256 签名的授权文件与 U 盘指纹绑定。
 * 打包发行的副本一律要求授权；仅开发模式（未打包）免校验。
 * 母本 U 盘与客户 U 盘统一执行 --bind-usb 绑定，不存在文件存在性绕过。
 *
 * 绑定文件里除了设备指纹，还会带上该盘的**后台授权码**（--bind-usb --license 写入）：
 * 一张盘一个授权码，同一个安装包就能发给不同客户，不必按客户重新打包；
 * 后台地址这类"改了就能架空授权"的配置仍然锁死在包内 asar 里，不从这里读。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const { getPaths } = require("../paths");
const { getFingerprint, mask, usbSerialUnavailableMessage } = require("./fingerprint");

const LICENSE_VERSION = 1;
// 授权签名密钥内置于客户端，用于离线校验授权文件完整性。
const LICENSE_SECRET = "xlx-openclaw-usb-license-v1-20260715";
/** 后台授权码取值约束（与后台 licenses.license_key 的 varchar(64) 对齐）。 */
const LICENSE_KEY_PATTERN = /^[A-Za-z0-9._-]{4,64}$/;

/** 授权码格式是否合法（命令行与绑定写入两处共用同一个判断）。 */
function isValidLicenseKey(value) {
  return LICENSE_KEY_PATTERN.test(String(value || "").trim());
}

/** 授权文件路径（data/license.json）。 */
function licensePath() {
  return getPaths().licensePath;
}

function fileExists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

/** 把散落在 U 盘根目录的 license.dat 归位到 data/license.json（早期分布遗留的盘，仅首次执行）。 */
function migrateLegacyLicense() {
  const { licensePath: target, legacyLicensePath: legacy } = getPaths();
  try {
    if (fileExists(target) || !fileExists(legacy)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(legacy, target);
    fs.rmSync(legacy, { force: true });
  } catch { /* 迁移失败时仍按缺失处理，可重新绑定 */ }
}

/** 打包副本必须持有与当前 U 盘指纹匹配的授权；开发模式跳过。 */
function shouldRequireLicense() {
  return app.isPackaged === true;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function signPayload(payload) {
  return crypto.createHmac("sha256", LICENSE_SECRET).update(stableJson(payload)).digest("hex");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readLicense(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const json = raw.startsWith("XLX-LICENSE-v1:")
    ? Buffer.from(raw.slice("XLX-LICENSE-v1:".length), "base64").toString("utf8")
    : raw;
  return JSON.parse(json);
}

/**
 * 为当前 U 盘生成授权文件（母本与客户副本统一走此绑定）。
 * 传入 licenseKey 时一并写入（售后在客户现场一条命令同时完成本地绑定与授权码下发）；
 * 不传则沿用包内配置的授权码，保持旧用法可用。
 */
function bindUsb(options = {}) {
  const { productRoot } = getPaths();
  migrateLegacyLicense();
  const fp = getFingerprint();
  if (!fp.available) throw new Error(usbSerialUnavailableMessage());
  const licenseKey = String(options.licenseKey || "").trim();
  if (licenseKey && !isValidLicenseKey(licenseKey)) {
    throw new Error(`授权码格式不正确：${licenseKey}（只允许字母、数字、点、下划线、短横线，4~64 位）`);
  }
  const payload = {
    product: "ZgyClaw USB",
    edition: "zgyclaw-usb",
    version: LICENSE_VERSION,
    licenseId: `ZGY-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
    deviceFingerprint: fp.fingerprint,
    deviceIdentity: fp.identity,
    createdAt: new Date().toISOString(),
  };
  if (licenseKey) payload.licenseKey = licenseKey;
  const license = { version: LICENSE_VERSION, payload, signature: signPayload(payload) };
  const encoded = `XLX-LICENSE-v1:${Buffer.from(JSON.stringify(license), "utf8").toString("base64")}\n`;
  // 全新 U 盘上 data/ 还不存在（用户还没启动过客户端），这里必须先建目录，否则写入直接失败。
  fs.mkdirSync(path.dirname(licensePath()), { recursive: true });
  fs.writeFileSync(licensePath(), encoded, "utf8");
  return { ok: true, filePath: licensePath(), productRoot, licenseKey, fingerprint: fp.fingerprint, maskedFingerprint: fp.maskedFingerprint, info: fp.info };
}

/**
 * 本地绑定文件里的授权码（没有就是空串）。
 * 只在本地授权**本身有效**时采信：签名不对说明文件被改过，指纹不符说明这盘没被授权过，两种情况都退回空串让调用方用包内配置的授权码，避免拿一个来路不明的授权码去请求后台。
 */
function boundLicenseKey() {
  const result = verify();
  if (!result.ok) return "";
  return String(result.license?.payload?.licenseKey || "").trim();
}

/** 校验当前 U 盘授权；失败返回带 code 的结果，由启动链决定是否放行。 */
function verify() {
  migrateLegacyLicense();
  const filePath = licensePath();
  try {
    if (!fileExists(filePath)) {
      // 面向用户的文案不带路径（filePath 仅供 CLI 与日志排障用）。
      return { ok: false, code: "MISSING_LICENSE", filePath, message: "缺少授权文件。" };
    }
    const license = readLicense(filePath);
    if (!license || license.version !== LICENSE_VERSION || !license.payload || !license.signature) {
      return { ok: false, code: "BAD_LICENSE_FORMAT", filePath, message: "授权文件格式不正确。" };
    }
    if (!timingSafeEqualHex(signPayload(license.payload), license.signature)) {
      return { ok: false, code: "BAD_LICENSE_SIGNATURE", filePath, message: "授权文件签名不正确，可能被修改。" };
    }
    const fp = getFingerprint();
    if (!fp.available) {
      return { ok: false, code: "USB_SERIAL_UNAVAILABLE", filePath, message: usbSerialUnavailableMessage() };
    }
    if (license.payload.deviceFingerprint !== fp.fingerprint) {
      return {
        ok: false,
        code: "DEVICE_MISMATCH",
        filePath,
        message: `当前设备未授权。授权=${mask(license.payload.deviceFingerprint)} 当前=${fp.maskedFingerprint}`,
      };
    }
    return { ok: true, filePath, license, fingerprint: fp.fingerprint, maskedFingerprint: fp.maskedFingerprint, info: fp.info };
  } catch (error) {
    return { ok: false, code: "LICENSE_ERROR", filePath, message: `授权校验失败：${error.message}` };
  }
}

/** 授权文件摘要信息（供售后信息展示）。 */
function readLicenseSummary() {
  const candidates = [licensePath()];
  for (const file of candidates) {
    try {
      if (!fileExists(file)) continue;
      if (file.endsWith(".json")) {
        const raw = readLicense(file);
        const summary = raw?.payload && typeof raw.payload === "object" ? raw.payload : raw;
        return {
          exists: true,
          file: path.basename(file),
          serial: String(summary?.deviceIdentity?.usbId || summary?.serial || summary?.usbSerial || summary?.deviceSerial || ""),
          edition: String(summary?.edition || summary?.plan || ""),
          customer: String(summary?.customer || summary?.customerName || ""),
          expiresAt: summary?.expiresAt || null,
        };
      }
      return { exists: true, file: path.basename(file) };
    } catch {
      return { exists: true, file: path.basename(file), unreadable: true };
    }
  }
  return { exists: false };
}

/** 售后信息汇总：版本、U 盘序列号、授权状态、授权码、端口与运行目录。 */
function buildLicenseInfo() {
  const { productRoot, dataDir, configPath } = getPaths();
  const info = getFingerprint();
  const summary = readLicenseSummary();
  const licenseKey = boundLicenseKey();
  const generatedAt = new Date().toISOString();
  const result = {
    productId: "ZgyClaw USB",
    usb: { root: info.root, serial: info.identity.usbId || "UNKNOWN", displaySerial: info.identity.usbId || "UNKNOWN" },
    license: { ...summary, licenseKey, status: summary.exists ? "已检测到授权文件" : "未检测到授权文件" },
    paths: { rootDir: productRoot, dataDir, configPath },
    generatedAt,
  };
  result.copyText = [
    "【小龙虾U盘版售后信息】",
    `产品：${result.productId}`,
    `U盘序列号：${result.usb.displaySerial}`,
    `授权状态：${result.license.status}`,
    `授权码：${licenseKey || "未写入"}`,
    `运行目录：${productRoot}`,
    `生成时间：${generatedAt}`,
  ].join("\n");
  return result;
}

module.exports = {
  boundLicenseKey,
  bindUsb,
  buildLicenseInfo,
  isValidLicenseKey,
  shouldRequireLicense,
  verify,
};
