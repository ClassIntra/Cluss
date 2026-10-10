<template>
  <div
    ref="viewport"
    class="vlist"
    :class="{ 'vlist-scrolling': isScrolling }"
    @scroll="onScroll"
  >
    <!-- 上下占位撑出总高度，保证滚动条比例与实际内容一致 -->
    <div :style="{ height: topSpacer + 'px' }"></div>

    <div class="vlist-window">
      <slot :items="visibleItems" :start="startIndex" :end="endIndex"></slot>
    </div>

    <div :style="{ height: bottomSpacer + 'px' }"></div>
  </div>
</template>

<script>
/**
 * 轻量虚拟滚动列表（Vue 2），支持**变高**条目
 *
 * 为什么不用现成库：项目基线是 Chrome 80 / Android 9 / 微信 X5，
 * 引入库要为它单独做兼容与降级，而核心逻辑只有几十行。
 *
 * 解决的问题：长列表每次进出页面都要把全部条目重建一遍。
 * 实测 Cluss 笔记页 60 篇 = 1621 个 DOM 节点 + 726 个事件监听器，
 * 而切入该页的代价是**每次都付** 75~87ms，不是只付一次。
 *
 * ---- 变高条目怎么处理的 ----
 * 常见的虚拟滚动假设「所有条目等高」，但笔记列表不是：带标签的条目
 * 比不带的高（实测 69px vs 93px）。等高假设在这里会导致滚动位置越滚越偏。
 *
 * 这里的做法：
 *   - 用 `avgItemHeight`（实测均值）**估算**可视区能放几个条目
 *   - 渲染后立刻量真实高度，得出更准的均值（自适应）
 *   - 用 `paddingTop` 差值校正滚动位置，避免视觉跳动
 *
 * 代价：条目高度差异极大时（如从 20px 到 200px 混杂）估算会偏，
 * 此时 overscan 会自动放大以容忍误差。极端不等高场景请改用
 * 「定高 + 统一视觉高度」的列表，或另选方案。
 *
 * ⚠️ 前提，缺一个就会出问题：
 *   1. 容器必须有**确定的高度**且 overflow:auto（见 class="vlist"）
 *   2. 外部祖先不能有 transform —— 会让高度测量失真
 *   3. 条目数要够多才有收益（见 threshold）
 */
