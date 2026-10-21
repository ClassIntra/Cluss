<template>
  <span class="tgl" :class="{ 'is-on': checked, 'is-disabled': disabled }">
    <input
      type="checkbox"
      class="tgl-input"
      :checked="checked"
      :disabled="disabled"
      :aria-label="label || null"
      @change="onChange"
    />
    <span class="tgl-track" aria-hidden="true"><span class="tgl-knob"></span></span>
  </span>
</template>

<script>
// 全站唯一的开关外观。
//
// 为什么做成组件：设置弹窗和「校园」面板各写了一套**同名 class 但结构完全不同**
// 的开关 —— 一处是 38×22 的纯 CSS 假开关（空 span + ::after），另一处是 46×28 的
// 真 checkbox（track + knob 两层）。同屏出现时大小、圆钮颜色、滑动距离全不一样，
// 用户一眼就看出"这两个不是一套东西"。
//
// 视觉尺寸以「通用」tab 原来的 38×22 为准绳（2026-10-20 用户明确要求校园向它对齐）：
//   38×22 轨道、18px 白圆钮、位移 16px、关闭态 --ink-4、开启态 --accent。
//   46×28 看着更"现代"，但两处不一致本身就是问题 —— 对齐比好看优先。
//
// 语义用真实 checkbox 而不是 role="switch" 的 button：
//   ① 能放进 <label> 里，整行可点（父级包一层即可）；
//   ② 键盘 / 读屏原生支持，不用手写 aria-checked；
//   ③ 命中区靠 ::after 撑到 44px（触屏红线），38×22 在触屏上偏小。
export default {
  name: 'ToggleSwitch',
  props: {
    checked: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    label: { type: String, default: '' }
  },
  methods: {
    onChange: function(e) {
      var el = e.target;
      var next = !!el.checked;
      this.$emit('change', next);
      // 父级可能不采纳（请求失败要回滚）：下一帧把 DOM 对齐回 prop 的真值，
      // 否则滑块会停在学生点的那一侧，与真实状态不符 —— 这种"看着是开的、
      // 其实没生效"比不做乐观更新更糟。
      var self = this;
      this.$nextTick(function() {
        if (el.checked !== self.checked) el.checked = self.checked;
      });
    }
  }
};
</script>

<style scoped>
.tgl {
  position: relative;
  flex-shrink: 0;
  display: inline-block;
  width: 38px;
  height: 22px;
  vertical-align: middle;
}

.tgl-input {
  position: absolute;
  left: 0;
  top: 0;
  width: 38px;
  height: 22px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 2;
}

/* 命中区向四周撑开（视觉不变）：22px 高在触屏上偏小，撑到 44px 触屏红线 */
.tgl::after {
  content: '';
  position: absolute;
  left: -3px;
  right: -3px;
  top: 50%;
  height: 44px;
  transform: translateY(-50%);
  background: transparent;
  z-index: 1;
}

.tgl-track {
  display: block;
  width: 38px;
  height: 22px;
  border-radius: var(--radius-pill);
  background: var(--ink-4);
  transition: background var(--transition);
}

.tgl-knob {
  display: block;
  width: 18px;
  height: 18px;
  margin: 2px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  /* 位移用 transform（合成层），不用 margin/left（会触发重排） */
  transform: translateX(0);
  transition: transform var(--transition);
}

.tgl.is-on .tgl-track {
  background: var(--accent);
}

.tgl.is-on .tgl-knob {
  transform: translateX(16px);
}

.tgl-input:disabled {
  cursor: not-allowed;
}

.tgl.is-disabled .tgl-track {
  opacity: 0.45;
}

/* 焦点环只在键盘操作时出现：触屏点击留一圈线是噪点（全站约定，见 main.js 的 kbd-focus）。
   刻意不用 :focus-visible —— Chrome 80 不认这个伪类，整条规则会被丢弃。 */
html.kbd-focus .tgl-input:focus + .tgl-track {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
