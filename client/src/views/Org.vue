<template>
  <div class="org-page">
    <!-- ==================== 未登录：介绍 + 注册 + 登录 ==================== -->
    <template v-if="!isLoggedIn">
      <header class="hero">
        <h1 class="hero-title">Cluss Cloud · 多班公共服务</h1>
        <p class="hero-sub">
          一台公共服务端，服务所有 Cluss 部署者：注册学校 → 复制一段 .env 填到教室电脑 →
          各班的用量与额度就出现在你的看板里。学生内容永远不出本班设备。
        </p>
      </header>

      <ol class="steps">
        <li class="step-card">
          <span class="step-num">1</span>
          <div class="step-name">注册学校</div>
          <div class="step-desc">填学校名和管理员账号，立刻拿到编号与接入密钥</div>
        </li>
        <li class="step-card">
          <span class="step-num">2</span>
          <div class="step-name">复制 .env</div>
          <div class="step-desc">整块复制，粘到部署设备的 server/.env，重启即接入</div>
        </li>
        <li class="step-card">
          <span class="step-num">3</span>
          <div class="step-name">登录看板</div>
          <div class="step-desc">各班节点在线状态、用量账目、给谁充值，一页看清</div>
        </li>
      </ol>

      <!-- 注册成功：编号与 .env（这一步比表单更重要，做成主角） -->
      <section v-if="regResult" class="card card-accent">
        <div class="card-head">
          <h2 class="card-title">🎉 {{ regResult.org_name }} 开通成功</h2>
          <span class="badge badge-warn">接入密钥只显示这一次</span>
        </div>

        <div class="cred-list">
          <div v-for="c in credRows" :key="c.key" class="cred-row">
            <div class="cred-info">
              <span class="cred-label">{{ c.label }}</span>
              <span class="cred-value mono">{{ c.value }}</span>
            </div>
            <button class="btn btn-ghost btn-sm touch-target" type="button" @click="copyText(c.value, c.key)">
              {{ copiedKey === c.key ? '✓ 已复制' : '复制' }}
            </button>
          </div>
        </div>

        <div class="env-wrap">
          <div class="env-head">
            <span class="env-title">部署设备的 <code>server/.env</code>（整块复制即可，无需背记）</span>
            <button class="btn btn-primary btn-sm" type="button" @click="copyText(regResult.env_template, 'env')">
              {{ copiedKey === 'env' ? '✓ 已复制' : '复制整块' }}
            </button>
          </div>
          <pre class="env-block mono">{{ regResult.env_template }}</pre>
        </div>

        <button class="btn btn-primary" type="button" @click="goLogin(regResult.admin_user_id)">
          进入我的学校 →
        </button>
      </section>

      <div v-else class="two-col">
        <!-- 注册表单 -->
        <section class="card">
          <div class="card-head">
            <h2 class="card-title">注册学校</h2>
            <span class="badge">免费 · 即时生效</span>
          </div>
          <form @submit.prevent="handleRegister">
            <label class="field">
              <span class="field-label">学校名称 *</span>
              <input v-model="reg.school_name" class="input" type="text" placeholder="如：第一中学" />
            </label>
            <label class="field">
              <span class="field-label">省市（可选，仅做统计）</span>
              <input v-model="reg.region" class="input" type="text" placeholder="如：江苏南京" />
            </label>
            <div class="field-pair">
              <label class="field">
                <span class="field-label">管理员用户名 *</span>
                <input v-model="reg.admin_net_name" class="input" type="text" placeholder="登录用" autocapitalize="off" spellcheck="false" />
              </label>
              <label class="field">
                <span class="field-label">登录密码 *</span>
                <input v-model="reg.admin_password" class="input" type="password" placeholder="至少 8 位" autocomplete="new-password" />
              </label>
            </div>
            <p class="tiny muted">不收集真实姓名等个人信息；编号和密钥都是复制粘贴用的，不需要背。</p>
            <div v-if="regError" class="alert alert-danger">{{ regError }}</div>
            <button class="btn btn-primary btn-block" type="submit" :disabled="regLoading">
              {{ regLoading ? '注册中…' : '注册学校' }}
            </button>
          </form>
        </section>

        <!-- 已有学校：登录 -->
        <section class="card">
          <div class="card-head">
            <h2 class="card-title">管理员登录</h2>
          </div>
          <p class="section-sub">用户名或 5 位管理员编号 + 密码。登进来就能看本校各班的节点与账目。</p>
          <form @submit.prevent="handleLogin">
            <label class="field">
              <span class="field-label">账号</span>
              <input v-model="login.account" class="input" type="text" placeholder="用户名 / 管理员编号" autocapitalize="off" spellcheck="false" />
            </label>
            <label class="field">
              <span class="field-label">密码</span>
              <input v-model="login.password" class="input" type="password" placeholder="密码" autocomplete="current-password" />
            </label>
            <div v-if="loginError" class="alert alert-danger">{{ loginError }}</div>
            <button class="btn btn-primary btn-block" type="submit" :disabled="loginLoading">
              {{ loginLoading ? '登录中…' : '登录' }}
            </button>
          </form>
          <p class="tiny muted">普通学生的账号在本班设备上注册，与这里无关。</p>
        </section>
      </div>
    </template>

    <!-- ==================== 已登录：学校管理员视角 ==================== -->
    <template v-else>
      <div v-if="whoamiLoading" class="card muted center">加载中…</div>

      <!-- 不是学校管理员 -->
      <div v-else-if="!isAdmin" class="card">
        <h2 class="card-title">这里只服务学校管理员</h2>
        <p class="section-sub">
          当前账号（{{ userName }}）不是任何学校的管理员。
          如果你是部署者，请用注册学校时设置的管理员用户名（或 5 位编号）登录；
          还没有学校？<a class="link" href="#" @click.prevent="switchToGuest">退出登录后先注册一所</a>。
        </p>
      </div>

      <!-- 学校看板 -->
      <template v-else>
        <header class="dash-head">
          <div class="dash-title">
            <h1 class="hero-title">{{ org.name }}</h1>
            <span class="chip mono" @click="copyText(org.id, 'orgid')" :title="'点击复制学校编号'">
              {{ org.id }} <span v-if="copiedKey === 'orgid'">✓</span>
            </span>
            <span v-if="org.region" class="chip">{{ org.region }}</span>
          </div>
          <button class="btn btn-ghost" type="button" @click="loadAll">↻ 刷新</button>
        </header>

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

        <!-- 分区页签：节点 / 台账 / 流水 -->
        <div class="seg" role="tablist">
          <button
            v-for="t in tabs" :key="t.id" type="button" role="tab"
            class="seg-item" :class="{ 'seg-active': activeTab === t.id }"
            :aria-selected="activeTab === t.id"
            @click="activeTab = t.id"
          >{{ t.label }}<span v-if="t.count !== undefined" class="seg-count">{{ t.count }}</span></button>
        </div>

        <!-- ======== 班级节点 ======== -->
        <section v-show="activeTab === 'nodes'" class="card">
          <div class="card-head">
            <h2 class="card-title">班级节点</h2>
            <span class="tiny muted">在线 = 最近 {{ Math.round(onlineWindowSec / 60) }} 分钟内有同步；用量数据延迟约 5 分钟</span>
          </div>

          <div v-if="!nodes.length" class="empty">
            <div class="empty-icon">📡</div>
            <div class="empty-title">还没有班级接入</div>
            <div class="empty-desc">把注册时给的 .env 整块填到教室电脑的 server/.env，重启服务即可。</div>
          </div>
          <div v-else class="node-grid">
            <div v-for="n in nodes" :key="n.instance_id" class="node-card" :class="{ 'node-revoked': n.status !== 'active' }">
              <div class="node-top">
                <span class="node-dot" :class="dotClass(n)"></span>
                <div class="node-name-wrap">
                  <div class="node-name">{{ n.label || n.instance_id }}</div>
                  <div class="tiny mono muted">{{ n.instance_id }}</div>
                </div>
                <span v-if="n.status !== 'active'" class="badge badge-danger">已吊销</span>
                <span v-else-if="n.online" class="badge badge-ok">在线</span>
                <span v-else class="badge badge-warn">失联</span>
              </div>
              <div class="node-meta">
                <span>版本 {{ n.node_version || '?' }}</span>
                <span>配置到达 额度v{{ n.last_assign_version }} / 模型v{{ n.last_model_version }}</span>
                <span>最后上报 {{ n.last_report_at ? relTime(n.last_report_at) : '从未' }}</span>
              </div>
              <div class="node-foot">
                <div class="node-cost">
                  <b>¥{{ yuan(n.month_cost_micro) }}</b><span class="tiny muted"> 本月</span>
                  <span class="tiny muted">· 累计 ¥{{ yuan(n.cost_micro) }} / {{ n.calls }} 次</span>
                </div>
                <div class="node-actions">
                  <button class="btn btn-ghost btn-sm" type="button" @click="renameNode(n)">备注</button>
                  <button v-if="n.status === 'active'" class="btn btn-ghost btn-sm danger-text" type="button" @click="revokeNode(n)">吊销</button>
                  <button v-else class="btn btn-ghost btn-sm" type="button" @click="restoreNode(n)">恢复</button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ======== 额度台账 ======== -->
        <section v-show="activeTab === 'ledger'" class="card">
          <div class="card-head">
            <h2 class="card-title">额度台账</h2>
            <input v-model="studentKeyword" class="input input-sm kw-input" type="text" placeholder="按学号筛选…" @input="debouncedLoadStudents" />
          </div>
          <p class="section-sub">学生账号在本班设备上，这里按学号记账：分配 − 上报消耗 = 余额（分钟级延迟）。</p>

          <form class="topup-form" @submit.prevent="handleTopup">
            <input v-model="topup.user_id" class="input" type="text" placeholder="学号" autocapitalize="off" spellcheck="false" />
            <input v-model="topup.amount_yuan" class="input input-amount" type="number" min="0" step="0.01" placeholder="金额（元）" />
            <div class="preset-row">
              <button v-for="p in [1, 5, 10, 20]" :key="p" type="button" class="btn btn-ghost btn-sm" @click="topup.amount_yuan = String(p)">+{{ p }}元</button>
            </div>
            <input v-model="topup.weekly_quota_yuan" class="input input-amount" type="number" min="0" step="0.01" placeholder="周限额(元)" />
            <button class="btn btn-primary" type="submit" :disabled="topupLoading">{{ topupLoading ? '…' : '充值' }}</button>
          </form>
          <div v-if="topupMsg" class="alert" :class="topupOk ? 'alert-success' : 'alert-danger'">{{ topupMsg }}</div>

          <div class="table-scroll">
            <table class="plain-table">
              <thead>
                <tr><th>学号</th><th>分配</th><th>已用</th><th>余额</th><th>次数</th><th>最近使用</th></tr>
              </thead>
              <tbody>
                <tr v-for="s in students" :key="s.user_id">
                  <td class="mono">{{ s.user_id }}</td>
                  <td>¥{{ yuan(s.allocated_micro) }}</td>
                  <td>¥{{ yuan(s.used_micro) }}</td>
                  <td :class="s.balance_micro < 0 ? 'danger-text' : (s.balance_micro < 100000 ? 'warning-text' : 'success-text')">
                    ¥{{ yuan(s.balance_micro) }}
                  </td>
                  <td>{{ s.calls }}</td>
                  <td class="muted">{{ s.last_usage_at ? relTime(s.last_usage_at) : '—' }}</td>
                </tr>
                <tr v-if="!students.length">
                  <td colspan="6" class="muted center">还没有分配记录 —— 在上面给第一个学生充值吧</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ======== 额度流水 ======== -->
        <section v-show="activeTab === 'logs'" class="card">
          <div class="card-head">
            <h2 class="card-title">额度流水</h2>
            <span class="tiny muted">每笔充值/调整都有操作人与来源，可对账</span>
          </div>
          <div class="table-scroll">
            <table class="plain-table">
              <thead>
                <tr><th>时间</th><th>学号</th><th>变动</th><th>类型</th><th>说明</th><th>操作人</th></tr>
              </thead>
              <tbody>
                <tr v-for="l in logs" :key="l.id">
                  <td class="muted">{{ shortTime(l.created_at) }}</td>
                  <td class="mono">{{ l.user_id }}</td>
                  <td :class="l.amount_micro >= 0 ? 'success-text' : 'danger-text'">
                    {{ l.amount_micro >= 0 ? '+' : '' }}¥{{ yuan(l.amount_micro) }}
                  </td>
                  <td><span class="chip chip-sm">{{ kindText(l.kind) }}</span></td>
                  <td class="muted">{{ l.reason }}</td>
                  <td class="mono tiny muted">{{ l.operator_id }}</td>
                </tr>
                <tr v-if="!logs.length">
                  <td colspan="6" class="muted center">暂无流水</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<script>