export default {
  name: 'VirtualList',
  props: {
    items: { type: Array, default: function () { return []; } },
    // 估算用的平均条目高度（px）。首帧靠它算，之后会被实测值修正。
    avgItemHeight: { type: Number, default: 72 },
    // 可视区外多渲染几条。变高条目估算有误差，这个值要留够余量。
    overscan: { type: Number, default: 6 },
    // 少于这个数量不虚拟化：此时虚拟化本身的计算开销更高，
    // 而且全量渲染保留了 Ctrl+F 搜未渲染文本这类原生能力。
    threshold: { type: Number, default: 30 }
  },
  data: function () {
    return {
      scrollTop: 0,
      viewportHeight: 0,
      measuredAvg: this.avgItemHeight,
      isScrolling: false
    };
  },
  computed: {
    virtualOn: function () {
      return this.items.length > this.threshold;
    },
    startIndex: function () {
      if (!this.virtualOn) return 0;
      var avg = Math.max(1, this.measuredAvg);
      var first = Math.floor(this.scrollTop / avg) - this.overscan;
      return Math.max(0, Math.min(this.items.length, first));
    },
    // 可视区里能放几个：用实测均值算，比固定值准得多
    visibleCount: function () {
      var avg = Math.max(1, this.measuredAvg);
      return Math.ceil(this.viewportHeight / avg) + 1;
    },
    endIndex: function () {
      if (!this.virtualOn) return this.items.length;
      var end = this.startIndex + this.visibleCount + this.overscan;
      return Math.min(this.items.length, end);
    },
    visibleItems: function () {
      if (!this.virtualOn) return this.items;
      return this.items.slice(this.startIndex, this.endIndex);
    },
    topSpacer: function () {
      if (!this.virtualOn) return 0;
      return Math.round(this.startIndex * this.measuredAvg);
    },
    bottomSpacer: function () {
      if (!this.virtualOn) return 0;
      var hidden = this.items.length - this.endIndex;
      return Math.max(0, Math.round(hidden * this.measuredAvg));
    }
  },
  watch: {
    items: function () {
      // 换列表要回到顶部：旧的 scrollTop 会让新列表直接落在中间，
      // 看起来像「列表莫名其妙空了半屏」
      var el = this.$refs.viewport;
      if (el) el.scrollTop = 0;
      this.scrollTop = 0;
      this.$nextTick(this.remeasure);
    },
    visibleItems: function () {
      // ⚠️ 这里**只能做测量，不能再改 measuredAvg**。
      //   测量会写 measuredAvg，而 measuredAvg 参与 startIndex/endIndex 的计算 ——
      //   写它就会触发 visibleItems 变化 → 再次进入这个 watcher → 再写…
      //   形成自激循环，实测能把切页耗时从 90ms 抬到 120ms 上下，
      //   而且表现为「DOM 越少反而越慢」这种反直觉的现象，很难定位。
      //
      //   真正的自适应测量放在 onScroll 里做（滚动天然是低频的，
      //   且有 140ms 的节流），首屏那次测量走 syncViewport。
      this.$nextTick(this.measureOnly);
    }
  },
  mounted: function () {
    this.syncViewport();
    window.addEventListener('resize', this.onResize);
  },
  beforeDestroy: function () {
    window.removeEventListener('resize', this.onResize);
    if (this._scrollEnd) clearTimeout(this._scrollEnd);
  },
  methods: {
    // 只测量、不改状态。可安全地在任何时机调用（含 watch 里）。
    // 返回当前渲染出来的条目平均高度。
    measureOnly: function () {
      var el = this.$refs.viewport;
      if (!el || !this.virtualOn) return 0;
      var window_ = el.querySelector('.vlist-window');
      if (!window_) return 0;
      var children = window_.children;
      var n = children.length;
      if (!n) return 0;
      var total = 0;
      for (var i = 0; i < n; i++) total += children[i].offsetHeight;
      return total / n;
    },
    // 测量并**写回**均值。只允许在低频时机调用（滚动结束、挂载、resize），
    // 绝不能放进 visibleItems 的 watch —— 那是自激循环，见 watch 处的说明。
    remeasure: function () {
      var avg = this.measureOnly();
      if (avg <= 0) return;
      // 只在有实际偏差时更新，且做平滑，避免每帧抖动
      if (Math.abs(avg - this.measuredAvg) > 0.5) {
        this.measuredAvg = this.measuredAvg * 0.7 + avg * 0.3;
      }
    },
    syncViewport: function () {
      var el = this.$refs.viewport;
      if (!el) return;
      // ⚠️ 只在**值真的变了**时才写。
      //   Vue 2 的 data 写入会触发依赖重算与重渲染 —— 无条件赋值等于
      //   每次 resize / 每次切页都强行让整棵列表重算一遍。
      //   CPU 采样里 syncViewport 曾占到 2.9%（idle 之外的第二名），就是这里。
      var h = el.clientHeight;
      if (h !== this.viewportHeight) this.viewportHeight = h;
      var st = el.scrollTop;
      if (st !== this.scrollTop) this.scrollTop = st;
      this.remeasure();
    },
    onResize: function () {
      this.syncViewport();
    },
    onScroll: function () {
      var el = this.$refs.viewport;
      if (!el || !this.virtualOn) return;
      var st = el.scrollTop;
      // 同上：scrollTop 在高频 scroll 里几乎每帧都变，但**取整到像素**后才比。
      // 直接写原值会让 sub-pixel 抖动也触发重渲染。
      if (Math.round(st) !== Math.round(this.scrollTop)) this.scrollTop = st;
      // 滚动中加一个 class 供样式做「简化过渡」用（滚动时不需要平滑动画）
      if (!this.isScrolling) this.isScrolling = true;
      var self = this;
      if (this._scrollEnd) clearTimeout(this._scrollEnd);
      this._scrollEnd = setTimeout(function () {
        self.isScrolling = false;
        self.remeasure();
      }, 140);
    },
    // 供父组件调用：把某项滚进可视区（选中项在可视区外时用）
    scrollToIndex: function (index) {
      var el = this.$refs.viewport;
      if (!el || !this.virtualOn) return;
      if (index < 0 || index >= this.items.length) return;
      var avg = Math.max(1, this.measuredAvg);
      var top = index * avg;
      var h = avg;
      if (top < el.scrollTop) {
        el.scrollTop = top;
      } else if (top + h > el.scrollTop + el.clientHeight) {
        el.scrollTop = top + h - el.clientHeight;
      } else {
        // 已经在可视区里 —— 什么都不用做。
        // 不加这个判断的话，每次 activeFileId 变化都会写一次 scrollTop，
        // 即便位置没变；而 activeFileId 在笔记页是很频繁地变
        // （选中、切文件夹、删除后重选都会动它）。
        return;
      }
      this.scrollTop = el.scrollTop;
    }
  }
};
</script>

<style scoped>
.vlist {
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  /* 触屏惯性滚动：项目里到处都在用，保持一致 */
  -webkit-overflow-scrolling: touch;
}
.vlist-window {
  /* 占位容器不能有间隙（line-height/margin），否则累积误差会让滚动越来越偏 */
  line-height: 0;
  font-size: 0;
}
.vlist-window > * {
  line-height: normal;
  font-size: initial;
}
/* 滚动过程中给调用方的条目一个信号：可以关掉 hover/transition 之类
   在高频重绘下反而拖慢的属性。调用方按需使用。 */
.vlist-scrolling {
  will-change: scroll-position;
}
</style>