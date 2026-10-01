<template>
  <div class="chart">
    <div v-if="!items.length" class="empty-hint tiny">暂无数据</div>

    <div v-else class="bars">
      <div v-for="(item, idx) in items" :key="idx" class="bar-col" :title="tooltip(item)">
        <div class="bar-track">
          <div class="bar-value" :style="{ height: heightOf(item) + '%' }"></div>
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

export default {
  name: 'UsageChart',
  props: {
    // [{ key, cost_yuan, calls, ... }]
    items: { type: Array, default: function() { return []; } },
    // 纵轴取哪个字段（默认费用）
    field: { type: String, default: 'cost_yuan' }
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

    tooltip: function(item) {
      return String(item.key || '') + '：¥' + (item.cost_yuan || '0.00') +
        '，' + (item.calls || 0) + ' 次';
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

.bar-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  height: 100%;
}

.bar-track {
  flex: 1;
  width: 100%;
  max-width: 44px;
  display: flex;
  align-items: flex-end;
  border-radius: 6px;
  background: var(--ink-1);
  overflow: hidden;
}

.bar-value {
  width: 100%;
  border-radius: 6px;
  background: linear-gradient(180deg, var(--chart-a), var(--chart-b));
  transition: height 0.4s cubic-bezier(0.32, 0.72, 0, 1);
}

.bar-label {
  color: var(--text-tertiary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
