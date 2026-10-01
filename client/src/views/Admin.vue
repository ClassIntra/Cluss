<template>
  <div class="admin-page">
    <AppNav active="admin" />

    <main class="body">
      <!-- 标签页 -->
      <div class="tabs glass">
        <Segmented v-model="tab" :options="tabOptions" />
        <span class="tiny muted tabs-note">{{ instanceLabel }}</span>
      </div>

      <div v-if="error" class="alert alert-danger">{{ error }}</div>

      <!-- ================= 学生额度 ================= -->
      <template v-if="tab === 'quota'">
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

        <section class="panel glass">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">学生额度</h2>
              <p class="panel-sub tiny muted">给账号分配额度后，各班级节点会在一个同步周期内自动生效</p>
            </div>
            <div class="panel-actions">
              <button class="btn btn-sm btn-ghost" @click="exportSnapshot">导出台账</button>
              <button class="btn btn-sm btn-ghost" @click="loadQuotaTab">刷新</button>
              <button class="btn btn-sm btn-primary" :disabled="!selected.length" @click="openBatch">
                批量充值（{{ selected.length }}）
              </button>
            </div>
          </div>

          <div class="filters-row">
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
                  <th class="col-check"><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
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
                  <td class="col-check"><input type="checkbox" :value="u.user_id" v-model="selected" /></td>
                  <td class="mono">{{ u.user_id }}</td>
                  <td>{{ u.real_name }}</td>
                  <td>{{ u.class_no || '--' }}</td>
                  <td class="num">¥{{ u.allocated_yuan }}</td>
                  <td class="num">¥{{ u.used_yuan }}</td>
                  <td class="num" :class="{ 'text-danger': Number(u.remaining_yuan) <= 0 }">¥{{ u.remaining_yuan }}</td>
                  <td class="num">{{ u.calls }}</td>
                  <td class="col-op">
                    <button class="btn btn-sm btn-ghost" @click="openSingle(u)">充值</button>
                  </td>
                </tr>
                <tr v-if="!filteredUsers.length">
                  <td colspan="9" class="empty-cell muted">{{ loading ? '读取中…' : '没有匹配的学生' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div class="bottom-grid">
          <section class="panel glass">
            <h2 class="panel-title">班级概览</h2>
            <div class="list-scroll">
              <div v-for="c in classes" :key="c.class_no" class="row-line">
                <span class="line-key">{{ c.class_no === '--' ? '未填班级' : c.class_no + ' 班' }}</span>
                <span class="tiny muted">{{ c.students }} 人</span>
                <span class="line-amount">¥{{ c.allocated_yuan }}</span>
              </div>
              <div v-if="!classes.length" class="empty-cell muted tiny">{{ loading ? '读取中…' : '暂无数据' }}</div>
            </div>
          </section>

          <section class="panel glass">
            <h2 class="panel-title">充值流水</h2>
            <div class="list-scroll">
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
              <div v-if="!logs.length" class="empty-cell muted tiny">{{ loading ? '读取中…' : '暂无流水' }}</div>
            </div>
          </section>
        </div>
      </template>

      <!-- ================= 模型与单价 ================= -->
      <template v-else-if="tab === 'models'">
        <section class="panel glass">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">模型与单价</h2>
              <p class="panel-sub tiny muted">
                改动即时生效，无需重启。单价单位为「元 / 百万 token」。
              </p>
            </div>
            <div class="panel-actions">
              <button class="btn btn-sm btn-ghost" @click="loadModels">刷新</button>
              <button class="btn btn-sm btn-primary" @click="openModelForm(null)">新增模型</button>
            </div>
          </div>

          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>API 地址</th>
                  <th class="num">输入价</th>
                  <th class="num">输出价</th>
                  <th class="num">缓存价</th>
                  <th>能力</th>
                  <th>状态</th>
                  <th class="col-op-wide">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in models" :key="m.id">
                  <td>
                    <div class="model-cell">
                      <span class="model-name">{{ m.label }}</span>
                      <span class="tiny muted mono">{{ m.id }}</span>
                    </div>
                  </td>
                  <td class="tiny muted addr-cell" :title="m.api_url">{{ m.api_url || '未配置' }}</td>
                  <td class="num">{{ m.price_in }}</td>
                  <td class="num">{{ m.price_out }}</td>
                  <td class="num">{{ m.price_cache_hit }}</td>
                  <td>
                    <span v-if="m.supports_vision" class="badge badge-accent">视觉</span>
                    <span v-if="m.is_free" class="badge badge-success">免费</span>
                    <span v-if="!m.supports_vision && !m.is_free" class="tiny muted">—</span>
                  </td>
                  <td>
                    <span v-if="m.is_default" class="badge badge-accent">默认</span>
                    <span v-if="!m.enabled" class="badge badge-danger">已禁用</span>
                    <span v-else-if="!m.has_api_key" class="badge badge-danger">缺 Key</span>
                    <span v-else-if="!m.is_default" class="badge badge-success">可用</span>
                  </td>
                  <td class="col-op-wide">
                    <button class="btn btn-sm btn-ghost" @click="openModelForm(m)">编辑</button>
                    <button
                      v-if="!m.is_default && m.enabled"
                      class="btn btn-sm btn-ghost"
                      @click="setDefault(m)"
                    >设默认</button>
                    <button class="btn btn-sm btn-ghost danger-text" @click="deleteModel(m)">删除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>

      <!-- ================= 视觉配置 ================= -->
      <template v-else-if="tab === 'vision'">
        <section class="panel glass">
          <h2 class="panel-title">看图能力</h2>
          <p class="panel-sub tiny muted">
            拍题解答与作业批改需要模型能看懂图片。模型本身支持视觉时直接传图；
            不支持时，用「转述模型」先把图片转成文字再回答。
          </p>

          <div v-if="!vision.sharp_available" class="alert alert-warning">
            服务器未安装 sharp 图片处理库，图片将不做压缩（原图直传，更慢也更费流量）。
            如需压缩，请在 server 目录执行 <code>npm install sharp</code>。
          </div>

          <div class="switch-list">
            <label class="switch-row">
              <input type="checkbox" v-model="vision.enabled" />
              <span>启用看图功能（关闭后拍题与批改入口不可用）</span>
            </label>
            <label class="switch-row">
              <input type="checkbox" v-model="vision.shrink_enabled" />
              <span>上传的图片自动压缩（手机照片常有 3~8MB，压缩后识别更快更省）</span>
            </label>
          </div>

          <label class="field">
            <span class="field-label">转述模型（用于不支持视觉的模型）</span>
            <select v-model="vision.relay_model_id" class="input">
              <option value="">不使用转述（只有支持视觉的模型能拍题）</option>
              <option v-for="m in relayCandidates" :key="m.id" :value="m.id">{{ m.label }}（{{ m.id }}）</option>
            </select>
            <span class="tiny muted field-note">
              只列出「已启用、配好 Key 且自身支持视觉」的模型。
            </span>
          </label>

          <div class="row-3">
            <label class="field">
              <span class="field-label">单次最多图片数</span>
              <input v-model="vision.max_images" class="input" type="number" min="1" max="6" />
            </label>
            <label class="field">
              <span class="field-label">压缩长边上限（px）</span>
              <input v-model="vision.image_max_edge" class="input" type="number" min="200" max="4096" />
            </label>
            <label class="field">
              <span class="field-label">压缩质量（1~100）</span>
              <input v-model="vision.image_quality" class="input" type="number" min="1" max="100" />
            </label>
          </div>

          <div class="panel-actions">
            <button class="btn btn-primary" :disabled="savingVision" @click="saveVision">
              {{ savingVision ? '保存中…' : '保存配置' }}
            </button>
          </div>
        </section>
      </template>

      <!-- ================= 用量统计 ================= -->
      <template v-else-if="tab === 'usage'">
        <div class="filters glass">
          <Segmented v-model="usageDays" :options="dayOptions" />
          <Segmented v-model="usageGroup" :options="usageGroupOptions" />
          <button class="icon-btn" title="刷新" @click="loadUsage">↻</button>
          <button class="btn btn-sm btn-ghost" @click="exportUsage">导出 CSV</button>
        </div>

        <section class="metrics">
          <div class="metric glass">
            <div class="metric-label">区间费用</div>
            <div class="metric-value">¥{{ usageTotals.cost_yuan || '0.00' }}</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">调用次数</div>
            <div class="metric-value">{{ usageTotals.calls || 0 }}</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">总 Token</div>
            <div class="metric-value">{{ formatTokens(usageTotals.total_tokens) }}</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">图片调用</div>
            <div class="metric-value">{{ usageTotals.image_count || 0 }}</div>
          </div>
        </section>

        <div class="panels">
          <section class="panel glass">
            <h2 class="panel-title">消耗趋势（元）</h2>
            <UsageChart :items="usageItems" field="cost_yuan" />
          </section>

          <section class="panel glass">
            <h2 class="panel-title">{{ usageGroupTitle }}</h2>
            <div class="list-scroll">
              <div v-for="(item, idx) in usageItems" :key="idx" class="row-line">
                <span class="line-key">{{ usageLabelOf(item) }}</span>
                <span class="tiny muted">{{ item.calls }} 次</span>
                <span class="line-amount">¥{{ item.cost_yuan }}</span>
              </div>
              <div v-if="!usageItems.length" class="empty-cell muted tiny">{{ usageLoading ? '读取中…' : '暂无数据' }}</div>
            </div>
          </section>
        </div>

        <section class="panel glass">
          <div class="panel-head">
            <h2 class="panel-title">调用明细</h2>
            <span class="tiny muted">共 {{ usageRecordTotal }} 条</span>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>学生</th>
                  <th>类型</th>
                  <th>模型</th>
                  <th class="num">输入</th>
                  <th class="num">输出</th>
                  <th class="num">图片</th>
                  <th class="num">费用</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in usageRecords" :key="r.id">
                  <td class="tiny nowrap">{{ (r.created_at || '').replace('T', ' ').slice(5, 16) }}</td>
                  <td class="tiny">{{ r.user_name }}</td>
                  <td><span class="badge">{{ sourceLabel(r.source) }}</span></td>
                  <td class="tiny">{{ r.model_label }}</td>
                  <td class="num">{{ r.prompt_tokens }}</td>
                  <td class="num">{{ r.completion_tokens }}</td>
                  <td class="num">{{ r.image_count || '—' }}</td>
                  <td class="num">{{ r.estimated ? '~' : '' }}¥{{ r.cost_yuan }}</td>
                </tr>
                <tr v-if="!usageRecords.length">
                  <td colspan="8" class="empty-cell muted">{{ usageLoading ? '读取中…' : '暂无记录' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </main>

    <!-- 充值弹窗 -->
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

    <!-- 模型编辑弹窗 -->
    <ModelForm
      v-if="modelFormOpen"
      :model="editingModel"
      @close="modelFormOpen = false"
      @saved="loadModels"
    />
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import Segmented from '@/components/Segmented.vue';
import UsageChart from '@/components/UsageChart.vue';
import ModelForm from '@/components/ModelForm.vue';

var SOURCE_LABELS = {
  chat: '对话', study: '学习', solve: '拍题', grade: '批改', vision_relay: '图片识别'
};

export default {
  name: 'AdminView',
  components: { AppNav, Segmented, UsageChart, ModelForm },
  data: function() {
    return {
      tab: 'quota',
      error: '',

      // 加载态：请求回来之前不要先摆出「没有匹配的学生 / 暂无流水」这种空态文案
      loading: true,
      usageLoading: true,

      // ---- 额度 ----
      dashboard: null,
      users: [],
      logs: [],
      keyword: '',
      classFilter: '',
      selected: [],
      quotaModal: {
        open: false, mode: 'single', userId: '', targetName: '',
        quotaYuan: '', weeklyYuan: '', reason: '', saving: false, error: ''
      },

      // ---- 模型 ----
      models: [],
      modelFormOpen: false,
      editingModel: null,

      // ---- 视觉 ----
      vision: {
        enabled: true, relay_model_id: '', max_images: 4,
        image_max_edge: 1568, image_quality: 80,
        shrink_enabled: true, sharp_available: true
      },
      relayCandidates: [],
      savingVision: false,

      // ---- 用量 ----
      usageDays: '7',
      usageGroup: 'user',
      usageItems: [],
      usageTotals: {},
      usageRecords: [],
      usageRecordTotal: 0
    };
  },
  computed: {
    tabOptions: function() {
      return [
        { id: 'quota', label: '学生额度' },
        { id: 'models', label: '模型与单价' },
        { id: 'vision', label: '视觉配置' },
        { id: 'usage', label: '用量统计' }
      ];
    },
    instanceLabel: function() {
      if (!this.dashboard) return '';
      return this.dashboard.instance_id + ' · ' + this.dashboard.mode + ' 模式';
    },
    classes: function() {
      return (this.dashboard && this.dashboard.by_class) || [];
    },
    filteredUsers: function() {
      var self = this;
      if (!this.classFilter) return this.users;
      return this.users.filter(function(u) { return (u.class_no || '--') === self.classFilter; });
    },
    allSelected: function() {
      return this.filteredUsers.length > 0 && this.selected.length === this.filteredUsers.length;
    },
    dayOptions: function() {
      return [
        { id: '7', label: '近 7 天' },
        { id: '30', label: '近 30 天' },
        { id: '90', label: '近 90 天' }
      ];
    },
    usageGroupOptions: function() {
      return [
        { id: 'user', label: '按学生' },
        { id: 'model', label: '按模型' },
        { id: 'source', label: '按类型' },
        { id: 'day', label: '按天' }
      ];
    },
    usageGroupTitle: function() {
      return { user: '学生明细', model: '模型明细', source: '类型明细', day: '每日明细' }[this.usageGroup] || '明细';
    }
  },
  watch: {
    tab: function(val) {
      // 切到某个标签才加载它的数据：避免进管理台就把三个大查询全跑一遍
      if (val === 'quota') this.loadQuotaTab();
      else if (val === 'models') this.loadModels();
      else if (val === 'vision') this.loadVision();
      else if (val === 'usage') this.loadUsage();
    },
    usageDays: function() { this.loadUsage(); },
    usageGroup: function() { this.loadUsageSummary(); }
  },
  mounted: function() {
    this.loadQuotaTab();
  },
  methods: {
    sourceLabel: function(s) { return SOURCE_LABELS[s] || s || '对话'; },

    formatTokens: function(n) {
      var v = Number(n || 0);
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
      if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
      return String(v);
    },

    // ---------- 额度 ----------
    loadQuotaTab: function() {
      var self = this;
      this.error = '';
      this.loading = true;
      // 三个请求各自已 catch，不会 reject；都收尾后再关掉加载态，
      // 否则请求回来前会先闪一句「没有匹配的学生」
      return Promise.all([
        this.loadDashboard(), this.loadUsers(), this.loadLogs()
      ]).then(function() {
        self.loading = false;
      });
    },

    loadDashboard: function() {
      var self = this;
      return this.$http.get('/admin/dashboard').then(function(r) {
        if (r.data.code === 200) self.dashboard = r.data.data;
      }).catch(function(err) {
        self.error = err.message || '总览加载失败';
      });
    },

    loadUsers: function() {
      var self = this;
      return this.$http.get('/admin/users', { params: { keyword: this.keyword, limit: 500 } }).then(function(r) {
        if (r.data.code === 200) {
          self.users = r.data.data.users || [];
          self.selected = [];
        }
      }).catch(function(err) {
        self.error = err.message || '加载失败';
      });
    },

    loadLogs: function() {
      var self = this;
      return this.$http.get('/admin/logs', { params: { limit: 60 } }).then(function(r) {
        if (r.data.code === 200) self.logs = r.data.data.logs || [];
      }).catch(function() {});
    },

    toggleAll: function(e) {
      this.selected = e.target.checked
        ? this.filteredUsers.map(function(u) { return u.user_id; })
        : [];
    },

    openSingle: function(u) {
      this.quotaModal = {
        open: true, mode: 'single', userId: u.user_id,
        targetName: u.real_name || u.net_name,
        quotaYuan: u.allocated_yuan === '0.00' ? '' : u.allocated_yuan,
        weeklyYuan: u.weekly_quota_yuan === '0.00' ? '' : u.weekly_quota_yuan,
        reason: '', saving: false, error: ''
      };
    },

    openBatch: function() {
      if (!this.selected.length) return;
      this.quotaModal = {
        open: true, mode: 'batch', userId: '', targetName: '',
        quotaYuan: '', weeklyYuan: '', reason: '', saving: false, error: ''
      };
    },

    closeQuota: function() { this.quotaModal.open = false; },

    submitQuota: function() {
      var self = this;
      var m = this.quotaModal;
      if (m.quotaYuan === '' || isNaN(Number(m.quotaYuan))) {
        m.error = '请填写正确的额度金额';
        return;
      }

      m.saving = true;
      m.error = '';

      var req;
      if (m.mode === 'batch') {
        var items = this.selected.map(function(uid) {
          return {
            user_id: uid,
            quota_yuan: Number(m.quotaYuan),
            weekly_yuan: m.weeklyYuan === '' ? undefined : Number(m.weeklyYuan)
          };
        });
        req = this.$http.post('/admin/users/quota/batch', { items: items, reason: m.reason });
      } else {
        req = this.$http.put('/admin/users/' + m.userId + '/quota', {
          quota_yuan: Number(m.quotaYuan),
          weekly_yuan: m.weeklyYuan === '' ? undefined : Number(m.weeklyYuan),
          reason: m.reason
        });
      }

      req.then(function(r) {
        if (r.data.code !== 200) { m.error = r.data.message || '充值失败'; return; }
        self.$store.dispatch('toast', { message: r.data.message || '充值成功', type: 'success' });
        m.open = false;
        self.selected = [];
        self.loadQuotaTab();
      }).catch(function(err) {
        m.error = err.message || '充值失败';
      }).then(function() {
        m.saving = false;
      });
    },

    // ---------- 模型 ----------
    loadModels: function() {
      var self = this;
      this.error = '';
      return this.$http.get('/admin/models').then(function(r) {
        if (r.data.code === 200) self.models = r.data.data.models || [];
      }).catch(function(err) {
        self.error = err.message || '模型列表加载失败';
      });
    },

    openModelForm: function(m) {
      this.editingModel = m;
      this.modelFormOpen = true;
    },

    setDefault: function(m) {
      var self = this;
      this.$http.post('/admin/models/' + m.id + '/set-default', {}).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '操作失败');
        self.$store.dispatch('toast', { message: '已设为默认模型', type: 'success' });
        self.loadModels();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '操作失败', type: 'error' });
      });
    },

    deleteModel: function(m) {
      var self = this;
      if (!window.confirm('确定删除模型「' + m.label + '」？\n若已被会话使用，将改为禁用而非删除。')) return;

      this.$http.delete('/admin/models/' + m.id).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
        self.$store.dispatch('toast', { message: r.data.message, type: 'success' });
        self.loadModels();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '删除失败', type: 'error' });
      });
    },

    // ---------- 视觉 ----------
    loadVision: function() {
      var self = this;
      this.error = '';
      return this.$http.get('/admin/vision').then(function(r) {
        if (r.data.code !== 200) return;
        var d = r.data.data;
        self.vision = {
          enabled: d.enabled,
          relay_model_id: d.relay_model_id || '',
          max_images: d.max_images,
          image_max_edge: d.image_max_edge,
          image_quality: d.image_quality,
          shrink_enabled: d.shrink_enabled,
          sharp_available: d.sharp_available
        };
        self.relayCandidates = d.relay_candidates || [];
      }).catch(function(err) {
        self.error = err.message || '视觉配置加载失败';
      });
    },

    saveVision: function() {
      var self = this;
      this.savingVision = true;
      this.error = '';
      this.$http.put('/admin/vision', {
        enabled: this.vision.enabled,
        relay_model_id: this.vision.relay_model_id,
        max_images: Number(this.vision.max_images),
        image_max_edge: Number(this.vision.image_max_edge),
        image_quality: Number(this.vision.image_quality),
        shrink_enabled: this.vision.shrink_enabled
      }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '保存失败');
        self.$store.dispatch('toast', { message: '配置已保存，即时生效', type: 'success' });
        self.loadVision();
      }).catch(function(err) {
        self.error = err.message || '保存失败';
      }).then(function() {
        self.savingVision = false;
      });
    },

    // ---------- 用量 ----------
    loadUsage: function() {
      var self = this;
      this.usageLoading = true;
      return Promise.all([
        this.loadUsageSummary(), this.loadUsageRecords()
      ]).then(function() {
        self.usageLoading = false;
      });
    },

    loadUsageSummary: function() {
      var self = this;
      return this.$http.get('/admin/usage/summary', {
        params: { days: this.usageDays, group_by: this.usageGroup }
      }).then(function(r) {
        if (r.data.code !== 200) return;
        self.usageItems = r.data.data.items || [];
        self.usageTotals = r.data.data.totals || {};
      }).catch(function() {});
    },

    loadUsageRecords: function() {
      var self = this;
      return this.$http.get('/admin/usage/records', {
        params: { days: this.usageDays, limit: 50 }
      }).then(function(r) {
        if (r.data.code !== 200) return;
        self.usageRecords = r.data.data.items || [];
        self.usageRecordTotal = r.data.data.total || 0;
      }).catch(function() {});
    },

    usageLabelOf: function(item) {
      if (this.usageGroup === 'source') return SOURCE_LABELS[item.key] || item.key;
      if (this.usageGroup === 'user') return (item.label || item.key) + (item.class_no ? '（' + item.class_no + '班）' : '');
      return item.label || item.key;
    },

    // ---------- 导出 ----------
    download: function(url, filename) {
      var token = this.$store.state.auth.token;
      fetch(url, {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        credentials: 'same-origin'
      }).then(function(resp) {
        if (!resp.ok) throw new Error('导出失败');
        return resp.blob();
      }).then(function(blob) {
        var objUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = objUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objUrl);
      }).catch(function() {
        window.alert('导出失败，请重试');
      });
    },

    exportSnapshot: function() {
      this.download('/api/admin/snapshot', 'cluss-snapshot.csv');
    },

    exportUsage: function() {
      this.download('/api/admin/usage/export.csv?days=' + this.usageDays, 'cluss-usage.csv');
    }
  }
};
</script>

