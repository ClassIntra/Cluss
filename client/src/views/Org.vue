<template>
  <div class="org-page">
    <!-- ============ 未登录：公共服务介绍 + 登录提示 ============ -->
    <div v-if="!isLoggedIn" class="org-guest">
      <div class="org-hero">
        <h1 class="org-title">Cluss Cloud · 公共服务</h1>
        <p class="org-sub">
          多班部署的中枢服务：注册学校 → 拿到编号与密钥 → 填到部署设备的 .env →
          节点接入后，在这里就能看到各班的用量与额度。
        </p>
      </div>

      <!-- 注册学校：任何人可填，成功后展示接入信息 -->
      <section class="org-card">
        <h2 class="section-title">注册学校</h2>
        <p class="section-sub">注册即创建学校档案与管理员账号。接入密钥只显示一次，请当场保存。</p>

        <form @submit.prevent="handleRegister">
          <div class="form-grid">
            <label class="field">
              <span class="field-label">学校名称 *</span>
              <input v-model="reg.school_name" class="input" type="text" placeholder="如：第一中学" />
            </label>
            <label class="field">
              <span class="field-label">省市（可选）</span>
              <input v-model="reg.region" class="input" type="text" placeholder="如：江苏南京" />
            </label>
            <label class="field">
              <span class="field-label">管理员用户名 *</span>
              <input v-model="reg.admin_net_name" class="input" type="text" placeholder="登录用" />
            </label>
            <label class="field">
              <span class="field-label">管理员姓名 *</span>
              <input v-model="reg.admin_real_name" class="input" type="text" placeholder="真实姓名" />
            </label>
            <label class="field">
              <span class="field-label">管理员密码 *</span>
              <input v-model="reg.admin_password" class="input" type="password" placeholder="至少 8 位" autocomplete="new-password" />
            </label>
          </div>

          <div v-if="regError" class="alert alert-danger">{{ regError }}</div>
          <button class="btn btn-primary" type="submit" :disabled="regLoading">
            {{ regLoading ? '注册中…' : '注册学校' }}
          </button>
        </form>
      </section>

      <!-- 注册成功：编号与 .env 模板 -->
      <section v-if="regResult" class="org-card org-success">
        <h2 class="section-title">✅ {{ regResult.org_name }} 注册成功</h2>
        <div class="kv-grid">
          <div class="kv"><span class="kv-k">学校编号</span><span class="kv-v mono">{{ regResult.org_id }}</span></div>
          <div class="kv"><span class="kv-k">管理员编号</span><span class="kv-v mono">{{ regResult.admin_user_id }}</span></div>
          <div class="kv"><span class="kv-k">接入密钥</span><span class="kv-v mono">{{ regResult.org_secret }}</span></div>
        </div>
        <p class="section-sub">
          把下面整块填到部署设备的 <code>server/.env</code>，重启服务即完成接入。
          密钥泄露只影响本校，可联系平台重置。
        </p>
        <pre class="env-block">{{ regResult.env_template }}</pre>
        <button class="btn btn-ghost" type="button" @click="copyEnv">复制 .env 内容</button>
        <span v-if="copied" class="muted tiny">已复制</span>
        <p class="section-sub">之后用「管理员编号 + 密码」<router-link class="link" to="/login">登录</router-link>，回到本页即可看到学校看板。</p>
      </section>
    </div>

    <!-- ============ 已登录：学校管理员视角 ============ -->
    <div v-else class="org-dash">
      <div v-if="whoamiLoading" class="muted">加载中…</div>

      <!-- 不是学校管理员 -->
      <div v-else-if="!isAdmin" class="org-card">
        <h2 class="section-title">Cluss Cloud · 公共服务</h2>
        <p class="section-sub">
          当前账号（{{ userName }}）不是学校管理员。
          学校管理员请用注册时发放的「管理员编号」登录；
          还没注册学校的话，<router-link class="link" to="/login">换管理员账号登录</router-link>，或在本页未登录状态下注册。
        </p>
      </div>

      <!-- 学校看板 -->
      <template v-else>
        <div class="org-head">
          <div>
            <h1 class="org-title">{{ org.name }}</h1>
            <p class="org-sub mono">学校编号 {{ org.id }} <span v-if="org.region">· {{ org.region }}</span></p>
          </div>
          <button class="btn btn-ghost" type="button" @click="loadAll">刷新</button>
        </div>

        <!-- 汇总卡 -->
        <div class="stat-row">
          <div class="stat-card">
            <div class="stat-num">{{ totals.students }}</div>
            <div class="stat-label">已分配学生</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">¥{{ yuan(totals.allocated_micro) }}</div>
            <div class="stat-label">累计分配</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">¥{{ yuan(totals.used_micro) }}</div>
            <div class="stat-label">累计消耗</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">¥{{ yuan(totals.month_cost_micro) }}</div>
            <div class="stat-label">本月消耗</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ totals.calls }}</div>
            <div class="stat-label">调用次数</div>
          </div>
        </div>

        <!-- 班级节点 -->
        <section class="org-card">
          <h2 class="section-title">班级节点</h2>
          <p class="section-sub">数据延迟约 5 分钟（节点上报间隔）。在线 = 最近 10 分钟内有同步。</p>
          <div v-if="!nodes.length" class="muted">还没有节点接入。把注册时给的 .env 填到部署设备即可。</div>
          <div v-else class="node-list">
            <div v-for="n in nodes" :key="n.instance_id" class="node-row" :class="{ 'node-revoked': n.status !== 'active' }">
              <div class="node-main">
                <span class="node-dot" :class="n.status !== 'active' ? 'dot-off' : (n.online ? 'dot-on' : 'dot-idle')"></span>
                <div>
                  <div class="node-name">
                    {{ n.label || n.instance_id }}
                    <span v-if="n.label" class="muted tiny mono">{{ n.instance_id }}</span>
                    <span v-if="n.status !== 'active'" class="tag tag-danger">已吊销</span>
                  </div>
                  <div class="muted tiny">
                    <template v-if="n.status === 'active'">
                      {{ n.online ? '在线' : '失联' }}
                      · 版本 {{ n.node_version || '?' }}
                      · 配置到达 额度v{{ n.last_assign_version }}/模型v{{ n.last_model_version }}
                      · 最后上报 {{ n.last_report_at ? shortTime(n.last_report_at) : '从未' }}
                    </template>
                    <template v-else>吊销于 {{ shortTime(n.revoked_at || '') }}</template>
                  </div>
                </div>
              </div>
              <div class="node-side">
                <div class="node-cost">¥{{ yuan(n.cost_micro) }} <span class="muted tiny">/ 本月 ¥{{ yuan(n.month_cost_micro) }}</span></div>
                <div class="node-actions">
                  <button class="btn btn-ghost btn-sm" type="button" @click="renameNode(n)">备注</button>
                  <button v-if="n.status === 'active'" class="btn btn-ghost btn-sm" type="button" @click="revokeNode(n)">吊销</button>
                  <button v-else class="btn btn-ghost btn-sm" type="button" @click="restoreNode(n)">恢复</button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 额度台账 + 充值 -->
        <section class="org-card">
          <h2 class="section-title">额度台账</h2>
          <p class="section-sub">学生账号在本班设备上，这里按学号记账（分配 − 上报消耗 = 余额推算）。</p>

          <form class="topup-form" @submit.prevent="handleTopup">
            <input v-model="topup.user_id" class="input input-sm" type="text" placeholder="学号" />
            <input v-model="topup.amount_yuan" class="input input-sm" type="number" min="0" step="0.01" placeholder="金额（元）" />
            <input v-model="topup.weekly_quota_yuan" class="input input-sm" type="number" min="0" step="0.01" placeholder="周限额（元，可空）" />
            <button class="btn btn-primary btn-sm" type="submit" :disabled="topupLoading">
              {{ topupLoading ? '充值中…' : '充值' }}
            </button>
          </form>
          <div v-if="topupMsg" class="alert" :class="topupOk ? 'alert-success' : 'alert-danger'">{{ topupMsg }}</div>

          <input v-model="studentKeyword" class="input input-sm kw-input" type="text" placeholder="按学号筛选…" @input="loadStudents" />

          <table class="plain-table">
            <thead>
              <tr><th>学号</th><th>分配</th><th>已用</th><th>余额</th><th>次数</th><th>最近使用</th></tr>
            </thead>
            <tbody>
              <tr v-for="s in students" :key="s.user_id">
                <td class="mono">{{ s.user_id }}</td>
                <td>¥{{ yuan(s.allocated_micro) }}</td>
                <td>¥{{ yuan(s.used_micro) }}</td>
                <td :class="{ 'neg': s.balance_micro < 0 }">¥{{ yuan(s.balance_micro) }}</td>
                <td>{{ s.calls }}</td>
                <td class="muted">{{ s.last_usage_at ? shortTime(s.last_usage_at) : '—' }}</td>
              </tr>
              <tr v-if="!students.length">
                <td colspan="6" class="muted">暂无分配记录</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 流水 -->
        <section class="org-card">
          <h2 class="section-title">额度流水</h2>
          <table class="plain-table">
            <thead>
              <tr><th>时间</th><th>学号</th><th>变动</th><th>类型</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr v-for="l in logs" :key="l.id">
                <td class="muted">{{ shortTime(l.created_at) }}</td>
                <td class="mono">{{ l.user_id }}</td>
                <td :class="l.amount_micro >= 0 ? 'pos' : 'neg'">{{ l.amount_micro >= 0 ? '+' : '' }}¥{{ yuan(l.amount_micro) }}</td>
                <td>{{ kindText(l.kind) }}</td>
                <td class="muted">{{ l.reason }}</td>
              </tr>
              <tr v-if="!logs.length">
                <td colspan="5" class="muted">暂无流水</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </div>
  </div>
