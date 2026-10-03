<template>
  <div class="auth-page">
    <div class="auth-shell">
      <aside class="brand-pane">
        <div class="brand-head">
          <ClussLogo :size="48" />
          <div>
            <div class="brand-name">Cluss</div>
            <div class="brand-tag">引导式 AI 解题</div>
          </div>
        </div>

        <h1 class="brand-title">注册即可使用，<br />无需等待审核。</h1>

        <ul class="brand-points">
          <li><span class="dot"></span>填写真实姓名与班级，自动分配学号</li>
          <li><span class="dot"></span>登录后联系管理员开通额度</li>
          <li><span class="dot"></span>与 ClassIntra 账号体系互通</li>
        </ul>

        <div class="brand-foot">学号规则：年份后两位 + 班级 + 班内编号</div>
      </aside>

      <section class="form-pane">
        <!-- 注册成功：展示分配到的学号（这是学生日后登录的凭据，要显眼） -->
        <div v-if="registered" class="success-pane">
          <div class="success-icon">✓</div>
          <h2 class="form-title">注册成功</h2>
          <p class="form-sub">请记下你的学号，之后可以用它登录</p>

          <div class="student-id-card">
            <div class="student-id-label">你的学号</div>
            <div class="student-id-value">{{ registered.user_id }}</div>
            <div class="student-id-meta">
              {{ registered.real_name }} · {{ registered.enrollment_year }} 年入学 ·
              {{ registered.class_no }} 班
            </div>
          </div>

          <div class="alert alert-info">
            账号已可用。使用 AI 功能前，请先联系管理员为你的账号开通额度。
          </div>

          <button class="btn btn-primary submit-btn" @click="goChat">
            进入 Cluss
          </button>
        </div>

        <template v-else>
          <div class="form-head">
            <h2 class="form-title">创建账号</h2>
            <p class="form-sub">所有字段均为必填，学号将根据年份与班级自动生成</p>
          </div>

          <form @submit.prevent="handleRegister">
            <div class="field-row">
              <label class="field">
                <span class="field-label">真实姓名</span>
                <input
                  v-model="form.real_name"
                  class="input"
                  type="text"
                  placeholder="如 张小明"
                  maxlength="24"
                />
              </label>

              <label class="field">
                <span class="field-label">用户名（登录用）</span>
                <input
                  v-model="form.net_name"
                  class="input"
                  type="text"
                  placeholder="给自己起个名字"
                  maxlength="24"
                  autocapitalize="off"
                  spellcheck="false"
                />
              </label>
            </div>

            <div class="field-row">
              <label class="field">
                <span class="field-label">入学年份</span>
                <input
                  v-model="form.enrollment_year"
                  class="input"
                  type="text"
                  inputmode="numeric"
                  placeholder="如 2025"
                  maxlength="4"
                />
              </label>

              <label class="field">
                <span class="field-label">班级</span>
                <input
                  v-model="form.class_no"
                  class="input"
                  type="text"
                  inputmode="numeric"
                  placeholder="如 3"
                  maxlength="2"
                />
              </label>
            </div>

            <div class="id-preview" :class="{ 'id-preview-ready': idPreview }">
              <span class="id-preview-label">预计学号</span>
              <span class="id-preview-value">{{ idPreview || '待填写' }}</span>
              <span class="id-preview-note tiny muted">年份后两位 + 班级 + 班内编号</span>
            </div>

            <label class="field">
              <span class="field-label">密码</span>
              <input
                v-model="form.password"
                class="input"
                type="password"
                placeholder="至少 8 位，需包含字母和数字"
                autocomplete="new-password"
              />
            </label>

            <label class="field">
              <span class="field-label">确认密码</span>
              <input
                v-model="form.confirm_password"
                class="input"
                type="password"
                placeholder="再输入一次"
                autocomplete="new-password"
              />
            </label>

            <div v-if="errorMsg" class="alert alert-danger error-box">{{ errorMsg }}</div>

            <button class="btn btn-primary submit-btn" type="submit" :disabled="loading">
              {{ loading ? '注册中…' : '注 册' }}
            </button>
          </form>

          <div class="form-foot">
            <span class="muted tiny">已经有账号？</span>
            <router-link class="link" to="/login">去登录</router-link>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script>
import ClussLogo from '@/components/ClussLogo.vue';

