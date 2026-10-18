<template>
  <svg
    class="cluss-logo"
    :width="size"
    :height="size"
    viewBox="0 0 512 512"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <!-- 玻璃质感渐变：原稿色板（浅色主题用这套，一字未改） -->
      <linearGradient :id="gid('glass1')" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
        <stop class="lg1-a" offset="0%" stop-color="#C7D2FE" stop-opacity="1.0" />
        <stop class="lg1-b" offset="100%" stop-color="#E0E7FF" stop-opacity="0.85" />
      </linearGradient>
      <linearGradient :id="gid('glass2')" x1="100" y1="50" x2="400" y2="450" gradientUnits="userSpaceOnUse">
        <stop class="lg2-a" offset="0%" stop-color="#DDD6FE" stop-opacity="1.0" />
        <stop class="lg2-b" offset="100%" stop-color="#F3E8FF" stop-opacity="0.8" />
      </linearGradient>
      <linearGradient :id="gid('glass3')" x1="150" y1="450" x2="450" y2="100" gradientUnits="userSpaceOnUse">
        <stop class="lg3-a" offset="0%" stop-color="#BAE6FD" stop-opacity="1.0" />
        <stop class="lg3-b" offset="100%" stop-color="#E0F2FE" stop-opacity="0.85" />
      </linearGradient>

      <!-- 外部玻璃卡片的投影（保留，让卡片本身有悬浮感） -->
      <filter :id="gid('soft-shadow')" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="16" stdDeviation="24" flood-color="#818CF8" flood-opacity="0.2" />
      </filter>
    </defs>

    <!-- 背景透明，直接嵌入应用 -->

    <!-- 三层交叠的圆角玻璃切片 -->
    <g :filter="'url(#' + gid('soft-shadow') + ')'">
      <!-- 底层玻璃片 -->
      <rect x="106" y="106" width="300" height="300" rx="72" :fill="'url(#' + gid('glass1') + ')'" transform="rotate(-15 256 256)" />
      <!-- 中层玻璃片 -->
      <rect x="106" y="106" width="300" height="300" rx="72" :fill="'url(#' + gid('glass2') + ')'" transform="rotate(15 256 256)" />
      <!-- 顶层玻璃片 -->
      <rect x="136" y="136" width="240" height="240" rx="60" :fill="'url(#' + gid('glass3') + ')'" transform="rotate(45 256 256)" />
    </g>

    <!-- 中心解题元素：纯白实心、绝对对称的圆润四角星（无阴影，扁平纯净） -->
    <g>
      <path d="M 256 200
               Q 268 244 312 256
               Q 268 268 256 312
               Q 244 268 200 256
               Q 244 244 256 200 Z"
            fill="#FFFFFF" />
    </g>
  </svg>
</template>

<script>
// 组件可能在同页多处渲染，用唯一后缀避免渐变/滤镜 id 冲突。
// 除此之外，SVG 的形状、路径、结构均与 Cluss_logo.svg 原稿逐字一致。
var uid = 0;

export default {
  name: 'ClussLogo',
  props: {
    size: {
      type: [Number, String],
      default: 40
    }
  },
  data: function() {
    uid += 1;
    return { ns: 'clussLogo' + uid + '-' };
  },
  methods: {
    gid: function(key) {
      return this.ns + key;
    }
  }
};
</script>

<style scoped>
.cluss-logo {
  display: block;
  flex-shrink: 0;
}

/* 方案 D：只在深色主题下，把三片玻璃整体下移一档 —— 从原稿的 -200→-100
   变成 -300→-200。深色底下原稿那套近白色玻璃 + 白星会糊成一整块发光斑块，
   下移一档后三片之间露出一档可辨的色相/明度差；不再往深处走，保住原稿
   高明度 + 低彩度的马卡龙质感。浅色主题下这些规则不生效，用的仍是上面
   的原稿色值，一字未改。 */
html[data-theme="dark"] .lg1-a { stop-color: #A5B4FC; }
html[data-theme="dark"] .lg1-b { stop-color: #C7D2FE; }
html[data-theme="dark"] .lg2-a { stop-color: #C4B5FD; }
html[data-theme="dark"] .lg2-b { stop-color: #DDD6FE; }
html[data-theme="dark"] .lg3-a { stop-color: #7DD3FC; }
html[data-theme="dark"] .lg3-b { stop-color: #BAE6FD; }
</style>
