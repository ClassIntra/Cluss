<template>
  <div class="usage-page">
    <AppNav active="usage" />

    <main class="body">
      <!-- 额度概况 -->
      <section class="wallet-row">
        <div class="wallet-card glass">
          <span class="section-label">可用积分</span>
          <div class="wallet-amount">
            <span class="wallet-value" :class="{ 'wallet-empty': !wallet || !wallet.is_allocated }">
              {{ wallet ? wallet.available_points : '—' }}
            </span>
            <span class="wallet-unit">积分</span>
          </div>
          <div v-if="wallet" class="bar wallet-bar">
            <div class="bar-fill" :style="{ width: wallet.used_percent + '%' }"></div>
          </div>
          <!-- 同 Chat：说「额度」不说「共」，可用值含同步容错 -->
          <div v-if="wallet" class="tiny muted">已用 {{ wallet.used_points }} 积分 · 额度 {{ wallet.allocated_points }} 积分</div>
          <div v-if="wallet && !wallet.is_allocated" class="alert alert-warning wallet-alert">
            还没有开通，请联系管理员充值
          </div>
        </div>

        <div class="wallet-card glass">
          <span class="section-label">本周用量</span>
          <div class="wallet-amount">
            <span class="wallet-value small">{{ wallet && !wallet.weekly_unlimited ? wallet.weekly_used_points : (wallet ? '不限' : '—') }}</span>
            <span v-if="wallet && !wallet.weekly_unlimited" class="tiny muted">/ {{ wallet.weekly_quota_points }} 积分</span>
          </div>
          <div v-if="wallet && !wallet.weekly_unlimited" class="bar wallet-bar">
            <div class="bar-fill weekly-fill" :style="{ width: wallet.weekly_percent + '%' }"></div>
          </div>
          <div class="tiny muted">
            {{ wallet && wallet.weekly_unlimited ? '未设周限额' : '按周滚动统计（最近 7 天）' }}
          </div>
        </div>

        <div class="wallet-card glass">
          <span class="section-label">统计区间消耗</span>
          <div class="wallet-amount">
            <span class="wallet-value small">{{ totals.cost_points || 0 }}</span>
            <span class="wallet-unit">积分</span>
          </div>
          <!-- 这里原来写的是「N 次调用 · X tokens」——token 是纯技术单位，
               学生既看不懂也不知道能用它做什么。改成他关心的：用了几次、看了几张图。 -->
          <div class="tiny muted">
            {{ totals.calls || 0 }} 次使用<span v-if="totals.image_count"> · 看了 {{ totals.image_count }} 张图</span>
          </div>
          <!-- 确定性感：行业经验是"不知道正常水位"比"花了多少"更让人不安。
               给一个静态参考区间（放在用量页而非对话页，避免常驻刺激），
               学生对上号了就不慌，对不上会主动来看明细。 -->
          <div class="tiny muted">参考：一轮引导对话通常 1~2 积分，拍题约 2 积分</div>
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
          <h2 class="panel-title">{{ groupBy === 'day' ? '每天用了多少（积分）' : '各类用途用了多少（积分）' }}</h2>
          <UsageChart :items="items" field="cost_points" unit="points" />
        </section>

        <!-- 分组明细 -->
        <section class="panel glass">
          <h2 class="panel-title">{{ groupTitle }}</h2>
          <div class="group-list">
            <div v-for="(item, idx) in items" :key="idx" class="group-row">
              <span class="group-key">{{ item.label || item.key }}</span>
              <span class="tiny muted">{{ item.calls }} 次</span>
              <span class="group-cost">{{ item.cost_points }} 积分</span>
            </div>
            <div v-if="!items.length" class="empty-hint tiny">{{ loading ? '读取中…' : '暂无数据' }}</div>
          </div>
        </section>
      </div>

      <!-- 明细表：这是"我的学习账单"，不是运维报表。
           token 数、缓存命中、模型名这些在服务端就已经裁掉了，前端拿不到。
           「做了什么」用的是会话标题 —— 学生看到"求最值"才知道那 12 积分花在哪。 -->
      <section class="panel glass">
        <div class="panel-head">
          <h2 class="panel-title">使用明细</h2>
          <span class="tiny muted">共 {{ recordTotal }} 条</span>
        </div>

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>做了什么</th>
                <th class="num">消耗</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in records" :key="r.id">
                <td class="nowrap tiny">{{ formatTime(r.created_at) }}</td>
                <td class="rec-what">
                  <span class="badge" :class="'src-' + r.source">{{ r.source_label }}</span>
                  <span v-if="r.title" class="rec-title">{{ r.title }}</span>
                  <span v-if="r.image_count" class="tiny muted">（{{ r.image_count }} 张图）</span>
                </td>
                <td class="num">{{ r.estimated ? '约 ' : '' }}{{ r.cost_points }}</td>
              </tr>
              <tr v-if="!records.length">
                <td colspan="3" class="empty-cell muted">{{ loading ? '读取中…' : '暂无记录' }}</td>
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
import { fmtLocal } from '@/utils/fmt-time';
import AppNav from '@/components/AppNav.vue';
import Segmented from '@/components/Segmented.vue';
import UsageChart from '@/components/UsageChart.vue';

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
      error: '',
      // 首次加载中：没有它的话，请求回来之前会先闪一下「暂无数据」，
      // 学生会以为自己的用量丢了
      loading: true
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
        { id: 'source', label: '按用途' }
      ];
    },
    groupTitle: function() {
      return { day: '每天明细', source: '各类用途明细' }[this.groupBy] || '明细';
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
      var self = this;
      this.$store.dispatch('auth/fetchWallet').catch(function() {});
      this.page = 1;
      this.loading = true;
      // 两个请求各自已 catch，不会 reject；都收尾后再关掉加载态
      return Promise.all([this.loadSummary(), this.loadRecords()]).then(function() {
        self.loading = false;
      });
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

    // 分组的可读名与「类型」的中文都由服务端给（见 usage-stats 的 student* 系列），
    // 前端不再自己维护一份映射表 —— 两处各写一份迟早会不一致。
    formatTime: function(iso) {
      return fmtLocal(iso, { short: true });
    }
  }
};
</script>

