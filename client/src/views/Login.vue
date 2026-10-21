<template>
  <div class="auth-page">
    <div class="auth-shell">
      <!-- 左侧品牌区：大标题 + 特性列表 -->
      <aside class="brand-pane">
        <div class="brand-head">
          <ClussLogo :size="56" />
          <div>
            <div class="brand-name">Cluss</div>
            <div class="brand-tag">引导式 AI 解题</div>
          </div>
        </div>

        <h1 class="brand-title">不直接给答案，<br />陪你一步步想通。</h1>

        <ul class="brand-points">
          <li><span class="dot"></span>分层提示：先给方向，再给关键步骤</li>
          <li><span class="dot"></span>检查你的解法，指出错在哪一步</li>
          <li><span class="dot"></span>数学公式、代码块完整渲染</li>
        </ul>

        <div class="brand-foot">Cluss · 与 ClassIntra 账号互通</div>
      </aside>

      <!-- 右侧表单区 -->
      <section class="form-pane">
        <div class="form-head">
          <h2 class="form-title">欢迎回来</h2>
          <p class="form-sub">使用你的学号、用户名或姓名登录</p>
        </div>

        <form @submit.prevent="handleLogin">
          <label class="field">
            <span class="field-label">账号</span>
            <input
              v-model="account"
              class="input"
              :class="{ 'input-error': showError && !account }"
              type="text"
              placeholder="学号 / 用户名 / 姓名"
              autocomplete="username"
              autocapitalize="off"
              spellcheck="false"
            />
          </label>

          <label class="field">
            <span class="field-label">密码</span>
            <input
              v-model="password"
              class="input"
              :class="{ 'input-error': showError && !password }"
              :type="showPassword ? 'text' : 'password'"
              placeholder="请输入密码"
              autocomplete="current-password"
            />
          </label>

          <div v-if="errorMsg" class="alert alert-danger error-box">
            {{ errorMsg }}
          </div>

          <button class="btn btn-primary submit-btn" type="submit" :disabled="loading">
            {{ loading ? '登录中…' : '登 录' }}
          </button>
        </form>

        <div class="form-foot">
          <span class="muted tiny">还没有账号？</span>
          <router-link class="link" to="/register">立即注册</router-link>
        </div>

        <!-- 嵌入态：这里必须留一个返回出口。
             免登失败（CI 登录过期 / CI 暂时连不上）时学生会落到这一页，
             而他没有 Cluss 密码 —— 登录页又没有顶栏（返回按钮挂在顶栏里），
             少了这条链路就是死路一条。 -->
        <div v-if="isEmbedded" class="ci-hint">
          <span class="dot-info"></span>
          <span>正在 ClassIntra 中打开</span>
          <button type="button" class="link ci-back" @click="backToClassIntra">返回 ClassIntra</button>
        </div>
        <div v-else-if="ciHint" class="ci-hint">
          <span class="dot-info"></span>
          已接入 ClassIntra：可直接用 ClassIntra 账号登录
        </div>
      </section>
    </div>
  </div>
</template>

<script>
import ClussLogo from '@/components/ClussLogo.vue';
import { isEmbedded, backToClassIntra } from '@/utils/embedded';
// 「默认打开页」的唯一实现（另一个生效点在 router 的首次导航，见 utils/home-page）
import { resolveLanding } from '@/utils/home-page';

