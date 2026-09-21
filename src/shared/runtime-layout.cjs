/** 运行模块完整性约束：打包检查与运行期缓存检查使用同一组必要文件。 */
// 启动脚本还会导入 dist 入口，二者必须同时存在；不同模块版本允许 js 或 mjs 入口。
const REQUIRED_FILES = [
  ["openclaw/package.json"],
  ["openclaw/openclaw.mjs"],
  ["openclaw/dist/entry.js", "openclaw/dist/entry.mjs"],
];

/** 按调用方提供的文件查询判断缺项，支持实际磁盘与压缩包目录表。 */
function missingRuntimeFiles(hasFile) {
  return REQUIRED_FILES.filter((alternatives) => !alternatives.some(hasFile)).map((alternatives) => alternatives.join(" 或 "));
}

module.exports = { missingRuntimeFiles };
