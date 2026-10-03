<template>
  <div class="chart">
    <div v-if="!items.length" class="empty-hint tiny">暂无数据</div>

    <div v-else class="bars">
      <div
        v-for="(item, idx) in items"
        :key="idx"
        class="bar-col"
        :class="{ 'is-active': idx === activeIdx }"
        role="button"
        :title="tooltip(item)"
        @click="activeIdx = activeIdx === idx ? -1 : idx"
      >
        <!-- 点按显示数值：title 属性在触屏上永远不出现（没有悬停），
             平板学生此前只能看到柱子高度，看不到具体积分与次数 -->
        <div v-if="idx === activeIdx" class="bar-tip tiny">{{ tooltip(item) }}</div>
        <div class="bar-track">
          <!-- 用 scaleY 而不是 height：一次要动几十根柱子，
               height 每帧都要重排，scaleY 只走合成层（见下方样式说明） -->
          <div class="bar-value" :style="{ transform: 'scaleY(' + (heightOf(item) / 100) + ')' }"></div>
        </div>
        <div class="bar-label tiny">{{ shortLabel(item.key) }}</div>
      </div>
    </div>
  </div>
</template>

<script>
// 纯 CSS 柱状图
//
// 为什么不用 ECharts / Chart.js：教室低端平板加载一个图表库要几百 KB，
// 而这里的图表只有「按天看趋势」一个用途，用 div 高度百分比画完全够。
// 少一个依赖 = 更快的首屏 + 更小的故障面。
//
// 数值查看：桌面靠 title 悬停；触屏上 title 永远不出现，所以柱子可点按，
// 点亮的柱子在其上方浮出数值气泡（再点同一根收起，点别的柱子切换）。

export default {
  name: 'UsageChart',
  props: {
    // [{ key, cost_yuan | cost_points, calls, ... }]
    items: { type: Array, default: function() { return []; } },
    // 纵轴取哪个字段（管理台传 cost_yuan，学生端传 cost_points）
    field: { type: String, default: 'cost_yuan' },
    // 单位口径：yuan（管理台，带 ¥）| points（学生端，带"积分"）
    unit: { type: String, default: 'yuan' }
  },
  data: function() {
    return {
      activeIdx: -1
    };
  },
  watch: {
    // 数据刷新（切分组 / 换月份）后，旧的下标可能指到不同的柱子，直接收起
    items: function() {
      this.activeIdx = -1;
    }
  },
  computed: {
    max: function() {
      var m = 0;
      for (var i = 0; i < this.items.length; i++) {
        var v = Number(this.items[i][this.field] || 0);
        if (v > m) m = v;
      }
      return m;
    }
  },
  methods: {
    heightOf: function(item) {
      var v = Number(item[this.field] || 0);
      if (this.max <= 0) return 2;
      // 最小 2% 让「有数据但很小」的柱子也可见，避免看起来像缺失
      return Math.max(2, Math.round(v / this.max * 100));
    },

    shortLabel: function(key) {
      var s = String(key || '');
      // 日期只显示「月-日」，完整日期在 title 里
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5);
      return s.length > 8 ? s.slice(0, 8) + '…' : s;
    },

    // 单位不能写死：学生端一旦看到 ¥，就会开始按"花了多少钱"衡量这次提问值不值
    tooltip: function(item) {
      var amount = this.unit === 'points'
        ? (Number(item[this.field] || 0) + ' 积分')
        : ('¥' + (item[this.field] || '0.00'));
      return String(item.key || '') + '：' + amount + '，' + (item.calls || 0) + ' 次';
    }
  }
};
</script>

<style scoped>
.chart {
  width: 100%;
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 140px;
  padding-top: 8px;
}
html.no-flex-gap .bars > * + * {
  margin-left: 6px;
}

.bar-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  height: 100%;
  position: relative;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
html.no-flex-gap .bar-col > * + * {
  margin-top: 6px;
}

/* 点亮的柱子整根提亮，气泡浮在它上方 */
.bar-col.is-active .bar-value {
  filter: brightness(1.18);
}

.bar-tip {
  position: absolute;
  bottom: calc(100% - 6px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  padding: 4px 9px;
  border-radius: var(--radius-pill);
  background: var(--mask-strong);
  color: var(--text-invert);
  white-space: nowrap;
  pointer-events: none;
  animation: popIn var(--dur-fast) var(--ease-out);
}

.bar-track {
  flex: 1;
  width: 100%;
  max-width: 44px;
  display: flex;
  align-items: flex-end;
  border-radius: var(--radius-2xs);
  background: var(--ink-1);
  overflow: hidden;
}

/* 用 transform: scaleY 做生长动画，而不是动 height。
   一屏可能有 30 根柱子同时长出来：动 height 意味着每帧 30 次重排 + 重绘，
   低端设备上就是肉眼可见的一顿；scaleY 在合成层完成，代价几乎为零。

   代价是圆角会跟着纵向缩放（顶端略扁），在 6px 小圆角上基本看不出来 ——
   拿这个换"加载时不卡"很划算。 */
.bar-value {
  width: 100%;
  height: 100%;
  transform-origin: bottom center;
  border-radius: var(--radius-2xs);
  background: linear-gradient(180deg, var(--chart-a), var(--chart-b));
  transition: transform var(--dur-slow) var(--ease-out);
}

.bar-label {
  color: var(--text-tertiary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
