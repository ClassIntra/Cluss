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

      var raf = window.requestAnimationFrame || function(cb) { return setTimeout(cb, 16); };
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
        var cancel = window.cancelAnimationFrame || clearTimeout;
        cancel(this._frameId);
        this._frameId = null;
      }
      this._frameFn = null;
    }
  }
};
