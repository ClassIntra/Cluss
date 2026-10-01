<template>
  <div class="admin-page">
    <header class="topbar glass">
      <router-link class="back-link" to="/">← 返回对话</router-link>
      <div class="topbar-title">
        <span class="page-title">Cluss 管理台</span>
        <span class="instance-badge tiny">{{ dashboard ? dashboard.instance_id : '' }}</span>
      </div>
      <div class="topbar-right tiny muted">
        {{ user.real_name }} · 管理员
      </div>
    </header>

    <div class="admin-body">
      <!-- 总览指标 -->
      <section class="metrics">
        <div class="metric glass">
          <div class="metric-label">学生数</div>
          <div class="metric-value">{{ (dashboard && dashboard.totals.users) || 0 }}</div>
        </div>
        <div class="metric glass">
          <div class="metric-label">已分配额度</div>
          <div class="metric-value">¥{{ (dashboard && dashboard.totals.allocated_yuan) || '0.00' }}</div>
        </div>
        <div class="metric glass">
          <div class="metric-label">已消耗</div>
          <div class="metric-value">¥{{ (dashboard && dashboard.totals.used_yuan) || '0.00' }}</div>
        </div>
        <div class="metric glass">
          <div class="metric-label">调用次数</div>
          <div class="metric-value">{{ (dashboard && dashboard.totals.calls) || 0 }}</div>
        </div>
      </section>

      <!-- 用户与额度管理 -->
      <section class="panel glass">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">学生额度</h2>
            <p class="panel-sub tiny muted">充值入口：给账号分配额度后，各班级节点会在一个同步周期内自动生效</p>
          </div>
          <div class="panel-actions">
            <button class="btn btn-sm btn-ghost" @click="exportCsv">导出台账</button>
            <button class="btn btn-sm btn-ghost" @click="loadAll">刷新</button>
            <button class="btn btn-sm btn-primary" :disabled="!selected.length" @click="openBatch">
              批量充值（{{ selected.length }}）
            </button>
          </div>
        </div>

        <div class="filters">
          <input
            v-model="keyword"
            class="input filter-input"
            type="text"
            placeholder="搜索学号 / 姓名 / 用户名"
            @keyup.enter="loadUsers"
          />
          <select v-model="classFilter" class="input filter-select">
            <option value="">全部班级</option>
            <option v-for="c in classes" :key="c.class_no" :value="c.class_no">
              {{ c.class_no === '--' ? '未填班级' : c.class_no + ' 班' }}（{{ c.students }} 人）
            </option>
          </select>
          <button class="btn btn-sm btn-primary" @click="loadUsers">搜索</button>
        </div>

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th class="col-check">
                  <input type="checkbox" :checked="allSelected" @change="toggleAll" />
                </th>
                <th>学号</th>
                <th>姓名</th>
                <th>班级</th>
                <th class="num">已分配</th>
                <th class="num">已消耗</th>
                <th class="num">余额</th>
                <th class="num">调用</th>
                <th class="col-op">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in filteredUsers" :key="u.user_id">
                <td class="col-check">
                  <input type="checkbox" :value="u.user_id" v-model="selected" />
                </td>
                <td class="mono">{{ u.user_id }}</td>
                <td>{{ u.real_name }}</td>
                <td>{{ u.class_no || '--' }}</td>
                <td class="num">¥{{ u.allocated_yuan }}</td>
                <td class="num">¥{{ u.used_yuan }}</td>
                <td class="num" :class="{ 'text-danger': Number(u.remaining_yuan) <= 0 }">
                  ¥{{ u.remaining_yuan }}
                </td>
                <td class="num">{{ u.calls }}</td>
                <td class="col-op">
                  <button class="btn btn-sm btn-ghost" @click="openSingle(u)">充值</button>
                </td>
              </tr>
              <tr v-if="!filteredUsers.length">
                <td colspan="9" class="empty-cell muted">没有匹配的学生</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="bottom-grid">
        <!-- 班级概览 -->
        <section class="panel glass">
          <div class="panel-head">
            <h2 class="panel-title">班级概览</h2>
          </div>
          <div class="class-list">
            <div v-for="c in classes" :key="c.class_no" class="class-row">
              <span class="class-name">{{ c.class_no === '--' ? '未填班级' : c.class_no + ' 班' }}</span>
              <span class="tiny muted">{{ c.students }} 人</span>
              <span class="class-amount">¥{{ c.allocated_yuan }}</span>
            </div>
            <div v-if="!classes.length" class="empty-cell muted tiny">暂无数据</div>
          </div>
        </section>

        <!-- 额度流水 -->
        <section class="panel glass">
          <div class="panel-head">
            <h2 class="panel-title">充值流水</h2>
          </div>
          <div class="log-list">
            <div v-for="l in logs" :key="l.id" class="log-row">
              <div class="log-main">
                <span class="log-user">{{ l.real_name || l.net_name || l.user_id }}</span>
                <span class="log-amount" :class="l.amount_micro >= 0 ? 'text-success' : 'text-danger'">
                  {{ l.amount_micro >= 0 ? '+' : '' }}{{ l.amount_yuan }}
                </span>
              </div>
              <div class="log-meta tiny muted">
                {{ l.kind }} · {{ l.reason || '无备注' }} · {{ (l.created_at || '').replace('T', ' ').slice(0, 16) }}
              </div>
            </div>
            <div v-if="!logs.length" class="empty-cell muted tiny">暂无流水</div>
          </div>
        </section>
      </div>
    </div>

    <!-- 充值弹窗（单个 / 批量共用） -->
    <transition name="fade">
      <div v-if="quotaModal.open" class="modal-mask" @click.self="closeQuota">
        <div class="modal glass">
          <h3 class="modal-title">
            {{ quotaModal.mode === 'batch' ? '批量充值' : '充值 · ' + quotaModal.targetName }}
          </h3>
          <p class="modal-sub tiny muted">
            {{ quotaModal.mode === 'batch'
              ? '已选择 ' + selected.length + ' 个学生，将分配相同额度'
              : '学号 ' + quotaModal.userId }}
          </p>

          <label class="field">
            <span class="field-label">分配额度（元）</span>
            <input v-model="quotaModal.quotaYuan" class="input" type="number" min="0" step="0.01" placeholder="如 30" />
          </label>

          <label class="field">
            <span class="field-label">周限额（元，选填）</span>
            <input v-model="quotaModal.weeklyYuan" class="input" type="number" min="0" step="0.01" placeholder="留空表示不限" />
          </label>

          <label class="field">
            <span class="field-label">备注（选填）</span>
            <input v-model="quotaModal.reason" class="input" type="text" placeholder="如：微信转账 30 元" />
          </label>

          <div class="modal-note tiny muted">
            分配的是「总额度」，学生按实际用量扣减；重复分配会覆盖原额度。
          </div>

          <div v-if="quotaModal.error" class="alert alert-danger">{{ quotaModal.error }}</div>

          <div class="modal-actions">
            <button class="btn btn-ghost" @click="closeQuota">取消</button>
            <button class="btn btn-primary" :disabled="quotaModal.saving" @click="submitQuota">
              {{ quotaModal.saving ? '提交中…' : '确认充值' }}
            </button>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