export default {
  name: 'RegisterView',
  components: { ClussLogo },
  data: function() {
    return {
      form: {
        real_name: '',
        net_name: '',
        enrollment_year: '',
        class_no: '',
        password: '',
        confirm_password: ''
      },
      loading: false,
      errorMsg: '',
      registered: null
    };
  },
  computed: {
    // 实时预览学号前缀（年份后两位 + 班级），班内编号由后端分配所以显示为 --
    idPreview: function() {
      var year = String(this.form.enrollment_year || '').trim();
      var cls = String(this.form.class_no || '').trim();
      var yy = '';
      if (/^\d{4}$/.test(year)) yy = year.slice(2);
      else if (/^\d{2}$/.test(year)) yy = year;
      if (!yy) return '';

      var nn = '';
      if (/^\d{1,2}$/.test(cls)) {
        var n = parseInt(cls, 10);
        if (n >= 1 && n <= 99) nn = n < 10 ? '0' + n : String(n);
      }
      return yy + (nn || '??') + '--';
    }
  },
  methods: {
    handleRegister: function() {
      var self = this;
      this.errorMsg = '';

      var f = this.form;
      if (!f.real_name || !f.net_name || !f.enrollment_year || !f.class_no || !f.password) {
        this.errorMsg = '请填写全部必填字段';
        return;
      }
      if (f.password !== f.confirm_password) {
        this.errorMsg = '两次输入的密码不一致';
        return;
      }

      this.loading = true;
      this.$store.dispatch('auth/register', {
        real_name: f.real_name.trim(),
        net_name: f.net_name.trim(),
        enrollment_year: f.enrollment_year.trim(),
        class_no: f.class_no.trim(),
        password: f.password,
        confirm_password: f.confirm_password
      }).then(function(data) {
        self.registered = data.user_info;
        self.$store.dispatch('toast', { message: '注册成功', type: 'success' });
      }).catch(function(err) {
        self.errorMsg = err.message || '注册失败，请重试';
      }).then(function() {
        self.loading = false;
      });
    },

    goChat: function() {
      this.$router.replace('/');
    }
  }
};
</script>

<style scoped>
.auth-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: var(--app-height);
  padding: var(--gap-lg);
  overflow-y: auto;
}

.auth-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  width: 100%;
  max-width: 980px;
  border-radius: var(--radius-xl);
  overflow: hidden;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-float), var(--shadow-inset);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  backdrop-filter: blur(24px) saturate(1.4);
}

.brand-pane {
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
  padding: 44px 36px;
  background: var(--brand-wash);
  border-right: 1px solid var(--glass-border-soft);
}
html.no-flex-gap .brand-pane > * + * {
  margin-top: var(--gap-lg);
}



.brand-head {
  display: flex;
  align-items: center;
  gap: 14px;
}
html.no-flex-gap .brand-head > * + * {
  margin-left: 14px;
}



.brand-name {
  font-size: 20px;
  font-weight: 600;
}

.brand-tag {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.brand-title {
  margin: 0;
  font-size: 27px;
  line-height: 1.4;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.brand-points {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13.5px;
  color: var(--text-secondary);
}
html.no-flex-gap .brand-points > * + * {
  margin-top: 12px;
}



.brand-points li {
  display: flex;
  align-items: center;
  gap: 10px;
}
html.no-flex-gap .brand-points li > * + * {
  margin-left: 10px;
}



.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}

.brand-foot {
  margin-top: auto;
  font-size: 12px;
  color: var(--text-tertiary);
}

.form-pane {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 40px 40px;
}

.form-head {
  margin-bottom: var(--gap-md);
}

.form-title {
  margin: 0 0 6px;
  font-size: 23px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.form-sub {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap-md);
}

/* 学号预览：让学生注册前就知道自己的学号长什么样 */
.id-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  margin-bottom: var(--gap-md);
  border-radius: var(--radius-md);
  background: var(--ink-1);
  border: 1px dashed var(--ink-4);
}
html.no-flex-gap .id-preview > * + * {
  margin-left: 10px;
}



.id-preview-ready {
  background: var(--accent-soft);
  border-color: var(--accent-border);
  border-style: solid;
}

.id-preview-label {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.id-preview-value {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.05em;
  color: var(--accent);
}

.id-preview-note {
  margin-left: auto;
}

.error-box {
  margin-bottom: var(--gap-md);
}

.submit-btn {
  width: 100%;
  padding: 13px;
  font-size: 15px;
}

.form-foot {
  margin-top: var(--gap-md);
  display: flex;
  align-items: center;
  gap: 6px;
}
html.no-flex-gap .form-foot > * + * {
  margin-left: 6px;
}



.link {
  font-size: 13px;
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}

@media (hover: hover) {
.link:hover {
  text-decoration: underline;
}
}


/* ---------- 注册成功面板 ---------- */
.success-pane {
  text-align: center;
}

.success-icon {
  width: 56px;
  height: 56px;
  margin: 0 auto var(--gap-md);
  border-radius: 50%;
  background: var(--success-soft);
  color: var(--success);
  font-size: 26px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.student-id-card {
  margin: var(--gap-lg) 0;
  padding: 24px;
  border-radius: var(--radius-lg);
  background: var(--brand-wash);
  border: 1px solid var(--glass-border);
}

.student-id-label {
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.student-id-value {
  margin: 8px 0;
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

.student-id-meta {
  font-size: 13px;
  color: var(--text-secondary);
}

@media (max-width: 860px) {
  .auth-shell {
    grid-template-columns: 1fr;
    max-width: 520px;
  }

  .brand-pane {
    padding: 24px 26px;
    border-right: none;
    border-bottom: 1px solid var(--glass-border-soft);
    gap: var(--gap-md);
  }

  .brand-title {
    font-size: 21px;
  }

  .brand-points,
  .brand-foot {
    display: none;
  }

  .form-pane {
    padding: 26px;
  }

  .field-row {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>