import api from '@/utils/api';

// Cluss Cloud 公共服务页：
//   · 未登录 → 三步引导 + 注册学校（唯一公开表单）+ 管理员登录（页内完成）
//   · 学校管理员 → 本校看板（节点 / 台账 / 流水，页签切换）
// 刻意不做独立管理台——这就是公共服务的一个页面（routes/org.js 的前端）。
// 样式只用 global.css 的令牌与工具类，保证深浅色模式与全站一致。
export default {
  name: 'Org',
  data: function() {
    return {
      // 注册
      reg: { school_name: '', region: '', admin_net_name: '', admin_password: '' },
      regLoading: false,
      regError: '',
      regResult: null,
      // 页内登录
      login: { account: '', password: '' },
      loginLoading: false,
      loginError: '',
      // 复制反馈
      copiedKey: '',
      copiedTimer: null,
      // 看板
      whoamiLoading: true,
      isOrgAdmin: false,
      org: { id: '', name: '', region: '' },
      totals: { students: 0, allocated_micro: 0, used_micro: 0, calls: 0, month_cost_micro: 0 },
      nodes: [],
      onlineWindowSec: 600,
      activeTab: 'nodes',
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
    isLoggedIn: function() { return this.$store.getters['auth/isLoggedIn']; },
    userName: function() {
      var u = this.$store.state.auth.user;
      return u ? (u.net_name || u.user_id) : '';
    },
    isAdmin: function() { return this.isOrgAdmin; },
    tabs: function() {
      return [
        { id: 'nodes', label: '班级节点', count: this.nodes.length },
        { id: 'ledger', label: '额度台账', count: this.students.length },
        { id: 'logs', label: '额度流水' }
      ];
    },
    // 注册成功页的凭据行（编号短、密钥长，但都是复制用的）
    credRows: function() {
      var r = this.regResult;
      if (!r) return [];
      return [
        { key: 'org', label: '学校编号', value: r.org_id },
        { key: 'admin', label: '管理员编号', value: r.admin_user_id },
        { key: 'secret', label: '接入密钥', value: r.org_secret }
      ];
    }
  },
  mounted: function() {
    if (this.isLoggedIn) this.loadWhoami();
    else this.whoamiLoading = false;
  },
  beforeDestroy: function() {
    if (this.studentTimer) clearTimeout(this.studentTimer);
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
  },
  methods: {
    yuan: function(micro) {
      return (Number(micro || 0) / 1000000).toFixed(2);
    },
    shortTime: function(iso) {
      if (!iso) return '';
      return String(iso).replace('T', ' ').slice(5, 16);
    },
    relTime: function(iso) {
      if (!iso) return '';
      var s = String(iso);
      // 后端两种口径并存：toISO 的 '...T..Z' 与 nowUtc 的 'YYYY-MM-DD HH:MM:SS'（UTC 裸串）
      if (s.indexOf('T') >= 0) {
        if (!/(Z|z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
      } else {
        s = s.replace(' ', 'T') + 'Z';
      }
      var t = new Date(s).getTime();
      if (!isFinite(t)) return String(iso);
      var diff = Math.max(0, Date.now() - t);
      var m = Math.floor(diff / 60000);
      if (m < 1) return '刚刚';
      if (m < 60) return m + ' 分钟前';
      var h = Math.floor(m / 60);
      if (h < 24) return h + ' 小时前';
      return Math.floor(h / 24) + ' 天前';
    },
    kindText: function(k) {
      return { topup: '充值', adjust: '调整', revoke: '收回' }[k] || k;
    },
    dotClass: function(n) {
      if (n.status !== 'active') return 'dot-off';
      return n.online ? 'dot-on' : 'dot-idle';
    },

    // ---- 复制（页面所有敏感/长串都走复制，不做「让人背」的设计）----
    copyText: function(text, key) {
      var self = this;
      function done() {
        self.copiedKey = key;
        if (self.copiedTimer) clearTimeout(self.copiedTimer);
        self.copiedTimer = setTimeout(function() { self.copiedKey = ''; }, 1800);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      }
    },

    // ---- 注册 ----
    handleRegister: function() {
      var self = this;
      self.regError = '';
      if (!self.reg.school_name || !self.reg.admin_net_name || !self.reg.admin_password) {
        self.regError = '请填写带 * 的必填项';
        return;
      }
      if (self.reg.admin_password.length < 8) {
        self.regError = '管理员密码至少 8 位';
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
    // 注册成功 → 直接把管理员编号带进登录框
    goLogin: function(adminId) {
      this.login.account = adminId || '';
      this.regResult = null;
      window.scrollTo(0, 0);
    },
    // 非管理员账号点「先去注册」→ 退出登录回到注册态
    switchToGuest: function() {
      var self = this;
      this.$store.dispatch('auth/logout').then(function() {
        self.isOrgAdmin = false;
        self.whoamiLoading = false;
      });
    },

    // ---- 页内登录（复用全局会话，登录后全站可用）----
    handleLogin: function() {
      var self = this;
      self.loginError = '';
      if (!self.login.account || !self.login.password) {
        self.loginError = '请输入账号和密码';
        return;
      }
      self.loginLoading = true;
      this.$store.dispatch('auth/login', {
        account: self.login.account.trim(),
        password: self.login.password
      }).then(function() {
        self.loginLoading = false;
        self.loadWhoami();
      }).catch(function(err) {
        self.loginLoading = false;
        self.loginError = err.message || '登录失败，请重试';
      });
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
        // 403：登录了但不是学校管理员
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
        self.onlineWindowSec = d.online_window_sec || 600;
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
    // 搜索防抖：输入不停就别打接口
    debouncedLoadStudents: function() {
      var self = this;
      if (this.studentTimer) clearTimeout(this.studentTimer);
      this.studentTimer = setTimeout(function() { self.loadStudents(); }, 300);
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
          self.loadAll();
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
  max-width: 980px;
  margin: 0 auto;
  padding: var(--gap-lg);
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
}

/* ---- 头部 ---- */
.hero-title {
  font-size: 1.45rem;
  margin: 0 0 var(--gap-xs);
  color: var(--text-primary);
}
.hero-sub {
  color: var(--text-secondary);
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.6;
  max-width: 640px;
}

/* ---- 三步引导 ---- */
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--gap-md);
}
.step-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: var(--gap-md);
  box-shadow: var(--shadow-inset);
}
.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  margin-bottom: var(--gap-sm);
}
.step-name { font-weight: 600; margin-bottom: 2px; }
.step-desc { color: var(--text-secondary); font-size: 0.85rem; line-height: 1.5; }

/* ---- 卡片 ---- */
.card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  padding: var(--gap-lg);
  box-shadow: var(--shadow-card), var(--shadow-inset);
}
.card-accent { border-color: var(--accent); }
.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-md);
  flex-wrap: wrap;
  margin-bottom: var(--gap-md);
}
.card-title { font-size: 1.1rem; margin: 0; }
.section-sub { color: var(--text-secondary); font-size: 0.88rem; margin: 0 0 var(--gap-md); }

.two-col {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: var(--gap-lg);
  align-items: start;
}
@media (max-width: 760px) {
  .two-col { grid-template-columns: 1fr; }
}
.field { margin-bottom: var(--gap-md); }
.field-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap-md);
}
@media (max-width: 480px) {
  .field-pair { grid-template-columns: 1fr; }
}
.btn-block { width: 100%; }

