/**
 * 授权校验与绑定：HMAC-SHA256 签名的 license.dat 与 U 盘指纹绑定。
 * 打包发行的副本一律要求授权；仅开发模式（未打包）免校验。
 * 母本 U 盘与客户 U 盘统一执行 --bind-usb 绑定，不存在文件存在性绕过。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const { getPaths } = require("../paths");
const { getFingerprint, mask } = require("./fingerprint");

const LICENSE_VERSION = 1;
const LICENSE_FILE = "license.dat";
// 授权签名密钥内置于客户端，用于离线校验授权文件完整性。
const LICENSE_SECRET = "xlx-openclaw-usb-license-v1-20260715";

function licensePath() {
  return path.join(getPaths().productRoot, LICENSE_FILE);
}

function fileExists(file) {
  try { return fs.existsSync(file); } catch { return false; }
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

/** 为当前 U 盘生成授权文件（母本与客户副本统一走此绑定）。 */
function bindUsb() {
  const { productRoot } = getPaths();
  const fp = getFingerprint();
  const payload = {
    product: "ZgyClaw USB",
    edition: "zgyclaw-usb",
    version: LICENSE_VERSION,
    licenseId: `ZGY-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
    deviceFingerprint: fp.fingerprint,
    deviceIdentity: fp.identity,
    createdAt: new Date().toISOString(),
  };
  const license = { version: LICENSE_VERSION, payload, signature: signPayload(payload) };
  const encoded = `XLX-LICENSE-v1:${Buffer.from(JSON.stringify(license), "utf8").toString("base64")}\n`;
  fs.writeFileSync(licensePath(), encoded, "utf8");
  return { ok: true, filePath: licensePath(), productRoot, fingerprint: fp.fingerprint, maskedFingerprint: fp.maskedFingerprint, info: fp.info };
}

/** 校验当前 U 盘授权；失败返回带 code 的结果，由启动链决定是否放行。 */
function verify() {
  const filePath = licensePath();
  try {
    if (!fileExists(filePath)) {
      return { ok: false, code: "MISSING_LICENSE", filePath, message: `缺少授权文件：${filePath}` };
    }
    const license = readLicense(filePath);
    if (!license || license.version !== LICENSE_VERSION || !license.payload || !license.signature) {
      return { ok: false, code: "BAD_LICENSE_FORMAT", filePath, message: "授权文件格式不正确。" };
    }
    if (!timingSafeEqualHex(signPayload(license.payload), license.signature)) {
      return { ok: false, code: "BAD_LICENSE_SIGNATURE", filePath, message: "授权文件签名不正确，可能被修改。" };
    }
    const fp = getFingerprint();
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
  const candidates = [licensePath(), path.join(getPaths().dataDir, "license.json")];
  for (const file of candidates) {
    try {
      if (!fileExists(file)) continue;
      if (file.endsWith(".json")) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        return {
          exists: true,
          file: path.basename(file),
          serial: String(raw.serial || raw.usbSerial || raw.deviceSerial || ""),
          edition: String(raw.edition || raw.plan || ""),
          customer: String(raw.customer || raw.customerName || ""),
          expiresAt: raw.expiresAt || null,
        };
      }
      return { exists: true, file: path.basename(file) };
    } catch {
      return { exists: true, file: path.basename(file), unreadable: true };
    }
  }
  return { exists: false };
}

/** 售后信息汇总：版本、U 盘序列号、授权状态、端口与运行目录。 */
function buildLicenseInfo() {
  const { productRoot, dataDir, configPath } = getPaths();
  const info = getFingerprint();
  const summary = readLicenseSummary();
  const generatedAt = new Date().toISOString();
  const result = {
    productId: "ZgyClaw USB",
    usb: { root: path.parse(productRoot).root, serial: info.identity.volumeSerial || "UNKNOWN", displaySerial: info.identity.volumeSerial || "UNKNOWN" },
    license: { ...summary, status: summary.exists ? "已检测到授权文件" : "未检测到授权文件" },
    paths: { rootDir: productRoot, dataDir, configPath },
    generatedAt,
  };
  result.copyText = [
    "【小龙虾U盘版售后信息】",
    `产品：${result.productId}`,
    `U盘序列号：${result.usb.displaySerial}`,
    `授权状态：${result.license.status}`,
    `运行目录：${productRoot}`,
    `生成时间：${generatedAt}`,
  ].join("\n");
  return result;
}

module.exports = {
  bindUsb,
  buildLicenseInfo,
  shouldRequireLicense,
  verify,
};