<style scoped>
.usage-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  /* 完全贴边：去掉固定留白，仅保留安全区边距（无刘海设备上为 0） */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  gap: var(--gap-md);
}
html.no-flex-gap .usage-page > * + * {
  margin-top: var(--gap-md);
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
html.no-flex-gap .body > * + * {
  margin-top: var(--gap-md);
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
html.no-flex-gap .wallet-amount > * + * {
  margin-left: 4px;
}






.wallet-unit {
  font-size: 13px;
  font-weight: 500;
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
  background: linear-gradient(90deg, var(--purple-a), var(--purple));
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
html.no-flex-gap .filters > * + * {
  margin-left: 10px;
}






.export-btn {
  margin-left: auto;
  text-decoration: none;
}

.icon-btn {
  width: clamp(28px, 19.36px + 0.9vw, 42px);
  height: clamp(28px, 19.36px + 0.9vw, 42px);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-tertiary);
  font-size: clamp(16px, 13.12px + 0.3vw, 21px);
  line-height: 1;
  cursor: pointer;
}

@media (hover: hover) {
.icon-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}
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
  border-bottom: 1px solid var(--ink-1);
  font-size: 13px;
}
html.no-flex-gap .group-row > * + * {
  margin-left: 10px;
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
  border-bottom: 1px solid var(--ink-2);
  white-space: nowrap;
}

.table td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--ink-1);
}

.nowrap {
  white-space: nowrap;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 「做了什么」列：徽章 + 会话标题。
   标题是学生当初那句提问，比任何技术字段都更能说明这笔积分花在哪。
   注意这里是 <td>，**不能**用 display:flex —— 那会让它不再是表格单元格，
   整列对齐会塌掉。用行内元素 + margin 即可。 */
.rec-what > * + * {
  margin-left: 8px;
}

.rec-title {
  display: inline-block;
  max-width: 340px;
  font-size: 12.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.empty-cell {
  padding: 22px;
  text-align: center;
}

.src-chat { background: var(--accent-soft); color: var(--accent); }
.src-study { background: var(--purple-soft); color: var(--purple-text); }
.src-solve { background: var(--success-soft); color: var(--success); }
.src-grade { background: var(--warning-soft); color: var(--warning); }
.src-writing,
.src-writing_generate,
.src-writing_grade,
.src-writing_outline { background: var(--pink-soft); color: var(--pink-text); }
.src-vision_relay { background: var(--ink-2); color: var(--text-secondary); }

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-md);
  margin-top: var(--gap-md);
}
html.no-flex-gap .pager > * + * {
  margin-left: var(--gap-md);
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