</template>

<script>
import api from '@/utils/api';

// Cluss Cloud 公共服务页：
//   · 未登录 → 注册学校（唯一公开表单）
//   · 学校管理员登录 → 本校看板（节点/台账/充值/流水）
// 刻意不做独立管理台——这就是公共服务的一个页面（routes/org.js 的前端）。
export default {
  name: 'Org',
  data: function() {
    return {
      reg: { school_name: '', region: '', admin_net_name: '', admin_real_name: '', admin_password: '' },
      regLoading: false,
      regError: '',
      regResult: null,
      copied: false,

      whoamiLoading: true,
      isOrgAdmin: false,
      org: { id: '', name: '', region: '' },
      totals: { students: 0, allocated_micro: 0, used_micro: 0, calls: 0, month_cost_micro: 0 },
      nodes: [],
      students: [],
      studentKeyword: '',
      studentTimer: null,
      topup: { user_id: '', amount_yuan: '', weekly_quota_yuan: '' },
      topupLoading: false,
      topupMsg: '',
      topupOk: false,
      logs: []
    };
  },
  computed: {
    isLoggedIn: function() { return this.$store.getters.isLoggedIn; },
    userName: function() {
      var u = this.$store.state.auth.user;
      return u ? (u.net_name || u.user_id) : '';
    },
    isAdmin: function() { return this.isOrgAdmin; }
  },
  mounted: function() {
    if (this.isLoggedIn) this.loadWhoami();
    else this.whoamiLoading = false;
  },
  methods: {
    yuan: function(micro) {
      return (Number(micro || 0) / 1000000).toFixed(2);
    },
    shortTime: function(iso) {
      if (!iso) return '';
      return String(iso).replace('T', ' ').slice(5, 16);
    },
    kindText: function(k) {
      return { topup: '充值', adjust: '调整', revoke: '收回' }[k] || k;
    },

    // ---- 注册 ----
    handleRegister: function() {
      var self = this;
      self.regError = '';
      if (!self.reg.school_name || !self.reg.admin_net_name || !self.reg.admin_password) {
        self.regError = '请填写带 * 的必填项';
        return;
      }
      self.regLoading = true;
      api.post('/org/register', self.reg).then(function(resp) {
        self.regLoading = false;
        if (resp.data.code !== 200) {
          self.regError = resp.data.message || '注册失败';
          return;
        }
        self.regResult = resp.data.data;
      }).catch(function(err) {
        self.regLoading = false;
        self.regError = (err.response && err.response.data && err.response.data.message) || err.message || '注册失败';
      });
    },
    copyEnv: function() {
      var self = this;
      if (!self.regResult) return;
      var text = self.regResult.env_template;
      function done() { self.copied = true; setTimeout(function() { self.copied = false; }, 2000); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      }
    },

    // ---- 学校看板 ----
    loadWhoami: function() {
      var self = this;
      self.whoamiLoading = true;
      api.get('/org/my/whoami').then(function(resp) {
        if (resp.data.code === 200) {
          self.isOrgAdmin = true;
          self.org = resp.data.data.org;
          self.loadAll();
        } else {
          self.isOrgAdmin = false;
          self.whoamiLoading = false;
        }
      }).catch(function() {
        // 401/403：不是学校管理员或未登录
        self.isOrgAdmin = false;
        self.whoamiLoading = false;
      });
    },
    loadAll: function() {
      var self = this;
      self.whoamiLoading = true;
      api.get('/org/my/overview').then(function(resp) {
        var d = resp.data.data || {};
        self.org = d.org || self.org;
        self.nodes = d.nodes || [];
        self.totals = d.totals || self.totals;
        self.whoamiLoading = false;
      }).catch(function() { self.whoamiLoading = false; });
      self.loadStudents();
      api.get('/org/my/logs').then(function(resp) {
        self.logs = (resp.data.data && resp.data.data.logs) || [];
      });
    },
    loadStudents: function() {
      var self = this;
      api.get('/org/my/students', { params: { keyword: self.studentKeyword } }).then(function(resp) {
        self.students = (resp.data.data && resp.data.data.students) || [];
      });
    },
    handleTopup: function() {
      var self = this;
      self.topupMsg = '';
      if (!self.topup.user_id || self.topup.amount_yuan === '') {
        self.topupMsg = '请填写学号与金额';
        self.topupOk = false;
        return;
      }
      self.topupLoading = true;
      api.post('/org/my/topup', {
        user_id: self.topup.user_id,
        amount_yuan: Number(self.topup.amount_yuan),
        weekly_quota_yuan: self.topup.weekly_quota_yuan === '' ? undefined : Number(self.topup.weekly_quota_yuan)
      }).then(function(resp) {
        self.topupLoading = false;
        if (resp.data.code === 200) {
          self.topupOk = true;
          self.topupMsg = resp.data.message || '已充值';
          self.topup = { user_id: '', amount_yuan: '', weekly_quota_yuan: '' };
          self.loadStudents();
          api.get('/org/my/logs').then(function(r) { self.logs = (r.data.data && r.data.data.logs) || []; });
        } else {
          self.topupOk = false;
          self.topupMsg = resp.data.message || '充值失败';
        }
      }).catch(function(err) {
        self.topupLoading = false;
        self.topupOk = false;
        self.topupMsg = (err.response && err.response.data && err.response.data.message) || err.message || '充值失败';
      });
    },

    // ---- 节点管理 ----
    renameNode: function(n) {
      var self = this;
      var label = window.prompt('节点备注名（如「高一3班」）：', n.label || '');
      if (label === null) return;
      api.put('/org/my/nodes/' + encodeURIComponent(n.instance_id), { label: label }).then(function() {
        n.label = label.trim();
      });
    },
    revokeNode: function(n) {
      var self = this;
      if (!window.confirm('确定吊销「' + (n.label || n.instance_id) + '」？该节点的同步将被拒绝。')) return;
      api.post('/org/my/nodes/' + encodeURIComponent(n.instance_id) + '/revoke').then(function() {
        self.loadAll();
      });
    },
    restoreNode: function(n) {
      var self = this;
      api.post('/org/my/nodes/' + encodeURIComponent(n.instance_id) + '/restore').then(function() {
        self.loadAll();
      });
    }
  }
};
</script>

