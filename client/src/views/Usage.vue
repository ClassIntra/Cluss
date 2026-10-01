<template>
  <div class="usage-page">
    <AppNav active="usage" />

    <main class="body">
      <!-- 额度概况 -->
      <section class="wallet-row">
        <div class="wallet-card glass">
          <span class="section-label">可用余额</span>
          <div class="wallet-amount">
            <span class="wallet-symbol">¥</span>
            <span class="wallet-value" :class="{ 'wallet-empty': !wallet || !wallet.is_allocated }">
              {{ wallet ? wallet.available_yuan : '—' }}
            </span>
          </div>
          <div v-if="wallet" class="bar wallet-bar">
            <div class="bar-fill" :style="{ width: wallet.used_percent + '%' }"></div>
          </div>
          <div v-if="wallet" class="tiny muted">已用 ¥{{ wallet.used_yuan }} / 共 ¥{{ wallet.allocated_yuan }}</div>
          <div v-if="wallet && !wallet.is_allocated" class="alert alert-warning wallet-alert">
            尚未开通额度，请联系管理员充值
          </div>
        </div>

        <div class="wallet-card glass">
          <span class="section-label">本周用量</span>
          <div class="wallet-amount">
            <span class="wallet-value small">{{ wallet ? wallet.weekly_used_yuan : '—' }}</span>
            <span v-if="wallet && !wallet.weekly_unlimited" class="tiny muted">/ ¥{{ wallet.weekly_quota_yuan }}</span>
          </div>
          <div v-if="wallet && !wallet.weekly_unlimited" class="bar wallet-bar">
            <div class="bar-fill weekly-fill" :style="{ width: wallet.weekly_percent + '%' }"></div>
          </div>
          <div class="tiny muted">
            {{ wallet && wallet.weekly_unlimited ? '未设周限额' : '按周滚动统计（最近 7 天）' }}
          </div>
        </div>

        <div class="wallet-card glass">
          <span class="section-label">统计区间用量</span>
          <div class="wallet-amount">
            <span class="wallet-symbol">¥</span>
            <span class="wallet-value small">{{ totals.cost_yuan || '0.00' }}</span>
          </div>
          <div class="tiny muted">{{ totals.calls || 0 }} 次调用 · {{ formatTokens(totals.total_tokens) }} tokens</div>
        </div>
      </section>

      <div class="filters glass">
        <Segmented v-model="days" :options="dayOptions" />
        <Segmented v-model="groupBy" :options="groupOptions" />
        <button class="icon-btn" title="刷新" @click="loadAll">↻</button>
        <a class="btn btn-sm btn-ghost export-btn" :href="exportUrl" target="_blank">导出 CSV</a>
      </div>

      <div v-if="error" class="alert alert-danger">{{ error }}</div>

      <div class="panels">
        <!-- 趋势 / 分组柱状图 -->
        <section class="panel glass">
          <h2 class="panel-title">{{ groupBy === 'day' ? '每日消耗（元）' : (groupBy === 'model' ? '各模型消耗（元）' : '各类型消耗（元）') }}</h2>
          <UsageChart :items="items" field="cost_yuan" />
        </section>

        <!-- 分组明细 -->
        <section class="panel glass">
          <h2 class="panel-title">{{ groupTitle }}</h2>
          <div class="group-list">
            <div v-for="(item, idx) in items" :key="idx" class="group-row">
              <span class="group-key">{{ labelOf(item) }}</span>
              <span class="tiny muted">{{ item.calls }} 次</span>
              <span class="group-cost">¥{{ item.cost_yuan }}</span>
            </div>
            <div v-if="!items.length" class="empty-hint tiny">暂无数据</div>
          </div>
        </section>
      </div>

      <!-- 明细表 -->
      <section class="panel glass">
        <div class="panel-head">
          <h2 class="panel-title">调用明细</h2>
          <span class="tiny muted">共 {{ recordTotal }} 条</span>
        </div>

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>模型</th>
                <th class="num">输入</th>
                <th class="num">输出</th>
                <th class="num">图片</th>
                <th class="num">费用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in records" :key="r.id">
                <td class="nowrap tiny">{{ formatTime(r.created_at) }}</td>
                <td><span class="badge" :class="'src-' + r.source">{{ sourceLabel(r.source) }}</span></td>
                <td class="tiny">{{ r.model_label }}</td>
                <td class="num">{{ r.prompt_tokens }}</td>
                <td class="num">{{ r.completion_tokens }}</td>
                <td class="num">{{ r.image_count || '—' }}</td>
                <td class="num">{{ r.estimated ? '~' : '' }}¥{{ r.cost_yuan }}</td>
              </tr>
              <tr v-if="!records.length">
                <td colspan="7" class="empty-cell muted">暂无记录</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="recordPages > 1" class="pager">
          <button class="btn btn-sm btn-ghost" :disabled="page <= 1" @click="changePage(page - 1)">上一页</button>
          <span class="tiny muted">{{ page }} / {{ recordPages }}</span>
          <button class="btn btn-sm btn-ghost" :disabled="page >= recordPages" @click="changePage(page + 1)">下一页</button>
        </div>
      </section>
    </main>
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import Segmented from '@/components/Segmented.vue';
import UsageChart from '@/components/UsageChart.vue';

var SOURCE_LABELS = {
  chat: '对话',
  study: '学习',
  solve: '拍题',
  grade: '批改',
  vision_relay: '图片识别'
};