export default {
  name: 'AdminView',
  data: function() {
    return {
      dashboard: null,
      users: [],
      logs: [],
      keyword: '',
      classFilter: '',
      selected: [],
      quotaModal: {
        open: false,
        mode: 'single',
        userId: '',
        targetName: '',
        quotaYuan: '',
        weeklyYuan: '',
        reason: '',
        saving: false,
        error: ''
      }
    };
  },
  computed: {
    user: function() {
      return this.$store.state.auth.user || {};
    },
    classes: function() {
      return (this.dashboard && this.dashboard.by_class) || [];
    },
    filteredUsers: function() {
      var self = this;
      var list = this.users;
      // 班级筛选在前端做：用户列表已按额度排序，二次请求反而更慢
      if (this.classFilter) {
        list = list.filter(function(u) {
          return (u.class_no || '--') === self.classFilter;
        });
      }
      return list;
    },
    allSelected: function() {
      return this.filteredUsers.length > 0 && this.selected.length === this.filteredUsers.length;
    }
  },
  mounted: function() {
    this.loadAll();
  },
  methods: {
    loadAll: function() {
      this.loadDashboard();
      this.loadUsers();
      this.loadLogs();
    },

    loadDashboard: function() {
      var self = this;
      return this.$http.get('/admin/dashboard').then(function(resp) {
        if (resp.data.code === 200) self.dashboard = resp.data.data;
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '总览加载失败', type: 'error' });
      });
    },

    loadUsers: function() {
      var self = this;
      return this.$http.get('/admin/users', {
        params: { keyword: this.keyword, limit: 500 }
      }).then(function(resp) {
        if (resp.data.code === 200) {
          self.users = resp.data.data.users || [];
          // 列表刷新后清空勾选，避免选中项与显示项不一致
          self.selected = [];
        }
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '加载失败', type: 'error' });
      });
    },

    loadLogs: function() {
      var self = this;
      return this.$http.get('/admin/logs', { params: { limit: 60 } }).then(function(resp) {
        if (resp.data.code === 200) self.logs = resp.data.data.logs || [];
      }).catch(function() {});
    },

    toggleAll: function(e) {
      if (e.target.checked) {
        this.selected = this.filteredUsers.map(function(u) { return u.user_id; });
      } else {
        this.selected = [];
      }
    },

    openSingle: function(u) {
      this.quotaModal = {
        open: true,
        mode: 'single',
        userId: u.user_id,
        targetName: u.real_name || u.net_name,
        quotaYuan: u.allocated_yuan === '0.00' ? '' : u.allocated_yuan,
        weeklyYuan: u.weekly_quota_yuan === '0.00' ? '' : u.weekly_quota_yuan,
        reason: '',
        saving: false,
        error: ''
      };
    },

    openBatch: function() {
      if (!this.selected.length) return;
      this.quotaModal = {
        open: true,
        mode: 'batch',
        userId: '',
        targetName: '',
        quotaYuan: '',
        weeklyYuan: '',
        reason: '',
        saving: false,
        error: ''
      };
    },

    closeQuota: function() {
      this.quotaModal.open = false;
    },

    submitQuota: function() {
      var self = this;
      var m = this.quotaModal;
      if (m.quotaYuan === '' || isNaN(Number(m.quotaYuan))) {
        m.error = '请填写正确的额度金额';
        return;
      }

      m.saving = true;
      m.error = '';

      var request;
      if (m.mode === 'batch') {
        var items = this.selected.map(function(uid) {
          return { user_id: uid, quota_yuan: Number(m.quotaYuan), weekly_yuan: m.weeklyYuan === '' ? undefined : Number(m.weeklyYuan) };
        });
        request = this.$http.post('/admin/users/quota/batch', { items: items, reason: m.reason });
      } else {
        request = this.$http.put('/admin/users/' + m.userId + '/quota', {
          quota_yuan: Number(m.quotaYuan),
          weekly_yuan: m.weeklyYuan === '' ? undefined : Number(m.weeklyYuan),
          reason: m.reason
        });
      }

      request.then(function(resp) {
        if (resp.data.code !== 200) {
          m.error = resp.data.message || '充值失败';
          return;
        }
        self.$store.dispatch('toast', { message: resp.data.message || '充值成功', type: 'success' });
        m.open = false;
        self.selected = [];
        self.loadAll();
      }).catch(function(err) {
        m.error = err.message || '充值失败';
      }).then(function() {
        m.saving = false;
      });
    },

    exportCsv: function() {
      // 直接走浏览器下载：带 Authorization 头才能通过鉴权，所以用 fetch 取 blob
      var token = this.$store.state.auth.token;
      fetch('/api/admin/snapshot', {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        credentials: 'same-origin'
      }).then(function(resp) {
        if (!resp.ok) throw new Error('导出失败');
        return resp.blob();
      }).then(function(blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'cluss-snapshot.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }).catch(function() {
        this.$store.dispatch('toast', { message: '导出失败', type: 'error' });
      });
    }
  }
};
</script>

