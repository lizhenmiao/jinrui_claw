/** 测试用 electron 桩：提供 paths/app 模块所需的最小 API。 */
module.exports = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === "exe" ? process.execPath : require("os").tmpdir()),
  },
};