/* ---- 徽标 / chip ---- */
.badge {
  font-size: 0.75rem;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  white-space: nowrap;
}
.badge-ok { background: var(--success-soft); color: var(--success-text, var(--success)); }
.badge-warn { background: var(--warning-soft); color: var(--warning-text, var(--warning)); }
.badge-danger { background: var(--danger-soft); color: var(--danger-text, var(--danger)); }
.chip {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  background: var(--glass-bg-soft);
  border: 1px solid var(--glass-border);
  font-size: 0.8rem;
  cursor: pointer;
}
.chip-sm { cursor: default; }

/* ---- 注册成功：凭据清单 ---- */
.cred-list {
  display: flex;
  flex-direction: column;
  margin-bottom: var(--gap-lg);
}
.cred-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: var(--gap-sm) 0;
  border-bottom: 1px dashed var(--glass-border-soft);
}
.cred-row:last-child { border-bottom: none; }
.cred-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cred-label { color: var(--text-secondary); font-size: 0.8rem; }
.cred-value { font-size: 1.02rem; word-break: break-all; }
.env-wrap { margin-bottom: var(--gap-lg); }
.env-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--gap-md);
  margin-bottom: var(--gap-sm);
  flex-wrap: wrap;
}
.env-title { color: var(--text-secondary); font-size: 0.85rem; }
.env-block {
  background: var(--accent-soft);
  border-radius: var(--radius-md);
  padding: var(--gap-md);
  font-size: 0.85rem;
  overflow-x: auto;
  margin: 0;
  color: var(--text-primary);
}