export default {
  name: 'UsageView',
  components: { AppNav, Segmented, UsageChart },
  data: function() {
    return {
      days: '7',
      groupBy: 'day',
      items: [],
      totals: {},
      records: [],
      recordTotal: 0,
      recordPages: 1,
      page: 1,
      error: ''
    };
  },
  computed: {
    wallet: function() { return this.$store.state.auth.wallet; },

    dayOptions: function() {
      return [
        { id: '7', label: '近 7 天' },
        { id: '30', label: '近 30 天' },
        { id: '90', label: '近 90 天' }
      ];
    },
    groupOptions: function() {
      return [
        { id: 'day', label: '按天' },
        { id: 'model', label: '按模型' },
        { id: 'source', label: '按类型' }
      ];
    },
    groupTitle: function() {
      return { day: '每日明细', model: '模型明细', source: '类型明细' }[this.groupBy] || '明细';
    },
    exportUrl: function() {
      var token = this.$store.state.auth.token;
      return '/api/usage/export.csv?days=' + this.days + '&token=' + encodeURIComponent(token);
    }
  },
  watch: {
    days: function() { this.loadAll(); },
    groupBy: function() { this.loadSummary(); }
  },
  mounted: function() {
    this.loadAll();
  },
  methods: {
    loadAll: function() {
      this.$store.dispatch('auth/fetchWallet').catch(function() {});
      this.loadSummary();
      this.page = 1;
      this.loadRecords();
    },

    loadSummary: function() {
      var self = this;
      this.error = '';
      return this.$http.get('/usage/summary', {
        params: { days: this.days, group_by: this.groupBy }
      }).then(function(r) {
        if (r.data.code !== 200) return;
        self.items = r.data.data.items || [];
        self.totals = r.data.data.totals || {};
        if (r.data.data.wallet) {
          self.$store.commit('auth/SET_WALLET', r.data.data.wallet);
        }
      }).catch(function(err) {
        self.error = err.message || '统计加载失败';
      });
    },

    loadRecords: function() {
      var self = this;
      return this.$http.get('/usage/records', {
        params: { days: this.days, page: this.page, limit: 50 }
      }).then(function(r) {
        if (r.data.code !== 200) return;
        self.records = r.data.data.items || [];
        self.recordTotal = r.data.data.total || 0;
        self.recordPages = r.data.data.total_pages || 1;
      }).catch(function() {});
    },

    changePage: function(p) {
      this.page = p;
      this.loadRecords();
    },

    labelOf: function(item) {
      if (this.groupBy === 'source') return SOURCE_LABELS[item.key] || item.key;
      return item.label || item.key;
    },

    sourceLabel: function(s) {
      return SOURCE_LABELS[s] || s || '对话';
    },

    formatTime: function(iso) {
      return String(iso || '').replace('T', ' ').slice(5, 16);
    },

    formatTokens: function(n) {
      var v = Number(n || 0);
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
      if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
      return String(v);
    }
  }
};
</script>

<style scoped>
.usage-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  padding: var(--gap-md);
  gap: var(--gap-md);
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  padding-bottom: var(--gap-md);
}

.wallet-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--gap-md);
  flex-shrink: 0;
}

.wallet-card {
  padding: 16px 18px;
  border-radius: var(--radius-lg);
}

.wallet-amount {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin: 6px 0 8px;
}

.wallet-symbol {
  font-size: 15px;
  color: var(--text-secondary);
}

.wallet-value {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.wallet-value.small {
  font-size: 22px;
}

.wallet-empty {
  color: var(--danger);
}

.wallet-bar {
  margin-bottom: 6px;
}

.weekly-fill {
  background: linear-gradient(90deg, #b9a2ff, #8b6bff);
}

.wallet-alert {
  margin-top: 8px;
  font-size: 12px;
}

.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.export-btn {
  margin-left: auto;
  text-decoration: none;
}

.icon-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.icon-btn:hover {
  background: rgba(31, 41, 72, 0.08);
  color: var(--text-primary);
}

.panels {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: var(--gap-md);
}

.panel {
  padding: 18px;
  border-radius: var(--radius-lg);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--gap-sm);
}

.panel-title {
  margin: 0 0 var(--gap-sm);
  font-size: 15px;
  font-weight: 600;
}

.panel-head .panel-title {
  margin-bottom: 0;
}

.group-list {
  max-height: 180px;
  overflow-y: auto;
}

.group-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 2px;
  border-bottom: 1px solid rgba(31, 41, 72, 0.05);
  font-size: 13px;
}

.group-key {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-cost {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.table-wrap {
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.table th {
  padding: 9px 10px;
  text-align: left;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid rgba(31, 41, 72, 0.08);
  white-space: nowrap;
}

.table td {
  padding: 9px 10px;
  border-bottom: 1px solid rgba(31, 41, 72, 0.05);
}

.nowrap {
  white-space: nowrap;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.empty-cell {
  padding: 22px;
  text-align: center;
}

.src-chat { background: var(--accent-soft); color: var(--accent); }
.src-study { background: #ede8ff; color: #6b4ee6; }
.src-solve { background: var(--success-soft); color: var(--success); }
.src-grade { background: var(--warning-soft); color: var(--warning); }
.src-vision_relay { background: rgba(31, 41, 72, 0.07); color: var(--text-secondary); }

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-md);
  margin-top: var(--gap-md);
}

@media (max-width: 900px) {
  .wallet-row {
    grid-template-columns: 1fr;
  }

  .panels {
    grid-template-columns: 1fr;
  }
}
</style>