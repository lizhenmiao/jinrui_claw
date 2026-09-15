/**
 * 扫码绑定通用会话：状态、二维码缓存、过期自动重建策略、等待与变更通知。
 * 各通道只提供"怎么发起一次尝试"（微信拉子进程、QQ 调官方连接器）与"怎么结束当前尝试"，
 * 结果通过 reportQr / reportStatus / attemptEnded 报进来；
 * 冷却时间与连续重建上限统一取 timing.qrSession，保证各通道行为一致。
 */
const timing = require("../../shared/timing.json");

/** 默认文案；各通道可覆盖等待/结束等措辞。 */
const DEFAULT_TEXT = {
  pending: "正在生成二维码...",
  waiting: "请扫码",
  ended: "二维码已失效，正在重新生成...",
  capped: "二维码已多次失效，已停止自动生成，请点击\"刷新二维码\"重新获取",
};

/**
 * 创建一个扫码会话。start(options) 负责发起一次尝试，stop() 负责结束当前尝试；
 * 两者由调用方实现，会话只维护状态与重建策略。
 */
function createQrSession({ start, stop, messages = {} }) {
  const text = { ...DEFAULT_TEXT, ...messages };
  let status = "idle";
  let message = "";
  let qr = "";
  let qrAt = 0;
  let attemptAt = 0;
  let autoCount = 0;
  let attemptOver = true;
  const listeners = new Set();

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个监听者异常不影响扫码流程 */ }
    }
  };
  const setStatus = (next, nextMessage) => {
    status = next;
    if (nextMessage) message = nextMessage;
  };

  /** 发起一次尝试；auto=true 为后台自动重建，受冷却与次数上限约束。 */
  const begin = (options = {}) => {
    const auto = options.auto === true;
    if (auto && autoCount >= timing.qrSession.maxAutoRegenerate) {
      setStatus("expired", text.capped);
      notify();
      return false;
    }
    autoCount = auto ? autoCount + 1 : 0;
    attemptOver = false;
    attemptAt = Date.now();
    qr = "";
    qrAt = 0;
    setStatus("pending", text.pending);
    notify();
    try {
      start(options);
    } catch (error) {
      attemptOver = true;
      setStatus("failed", `扫码进程启动失败：${error.message}`);
    }
    notify();
    return true;
  };

  /** 结束当前尝试：标记结束并调用使用方的 stop 钩子（halt 与 reset 共用）。 */
  const haltAttempt = () => {
    attemptOver = true;
    try { stop(); } catch { /* 旧尝试可能已结束 */ }
  };

  return {
    begin,
    /** 二维码就绪；同一地址不重复上报。 */
    reportQr(url) {
      const value = String(url || "").trim();
      if (!value || value === qr) return;
      qr = value;
      qrAt = Date.now();
      if (status !== "success") setStatus("waiting", text.waiting);
      notify();
    },
    /** 报状态推进（已扫码/成功/失败/过期）；成功后不再回退。 */
    reportStatus(next, nextMessage) {
      if (status === "success" && next !== "success") return;
      if (next === "expired") { qr = ""; qrAt = 0; }
      if (next === "success") { autoCount = 0; attemptOver = true; }
      setStatus(next, nextMessage);
      notify();
    },
    /** 本次尝试结束（子进程退出、连接断开）：未成功时回到待重建，等快照里的策略拉起下一轮。 */
    attemptEnded(nextMessage) {
      attemptOver = true;
      if (status !== "success") setStatus("pending", nextMessage || text.ended);
      notify();
    },
    /** 结束当前尝试（不发通知），用于用户主动重新发起前清掉旧的。 */
    halt() {
      haltAttempt();
    },
    /** 完全复位到空闲（出厂重置用）：结束当前尝试并清空状态与计数，之后快照不会再自动重建。 */
    reset() {
      haltAttempt();
      status = "idle";
      message = "";
      qr = "";
      qrAt = 0;
      autoCount = 0;
      notify();
    },
    /**
     * 状态快照：空闲且过了冷却就自动重建（界面轮询即触发），次数用尽则报"已停止自动生成"。
     * 已绑定/通道未启用这类分支由调用方在拿到快照前后自行处理。
     */
    snapshot() {
      if (attemptOver && status !== "success" && status !== "idle") {
        if (Date.now() - attemptAt >= timing.qrSession.regenerateCooldownMs) {
          if (autoCount >= timing.qrSession.maxAutoRegenerate) setStatus("expired", text.capped);
          else begin({ auto: true });
        }
      }
      return { status, qr, message: message || (qr ? text.waiting : text.pending), running: !attemptOver };
    },
    /** 等新二维码出现（相对调用时刻），超时返回空串。 */
    waitForQr(timeoutMs) {
      if (qr && status !== "expired") return Promise.resolve(qr);
      const baseline = qr;
      return new Promise((resolve) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => { unsubscribe(); resolve(""); }, timeoutMs);
        unsubscribe = this.onchange(() => {
          if (!qr || qr === baseline) return;
          clearTimeout(timer);
          unsubscribe();
          resolve(qr);
        });
      });
    },
    /** 订阅状态变化（二维码出现、状态推进），返回取消订阅函数。 */
    onchange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 二维码生成至今的毫秒数（没有码时为 Infinity），用于复用热码。 */
    qrAge() {
      return qrAt ? Date.now() - qrAt : Infinity;
    },
    /** 本次尝试已进行的毫秒数，用于记录"出码耗时"这类诊断日志。 */
    attemptElapsedMs() {
      return attemptAt ? Date.now() - attemptAt : 0;
    },
    /** 当前是否处于某次尝试中（未结束且未成功）。 */
    isActive() {
      return !attemptOver && status !== "success";
    },
  };
}

module.exports = { createQrSession };
