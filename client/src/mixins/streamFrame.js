// 把"随流式输出反复触发的工作"合并到每一帧一次（对话 / 拍题 / 作文共用）
//
// 为什么需要：一次 delta 就重解析整篇 Markdown（marked + KaTeX + DOMPurify），
// 长回答时每秒来几十次，主线程被占满 —— 表现就是"字一个一个蹦、滚动还卡"。
// 用 requestAnimationFrame 合并后，一帧最多算一次，视觉上依然连续
// （人眼分辨不出 16ms 的差别），但把几十次解析压成一次。
//
// 顺带解决另一个问题：原来每次 delta 都写 scrollTop，
// 会反复触发布局计算（layout thrashing）；合并到同一帧后只算一次。
//
// 用法：
//   this.scheduleFrame(function() { msg.html = renderMarkdown(msg.content); });
//   this.flushFrame();   // 收尾时立即跑一次，保证最后几个字不丢

// low-perf 设备（见 main.js 的判据）上再压一档：每帧一次仍然太快 ——
// 一次流式重渲染要重解析整篇 Markdown（marked + KaTeX + DOMPurify）再加布局，
// 在这类平板上单次就要几十毫秒，跟着 60Hz 走必然卡。
// 把刷新下限放宽到 80ms（约 12fps）：文字仍是"连续往外冒"的观感，
// 但主线程被空出来给滚动、输入和键盘。
// flushFrame 不受此限制 —— 收尾那次永远立即执行，最后一个字不会迟到。
var LOW_PERF_MIN_GAP = 80;

// .low-perf 在 main.js 启动时一次性写好，之后不会变；判一次缓存住即可
// （scheduleFrame 每秒被调几十次，classList.contains 本身也是一点开销）
var _lowPerf = null;
function isLowPerf() {
  if (_lowPerf === null) {
    try { _lowPerf = document.documentElement.classList.contains('low-perf'); }
    catch (e) { _lowPerf = false; }
  }
  return _lowPerf;
}

export default {
  beforeDestroy: function() {
    this.cancelFrame();
  },

  methods: {
    // 同一帧内多次调用只会执行最后一次
    scheduleFrame: function(fn) {
      var self = this;
      this._frameFn = fn;
      if (this._frameId != null) return;

      if (isLowPerf()) {
        var gap = LOW_PERF_MIN_GAP - (Date.now() - (this._lastPaintAt || 0));
        if (gap < 0) gap = 0;
        this._frameKind = 'timeout';
        this._frameId = setTimeout(function() {
          self._frameId = null;
          self._lastPaintAt = Date.now();
          var f = self._frameFn;
          self._frameFn = null;
          if (f) f();
        }, gap);
        return;
      }

      var raf = window.requestAnimationFrame || function(cb) { return setTimeout(cb, 16); };
      this._frameKind = 'raf';
      this._frameId = raf(function() {
        self._frameId = null;
        var f = self._frameFn;
        self._frameFn = null;
        if (f) f();
      });
    },

    // 立即执行挂起的那一次（用于流结束）
    // 注意先取出函数再 cancel —— cancelFrame 会把 _frameFn 清空，
    // 顺序反了就等于什么都没执行，最后一个字会丢
    flushFrame: function() {
      var f = this._frameFn;
      this.cancelFrame();
      if (f) f();
    },

    cancelFrame: function() {
      if (this._frameId != null) {
        // 两种挂起形态（rAF / setTimeout）的取消方式不同，
        // 用 cancelAnimationFrame 去取消一个 timeout id 是无效操作，
        // 那个 timeout 之后仍会触发 —— 必须按排程时记下的类型分派
        if (this._frameKind === 'timeout') {
          clearTimeout(this._frameId);
        } else {
          var cancel = window.cancelAnimationFrame || clearTimeout;
          cancel(this._frameId);
        }
        this._frameId = null;
      }
      this._frameFn = null;
    }
  }
};
