/**
 * 弹窗 Esc 关闭。
 *
 * 为什么需要它：全站的弹窗/浮层只有 ModelSelect 支持 Esc，其余一律只能
 *   点遮罩或找那个 ×。而"按 Esc 关掉浮层"是所有平台的肌肉记忆 ——
 *   键盘用户按了没反应，会以为界面卡死了；触屏用户则要伸手去点边缘。
 *
 * 为什么能做得这么轻：各页的弹窗都是 `v-if` 控制挂载的
 *   （`<CloudPicker v-if="pickerOpen">`），所以**组件存在就等于弹窗打开**，
 *   不需要组件再暴露"打开/关闭"钩子 —— mounted 挂上、beforeDestroy 摘掉即可。
 *
 * 关闭动作的取法（按优先级）：
 *   1. 组件自己的 `onEscClose()` 方法 —— 关闭前还需要做点别的（比如复原草稿）
 *   2. `$emit('close')` —— 站内约定俗成的关闭事件，多数弹窗直接可用
 *
 * ⚠️ 挂在 document 上而不是容器上：键盘事件只有在焦点位于容器内部时才会
 *   冒泡到它。而多数弹窗打开后焦点并不在里面（甚至还在触发按钮上），
 *   那样的话按 Esc 什么都不会发生 —— 这正是"加了跟没加一样"的常见坑。
 */
export default {
  mounted: function() {
    var self = this;
    this.$_escHandler = function(e) {
      // keyCode 兜底：目标是 Chrome 89，e.key 可用，
      // 但项目里其它键盘处理都同时判两者，保持一致
      if (e.key !== 'Escape' && e.keyCode !== 27) return;
      e.preventDefault();
      if (typeof self.onEscClose === 'function') {
        self.onEscClose();
      } else {
        self.$emit('close');
      }
    };
    document.addEventListener('keydown', this.$_escHandler);
  },

  beforeDestroy: function() {
    if (this.$_escHandler) {
      document.removeEventListener('keydown', this.$_escHandler);
      this.$_escHandler = null;
    }
  }
};