<style scoped>
.admin-page {
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

.tabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: 8px 14px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.tabs-note {
  white-space: nowrap;
}

/* ---------- 指标卡 ---------- */
.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--gap-md);
  flex-shrink: 0;
}

.metric {
  padding: 16px 18px;
  border-radius: var(--radius-lg);
}

.metric-label {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.metric-value {
  margin-top: 5px;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

/* ---------- 面板 ---------- */
.panel {
  padding: 18px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
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
  line-height: 1.5;
}

.panel-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  margin-top: var(--gap-md);
}

.panel-head .panel-actions {
  margin-top: 0;
}

.filters-row {
  display: flex;
  gap: 10px;
  margin-bottom: var(--gap-md);
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

.filter-input {
  flex: 1;
}

.filter-select {
  max-width: 180px;
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
  background: var(--ink-2);
  color: var(--text-primary);
}

/* ---------- 表格 ---------- */
.table-wrap {
  overflow-x: auto;
  margin: 0 -4px;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.table th {
  padding: 9px 11px;
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
  padding: 10px 11px;
  border-bottom: 1px solid var(--ink-1);
  white-space: nowrap;
}

.table tbody tr:hover {
  background: var(--surface-1);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.nowrap {
  white-space: nowrap;
}

.col-check {
  width: 38px;
}

.col-op {
  width: 76px;
  text-align: right;
}

.col-op-wide {
  width: 200px;
  text-align: right;
}

.empty-cell {
  padding: 22px;
  text-align: center;
}

.text-danger {
  color: var(--danger);
}

.text-success {
  color: var(--success);
}

.danger-text:hover {
  color: var(--danger);
  background: var(--danger-tint);
}

.model-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.model-name {
  font-weight: 500;
}

.addr-cell {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 双栏 ---------- */
.bottom-grid,
.panels {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: var(--gap-md);
  flex-shrink: 0;
}

.list-scroll {
  max-height: 260px;
  overflow-y: auto;
}

.row-line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--ink-1);
  font-size: 13px;
}

.line-key {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.line-amount {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.log-row {
  padding: 9px 2px;
  border-bottom: 1px solid var(--ink-1);
}

.log-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.log-user {
  font-weight: 500;
}

.log-amount {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.log-meta {
  margin-top: 1px;
}

/* ---------- 视觉配置 ---------- */
.switch-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-bottom: var(--gap-md);
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
}

.switch-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}

.switch-row input {
  margin-top: 3px;
  flex-shrink: 0;
}

.field-note {
  display: block;
  margin-top: 4px;
}

.row-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--gap-md);
}

.panel code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--ink-2);
  font-size: 11.5px;
}

/* ---------- 弹窗 ---------- */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 350;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--gap-lg);
  background: var(--mask);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.modal {
  width: 100%;
  max-width: 420px;
  padding: 24px;
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
  background: var(--ink-1);
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

  .bottom-grid,
  .panels {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 700px) {
  .row-3 {
    grid-template-columns: 1fr;
    gap: 0;
  }

  .tabs-note {
    display: none;
  }
}
</style>