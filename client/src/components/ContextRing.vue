<!--
  上下文状态圆环

  为什么手写 SVG 而不是引图表库：教室里的低端平板加载一个图表库要几百 KB，
  而这个圆环只需要两个 <circle>。少一个依赖 = 更快的首屏 + 更小的故障面
  （与 UsageChart.vue 同一个取舍）。

  为什么用 stroke-dasharray 而不是 conic-gradient：
    目标基线是 Chrome 80（受管平板），conic-gradient 要 Chrome 69+ 才有，
    但它的色彩过渡与动画在旧内核上表现不稳定；
    dasharray + dashoffset 是 SVG 1.1 就有的老东西，稳。
    代价是渐变沿路径走不通 —— 所以用单一描边色 + 分档位换色，够用了。

  分档（level）由调用方决定，组件只负责上色：
    idle   —— 还没测量过（空心虚线，不撒谎说"0%"）
    ok     —— 完整（主色）
    warn   —— 部分丢失（琥珀）
    danger —— 大量丢失（红）
-->
<template>
  <span class="ctx-ring" :class="'is-' + level" :style="boxStyle" aria-hidden="true">
    <svg
      class="ctx-ring-svg"
      :width="size"
      :height="size"
      :viewBox="'0 0 ' + size + ' ' + size"
      focusable="false"
    >
      <circle
        class="ctx-ring-track"
        :class="{ 'is-dashed': unknown }"
        :cx="center"
        :cy="center"
        :r="radius"
        :stroke-width="stroke"
        fill="none"
      />
      <circle
        v-if="!unknown"
        class="ctx-ring-fill"
        :cx="center"
        :cy="center"
        :r="radius"
        :stroke-width="stroke"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="dashoffset"
        :transform="'rotate(-90 ' + center + ' ' + center + ')'"
        fill="none"
        stroke-linecap="round"
      />
    </svg>
  </span>
</template>

<script>
export default {
  name: 'ContextRing',
  props: {
    // 0 ~ 100；unknown 为真时被忽略
    percent: { type: Number, default: 0 },
    // 圆环直径（px）。调用方用 clamp() 传进来做大屏放大
    size: { type: Number, default: 18 },
    // 环粗细（px）
    stroke: { type: Number, default: 2.4 },
    // ok | warn | danger | idle
    level: { type: String, default: 'ok' },
    // 未测量态：只画一圈虚线底环，不画进度
    unknown: { type: Boolean, default: false }
  },
  computed: {
    boxStyle: function() {
      return { width: this.size + 'px', height: this.size + 'px' };
    },
    center: function() { return this.size / 2; },
    // 半径要把描边算进去，否则环的外沿会超出 viewBox 被裁掉一圈
    radius: function() { return Math.max(1, this.size / 2 - this.stroke / 2); },
    circumference: function() { return 2 * Math.PI * this.radius; },
    clamped: function() {
      var p = Number(this.percent);
      if (!isFinite(p)) p = 0;
      return Math.min(100, Math.max(0, p));
    },
    dashoffset: function() {
      return this.circumference * (1 - this.clamped / 100);
    }
  }
};
</script>

<style scoped>
.ctx-ring {
  display: block;
  flex-shrink: 0;
}

.ctx-ring-svg {
  display: block;
  overflow: visible;
}

/* 底环：全程可见，让"这个圆环代表一个满值"这件事始终成立 */
.ctx-ring-track {
  stroke: var(--ink-3);
}

/* 未测量时把底环画成虚线 —— 和"测出来是 0"区分开。
   画实心环会被读成"用量为 0"，那是撒谎：我们只是还不知道。 */
.ctx-ring-track.is-dashed {
  stroke-dasharray: 2.4 2.8;
}

.ctx-ring-fill {
  stroke: var(--accent);
  transition: stroke-dashoffset var(--dur-slow) var(--ease-out),
              stroke var(--dur-base) var(--transition-ease, ease);
}

.ctx-ring.is-warn .ctx-ring-fill { stroke: var(--warning); }
.ctx-ring.is-danger .ctx-ring-fill { stroke: var(--danger); }
.ctx-ring.is-idle .ctx-ring-fill { stroke: var(--ink-3); }

/* 低性能降级：关掉过渡动画，只保留最终状态。
   圆环的填充动画在课堂上没有信息量，省下的合成开销留给流式渲染。 */
html.low-perf .ctx-ring-fill {
  transition: none;
}
</style>
