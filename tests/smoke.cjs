/** 模块级冒烟测试：stub electron 后验证路径解析、加解密、配置存取与授权绑定。 */
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "electron") return require.resolve("./electron-stub.cjs");
  return orig.call(this, request, ...args);
};

const paths = require("../src/main/paths.js");
const p = paths.getPaths();
console.log("productRoot =", p.productRoot);

const secret = require("../src/main/services/secret-crypto.js");
const encrypted = secret.encryptConfigSecrets({ apiKey: "sk-test-123", name: "模型" });
console.log("encrypt envelope ok =", Boolean(encrypted.apiKey.$zgyEncrypted));
console.log("decrypt roundtrip ok =", secret.decryptConfigSecrets(encrypted).apiKey === "sk-test-123");

const store = require("../src/main/services/config-store.js");
const config = store.readConfig();
console.log("factory gateway.mode =", config.gateway.mode, "token len =", (config.gateway.auth.token || "").length);
store.writeConfig({ agents: { defaults: { model: "deepseek/deepseek-v4-flash" } }, models: { providers: { deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-abc" } } } });
const updated = store.readConfig();
console.log("merge model =", updated.agents.defaults.model);
console.log("merge apiKey decrypted =", updated.models.providers.deepseek.apiKey);
console.log("isConfigured =", store.isConfigured());

const license = require("../src/main/services/license.js");
console.log("license required (dev mode) =", license.shouldRequireLicense());
console.log("bind ok =", license.bindUsb().ok);
console.log("verify after bind ok =", license.verify().ok);
console.log("ALL SMOKE TESTS PASSED");