<style scoped>
.admin-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: var(--gap-md);
  gap: var(--gap-md);
}

.topbar {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: 12px 20px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.back-link {
  font-size: 13.5px;
  color: var(--text-secondary);
  text-decoration: none;
}

.back-link:hover {
  color: var(--accent);
}

.topbar-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.instance-badge {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
}

.topbar-right {
  margin-left: auto;
}

.admin-body {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  padding-bottom: var(--gap-md);
}

/* 指标卡 */
.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--gap-md);
}

.metric {
  padding: 18px 20px;
  border-radius: var(--radius-lg);
}

.metric-label {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.metric-value {
  margin-top: 6px;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

/* 面板 */
.panel {
  padding: 20px;
  border-radius: var(--radius-lg);
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--gap-md);
  margin-bottom: var(--gap-md);
}

.panel-title {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 600;
}

.panel-sub {
  margin: 0;
}

.panel-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.filters {
  display: flex;
  gap: 10px;
  margin-bottom: var(--gap-md);
}

.filter-input {
  flex: 1;
}

.filter-select {
  max-width: 180px;
}

/* 表格 */
.table-wrap {
  overflow-x: auto;
  margin: 0 -4px;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
}

.table th {
  padding: 10px 12px;
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid rgba(31, 41, 72, 0.08);
  white-space: nowrap;
}

.table td {
  padding: 11px 12px;
  border-bottom: 1px solid rgba(31, 41, 72, 0.05);
  white-space: nowrap;
}

.table tbody tr:hover {
  background: rgba(255, 255, 255, 0.5);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

.col-check {
  width: 40px;
}

.col-op {
  width: 80px;
  text-align: right;
}

.empty-cell {
  padding: 26px;
  text-align: center;
}

.text-danger {
  color: var(--danger);
}

.text-success {
  color: var(--success);
}

/* 底部双栏 */
.bottom-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  gap: var(--gap-md);
}

.class-list,
.log-list {
  max-height: 300px;
  overflow-y: auto;
}

.class-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid rgba(31, 41, 72, 0.05);
  font-size: 13.5px;
}

.class-name {
  flex-shrink: 0;
  min-width: 72px;
}

.class-amount {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.log-row {
  padding: 10px 4px;
  border-bottom: 1px solid rgba(31, 41, 72, 0.05);
}

.log-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13.5px;
}

.log-user {
  font-weight: 500;
}

.log-amount {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.log-meta {
  margin-top: 2px;
}

/* 弹窗 */
.modal-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--gap-lg);
  background: rgba(20, 24, 38, 0.28);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  z-index: 200;
}

.modal {
  width: 100%;
  max-width: 420px;
  padding: 26px;
  border-radius: var(--radius-xl);
}

.modal-title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}

.modal-sub {
  margin: 0 0 var(--gap-md);
}

.modal-note {
  margin: 4px 0 var(--gap-md);
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: rgba(31, 41, 72, 0.04);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: var(--gap-md);
}

@media (max-width: 1000px) {
  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .bottom-grid {
    grid-template-columns: 1fr;
  }
}
</style>