/* ---- 仪表盘头 + 统计 ---- */
.dash-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--gap-md);
  flex-wrap: wrap;
}
.dash-title { display: flex; align-items: center; gap: var(--gap-md); flex-wrap: wrap; }
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--gap-md);
}
.stat-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: var(--gap-md);
  text-align: center;
  box-shadow: var(--shadow-inset);
}
.stat-num { font-size: 1.3rem; font-weight: 600; color: var(--text-primary); }
.stat-label { color: var(--text-secondary); font-size: 0.8rem; margin-top: 2px; }

/* ---- 分区页签 ---- */
.seg {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--glass-bg-soft);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-pill);
  align-self: flex-start;
}
.seg-item {
  border: none;
  background: transparent;
  padding: 8px 18px;
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: 0.9rem;
  cursor: pointer;
  transition: background var(--dur-fast, 0.15s) var(--ease-out, ease-out);
}
.seg-item:hover { color: var(--text-primary); }
.seg-active {
  background: var(--accent);
  color: #fff;
}
.seg-count {
  display: inline-block;
  margin-left: 6px;
  font-size: 0.75rem;
  opacity: 0.85;
}

/* ---- 节点卡片 ---- */
.node-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--gap-md);
}
.node-card {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: var(--gap-md);
  background: var(--glass-bg-soft);
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}
.node-revoked { opacity: 0.6; }
.node-top { display: flex; align-items: flex-start; gap: var(--gap-sm); }
.node-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: 6px;
  flex: none;
}
.dot-on { background: var(--success); box-shadow: 0 0 0 3px var(--success-soft); }
.dot-idle { background: var(--warning); box-shadow: 0 0 0 3px var(--warning-soft); }
.dot-off { background: var(--text-secondary); opacity: 0.5; }
.node-name-wrap { flex: 1; min-width: 0; }
.node-name { font-weight: 600; }
.node-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--text-secondary);
  font-size: 0.8rem;
}
.node-foot {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--gap-sm);
  flex-wrap: wrap;
  margin-top: auto;
}
.node-cost b { font-size: 1.05rem; }
.node-actions { display: flex; gap: var(--gap-sm); }

