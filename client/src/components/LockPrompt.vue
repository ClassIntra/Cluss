<template>
  <!--
    全局密码弹窗：隐藏会话与私密笔记共用的解锁入口。
    为什么不每个页面各写一个：三个地方要用（对话侧栏、笔记页、设置），
    各写一份必然出现"设置里已解锁、对话侧还锁着"的漂移；统一走
    store/lock 的 prompt，弹窗只有这一处。
  -->
  <transition name="fade">
    <div v-if="opts" class="lock-mask" @click.self="resolve(false)">
      <div class="modal lock-card glass" role="dialog" aria-modal="true">
        <h3 class="lock-title">{{ opts.mode === 'setup' ? '设置隐藏密码' : '输入隐藏密码' }}</h3>
        <p class="lock-sub tiny muted">
          <template v-if="opts.mode === 'setup'">
            一个问题会用到两处保护：隐藏的对话、笔记里的私密笔记。密码只保存加密后的形式，忘记无法找回。
          </template>
          <template v-else>
            解锁后 30 分钟内不用再输；锁着的时候，隐藏的内容不会出现在任何列表里。
          </template>
        </p>

        <template v-if="opts.mode === 'setup'">
          <input
            ref="pwd1"
            v-model="pwd1"
            class="input lock-input"
            type="password"
            maxlength="32"
            placeholder="密码（4~32 位）"
            autocomplete="new-password"
            @keyup.enter="submitSetup"
          />
          <input
            v-model="pwd2"
            class="input lock-input"
            type="password"
            maxlength="32"
            placeholder="再输一遍确认"
            autocomplete="new-password"
            @keyup.enter="submitSetup"
          />
        </template>
        <template v-else>
          <input
            ref="pwd1"
            v-model="pwd"
            class="input lock-input"
            type="password"
            maxlength="32"
            placeholder="隐藏密码"
            autocomplete="current-password"
            @keyup.enter="submitUnlock"
          />
        </template>

        <p v-if="error" class="lock-error tiny">{{ error }}</p>

        <div class="lock-actions">
          <button class="btn btn-ghost" type="button" @click="resolve(false)">取消</button>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="busy"
            @click="opts.mode === 'setup' ? submitSetup() : submitUnlock()"
          >{{ busy ? '请稍候…' : (opts.mode === 'setup' ? '设置并解锁' : '解锁') }}</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script>
export default {
  name: 'LockPrompt',
  computed: {
    opts: function() {
      return this.$store.state.lock.prompt;
    }
  },
  data: function() {
    return { pwd: '', pwd1: '', pwd2: '', error: '', busy: false, _prevFocus: null };
  },
  watch: {
    opts: function(now) {
      if (now) {
        this.pwd = '';
        this.pwd1 = '';
        this.pwd2 = '';
        this.error = '';
        this.busy = false;
        this.$_open();
      } else {
        this.$_close();
      }
    }
  },
  beforeDestroy: function() {
    document.removeEventListener('keydown', this._onKeydown);
  },
  methods: {
    resolve: function(val) {
      // 与 ConfirmDialog 同一约定：先关窗再兑现，界面立刻响应
      this.$store.dispatch('lock/resolvePrompt', val);
    },
    submitUnlock: function() {
      var self = this;
      if (!this.pwd) { this.error = '请输入密码'; return; }
      this.busy = true;
      this.$http.post('/private/verify', { password: this.pwd }).then(function(r) {
        var d = (r && r.data && r.data.data) || {};
        var unlocked = d.unlocked !== false;
        // 顺手刷新镜像状态：设置页的"已解锁"要与这里一致
        self.$store.commit('lock/SET_STATUS', { hasPassword: true, unlocked: unlocked });
        self.resolve(unlocked);
      }).catch(function(e) {
        var msg = (e && e.response && e.response.data && e.response.data.message) || '解锁失败';
        self.error = msg;
        self.busy = false;
      });
    },
    submitSetup: function() {
      var self = this;
      if (this.pwd1.length < 4 || this.pwd1.length > 32) {
        this.error = '密码长度 4~32 位';
        return;
      }
      if (this.pwd1 !== this.pwd2) {
        this.error = '两次输入不一致';
        return;
      }
      this.busy = true;
      this.$store.dispatch('lock/setup', this.pwd1).then(function(r) {
        if (!r.ok) { self.error = r.message; self.busy = false; return; }
        self.resolve(true);
      });
    },

    // ---------- 焦点与键盘（同 ConfirmDialog 的规矩） ----------
    $_open: function() {
      var self = this;
      this._prevFocus = document.activeElement;
      this.$nextTick(function() {
        if (self.$refs.pwd1 && self.$refs.pwd1.focus) self.$refs.pwd1.focus();
      });
      document.addEventListener('keydown', this._onKeydown);
    },
    $_close: function() {
      document.removeEventListener('keydown', this._onKeydown);
      var p = this._prevFocus;
      this._prevFocus = null;
      if (p && p.focus && document.contains(p)) p.focus();
    },
    _onKeydown: function(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        e.preventDefault();
        this.resolve(false);
        return;
      }
      if (e.key === 'Tab' || e.keyCode === 9) {
        var el = this.$el;
        if (!el || !el.querySelectorAll) return;
        var items = el.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (items.length < 2) { e.preventDefault(); return; }
        var first = items[0];
        var last = items[items.length - 1];
        var active = document.activeElement;
        var inside = el.contains(active);
        if (e.shiftKey) {
          if (!inside || active === first) { e.preventDefault(); last.focus(); }
        } else if (!inside || active === last) {
          e.preventDefault(); first.focus();
        }
      }
    }
  }
};
</script>

<style scoped>
.lock-mask {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 540;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--gap-lg);
  background: var(--mask);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.lock-card {
  width: 100%;
  max-width: 340px;
  padding: 22px;
  border-radius: var(--radius-xl);
}

.lock-title {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 600;
}

.lock-sub {
  margin: 0 0 16px;
  line-height: 1.6;
}

.lock-input {
  width: 100%;
  margin-bottom: 10px;
  /* 触屏密码框：44px 命中高度是基线，不缩 */
  height: 44px;
}

.lock-error {
  margin: 2px 0 0;
  color: var(--danger);
  line-height: 1.5;
}

.lock-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
html.no-flex-gap .lock-actions > * + * {
  margin-left: 10px;
}
</style>