<style scoped>
.org-page {
  max-width: 960px;
  margin: 0 auto;
  padding: var(--gap-lg);
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
}
.org-hero { padding: var(--gap-sm) 0; }
.org-title { font-size: 1.4rem; margin: 0 0 var(--gap-xs); }
.org-sub { color: var(--text-2); margin: 0; font-size: 0.92rem; }
.org-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  padding: var(--gap-lg);
  box-shadow: var(--shadow-card);
}
.section-title { font-size: 1.05rem; margin: 0 0 var(--gap-xs); }
.section-sub { color: var(--text-2); font-size: 0.85rem; margin: 0 0 var(--gap-md); }
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--gap-md);
  margin-bottom: var(--gap-md);
}
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 0.8rem; color: var(--text-2); }
.kv-grid { display: flex; flex-direction: column; gap: var(--gap-xs); margin-bottom: var(--gap-md); }
.kv { display: flex; gap: var(--gap-md); align-items: baseline; }
.kv-k { color: var(--text-2); font-size: 0.85rem; min-width: 72px; }
.kv-v { font-size: 0.95rem; word-break: break-all; }
.mono { font-family: var(--font-mono, monospace); }
.env-block {
  background: var(--code-bg, rgba(0, 0, 0, 0.08));
  border-radius: var(--radius-md);
  padding: var(--gap-md);
  font-family: var(--font-mono, monospace);
  font-size: 0.85rem;
  overflow-x: auto;
  margin: 0 0 var(--gap-md);
}
.org-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--gap-md); }
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: var(--gap-md);
}
.stat-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  padding: var(--gap-md);
  text-align: center;
}
.stat-num { font-size: 1.25rem; font-weight: 600; }
.stat-label { color: var(--text-2); font-size: 0.8rem; margin-top: 2px; }
.node-list { display: flex; flex-direction: column; }
.node-row {
  display: flex;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: var(--gap-md) 0;
  border-bottom: 1px solid var(--glass-border);
}
.node-row:last-child { border-bottom: none; }
.node-revoked { opacity: 0.55; }
.node-main { display: flex; gap: var(--gap-md); align-items: flex-start; }
.node-name { font-weight: 500; display: flex; align-items: center; gap: var(--gap-sm); flex-wrap: wrap; }
.node-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; flex: none; }
.dot-on { background: var(--success, #34c759); }
.dot-idle { background: var(--warning, #f5a623); }
.dot-off { background: var(--text-3, #999); }
.node-side { text-align: right; display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
.node-cost { font-weight: 500; }
.node-actions { display: flex; gap: var(--gap-sm); }
.tag { font-size: 0.72rem; padding: 1px 6px; border-radius: 99px; }
.tag-danger { background: rgba(220, 38, 38, 0.12); color: #dc2626; }
.topup-form { display: flex; gap: var(--gap-sm); flex-wrap: wrap; margin-bottom: var(--gap-md); }
.topup-form .input { flex: 1 1 140px; }
.input-sm { padding: 8px 10px; font-size: 0.9rem; }
.kw-input { max-width: 240px; margin-bottom: var(--gap-md); }
.plain-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.plain-table th {
  text-align: left;
  color: var(--text-2);
  font-weight: 500;
  font-size: 0.8rem;
  padding: 6px 8px;
  border-bottom: 1px solid var(--glass-border);
}
.plain-table td { padding: 8px; border-bottom: 1px solid var(--glass-border); }
.plain-table tr:last-child td { border-bottom: none; }
.pos { color: var(--success, #16a34a); }
.neg { color: #dc2626; }
.muted { color: var(--text-2); }
.tiny { font-size: 0.78rem; }
</style>
