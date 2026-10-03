// 等待首字的通用状态（对话 / 拍题 / 作文三处共用）
//
// 抽成 mixin 而不是在三处各写一遍：这三个页面的等待逻辑必须完全一致，
// 否则会出现"对话页 8 秒就安抚、作文页干等到 30 秒"这种不一致 ——
// 而学生感受到的是同一件事：它到底还在不在动。
//
// 用法：
//   import waiting from '@/mixins/waiting';
//   export default { mixins: [waiting], ... }
//   提交时 this.startWaiting('chat')；拿到第一个字或收尾时 this.stopWaiting()

import { waitingLabel, STAGE_QUICK, STAGE_LONG } from '@/utils/waiting';

export default {
  data: function() {
    return {
      // 空字符串表示不显示等待提示
      waitText: ''
    };
  },

  // 组件销毁时一定要清定时器：否则离开页面后仍在改已销毁实例的状态
  beforeDestroy: function() {
    this.stopWaiting();
  },

  methods: {
    // kind: 'chat' | 'study' | 'grade' | 'writing'
    startWaiting: function(kind) {
      var self = this;
      this.stopWaiting();
      this.waitText = waitingLabel(0, kind);
      this._waitTimers = [
        setTimeout(function() { self.waitText = waitingLabel(STAGE_QUICK, kind); }, STAGE_QUICK),
        setTimeout(function() { self.waitText = waitingLabel(STAGE_LONG, kind); }, STAGE_LONG)
      ];
    },

    stopWaiting: function() {
      if (this._waitTimers) {
        for (var i = 0; i < this._waitTimers.length; i++) clearTimeout(this._waitTimers[i]);
        this._waitTimers = null;
      }
      this.waitText = '';
    }
  }
};
