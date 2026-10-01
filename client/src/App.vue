<template>
  <div id="app-root">
    <router-view />

    <!-- 全局轻提示 -->
    <transition name="toast">
      <div v-if="toast" :key="toast.id" class="toast" :class="'toast-' + toast.type" role="status">
        {{ toast.message }}
      </div>
    </transition>
  </div>
</template>

<script>
export default {
  name: 'App',
  computed: {
    toast: function() {
      return this.$store.state.toast;
    }
  },
  watch: {
    toast: function(val) {
      if (!val) return;
      var self = this;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(function() {
        self.$store.commit('CLEAR_TOAST');
      }, 3200);
    }
  },
  beforeDestroy: function() {
    clearTimeout(this._toastTimer);
  }
};
</script>

<style scoped>
#app-root {
  position: relative;
  z-index: 1;
  height: 100%;
}

.toast {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(520px, calc(100vw - 48px));
  padding: 12px 20px;
  border-radius: var(--radius-md);
  background: var(--toast-bg);
  color: var(--text-invert);
  font-size: 13.5px;
  line-height: 1.5;
  box-shadow: var(--shadow-float);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  z-index: 999;
}

.toast-success {
  background: var(--toast-success-bg);
}

.toast-error {
  background: var(--toast-error-bg);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.24s ease, transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}

.toast-enter,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-12px);
}
</style>