export default {
  name: 'LoginView',
  components: { ClussLogo },
  data: function() {
    return {
      account: '',
      password: '',
      showPassword: false,
      loading: false,
      showError: false,
      errorMsg: '',
      ciHint: false
    };
  },
  mounted: function() {
    // 探测是否接入 ClassIntra（联动部署时给出提示，独立部署不显示）
    // $http 的 baseURL 已是 /api，所以这里只能写 /health，写 /api/health 会拼成 /api/api/health
    var self = this;
    this.$http.get('/health').then(function(resp) {
      var data = resp.data && resp.data.data;
      self.ciHint = !!(data && data.ci_bridge_enabled);
    }).catch(function() { /* 探测失败不影响登录 */ });
  },
  computed: {
    // 嵌入态（被 ClassIntra 内嵌）：判据与出口都在 utils/embedded.js
    isEmbedded: isEmbedded
  },
  methods: {
    // 回到 ClassIntra 桌面（宿主未监听时静默，此时学生本就没别的路可走）
    backToClassIntra: backToClassIntra,

    handleLogin: function() {
      var self = this;
      this.errorMsg = '';
      this.showError = false;

      if (!this.account || !this.password) {
        this.showError = true;
        this.errorMsg = '请输入账号和密码';
        return;
      }

      this.loading = true;
      this.$store.dispatch('auth/login', {
        account: this.account.trim(),
        password: this.password
      }).then(function() {
        // 明确的来源跳转优先；`?redirect=/` 只是根路径的默认值，不算明确意图
        //（早先按 truthy 判断，于是它会盖掉「默认打开页」，设置等于没生效）
        var redirect = resolveLanding(self.$route.query.redirect);
        self.$router.replace(redirect);
      }).catch(function(err) {
        self.errorMsg = err.message || '登录失败，请重试';
      }).then(function() {
        self.loading = false;
      });
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
  /* 保留 gap-lg 的呼吸感，同时用安全区兜底：登录页没有顶栏，
     刘海/挖孔会直接压住品牌区，横屏时左侧挖孔也可能切到卡片边。
     无刘海设备上 max() 的结果仍等于 gap-lg，观感不变。 */
  padding: max(var(--gap-lg), env(safe-area-inset-top, 0px)) max(var(--gap-lg), env(safe-area-inset-right, 0px)) max(var(--gap-lg), env(safe-area-inset-bottom, 0px)) max(var(--gap-lg), env(safe-area-inset-left, 0px));
}

.auth-shell {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  width: 100%;
  max-width: 940px;
  border-radius: var(--radius-xl);
  overflow: hidden;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-float), var(--shadow-inset);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  backdrop-filter: blur(24px) saturate(1.4);
}

/* ---------- 品牌区 ---------- */
.brand-pane {
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
  padding: 44px 40px;
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
  letter-spacing: -0.01em;
}

.brand-tag {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.brand-title {
  margin: 0;
  font-size: 30px;
  line-height: 1.35;
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

/* ---------- 表单区 ---------- */
.form-pane {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 44px 40px;
}

.form-head {
  margin-bottom: var(--gap-lg);
}

.form-title {
  margin: 0 0 6px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.form-sub {
  margin: 0;
  font-size: 13.5px;
  color: var(--text-secondary);
}

.error-box {
  margin-bottom: var(--gap-md);
}

.submit-btn {
  width: 100%;
  margin-top: var(--gap-xs);
  padding: 13px;
  font-size: 15px;
}

.form-foot {
  margin-top: var(--gap-lg);
  display: flex;
  align-items: center;
  gap: 6px;
}
html.no-flex-gap .form-foot > * + * {
  margin-left: 6px;
}








.link {
  /* 「立即注册」是登录页唯一的次要操作，原来 13px 且 --accent 在 #eef1f8
     底色上只有 4.35:1（不达标）。改用更深的 --accent-hover（5.89:1），并随视口放大。 */
  font-size: clamp(13px, 11.176px + 0.19vw, 15px);
  color: var(--accent-hover);
  text-decoration: none;
  font-weight: 500;
}

@media (hover: hover) {
.link:hover {
  text-decoration: underline;
}
}


.ci-hint {
  margin-top: var(--gap-md);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
html.no-flex-gap .ci-hint > * + * {
  margin-left: 8px;
}

/* 嵌入态的返回出口：用 button 承载（不是链接），所以要把浏览器默认外观清干净，
   观感仍按链接走；触屏上命中区要够高，不然平板上点不准。 */
.ci-back {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 2px;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}








.dot-info {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
}

/* 窄屏：品牌区折叠为顶部条 */
@media (max-width: 820px) {
  .auth-shell {
    grid-template-columns: 1fr;
    max-width: 480px;
  }

  .brand-pane {
    padding: 26px 28px;
    border-right: none;
    border-bottom: 1px solid var(--glass-border-soft);
    gap: var(--gap-md);
  }

  .brand-title {
    font-size: 22px;
  }

  .brand-points,
  .brand-foot {
    display: none;
  }

  .form-pane {
    padding: 28px;
  }
}
</style>