/* ---- 台账 ---- */
.topup-form {
  display: flex;
  gap: var(--gap-sm);
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: var(--gap-md);
}
.topup-form .input { flex: 1 1 150px; min-width: 120px; }
.input-amount { max-width: 150px; flex: 0 1 auto !important; }
.preset-row { display: flex; gap: 4px; }
.kw-input { max-width: 220px; }
.input-sm { padding: 8px 10px; font-size: 0.9rem; }
.table-scroll { overflow-x: auto; }
.plain-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.plain-table th {
  text-align: left;
  color: var(--text-secondary);
  font-weight: 500;
  font-size: 0.8rem;
  padding: var(--gap-sm) var(--gap-sm);
  border-bottom: 1px solid var(--glass-border);
  white-space: nowrap;
}
.plain-table td { padding: var(--gap-sm); border-bottom: 1px solid var(--glass-border-soft); }
.plain-table tr:last-child td { border-bottom: none; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.muted { color: var(--text-secondary); }
.tiny { font-size: 0.78rem; }
.center { text-align: center; }
.danger-text { color: var(--danger-text, var(--danger)); }
.warning-text { color: var(--warning-text, var(--warning)); }
.success-text { color: var(--success-text, var(--success)); }
.link { color: var(--accent); cursor: pointer; }

/* ---- 空状态 ---- */
.empty { text-align: center; padding: var(--gap-xl) var(--gap-md); }
.empty-icon { font-size: 2rem; margin-bottom: var(--gap-sm); }
.empty-title { font-weight: 600; margin-bottom: 4px; }
.empty-desc { color: var(--text-secondary); font-size: 0.88rem; }
</style>
