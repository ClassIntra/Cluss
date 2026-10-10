<template>
  <div id="app-root">
    <!-- 页面切换动画：名字由路由方向决定（见 watch），transition 而非 keyframes，
         切到一半再切一次也能从当前位置平滑接续 -->
    <transition :name="pageAnim">
      <router-view />
    </transition>

    <!-- 竖屏窄屏的底部导航（登录页自动隐藏，见组件内说明） -->
    <TabBar />

    <!-- 全局确认弹窗（替代 window.confirm，见 store 的 confirm action） -->
    <ConfirmDialog />

    <!-- 全局轻提示 -->
    <transition name="toast">
      <div v-if="toast" :key="toast.id" class="toast" :class="'toast-' + toast.type" role="status">
        {{ toast.message }}
      </div>
    </transition>
  </div>
</template>

<script>
import TabBar from './components/TabBar.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import navItems from './utils/nav-items';

// 学生主导航页的先后次序：决定切页动画往左还是往右。
// 不在这张表里的页（登录 / 注册 / 管理台 / 我的消耗）没有方向感可言，走淡化。
var ORDER = {};
navItems.forEach(function(item, index) {
  ORDER[item.to] = index;
});

export default {
  name: 'App',
  components: { TabBar, ConfirmDialog },
  data: function() {
    return {
      pageAnim: 'page-fade'
    };
  },
  computed: {
    toast: function() {
      return this.$store.state.toast;
    }
  },
  watch: {
    '$route': function(to, from) {
      var a = ORDER[to.path];
      var b = ORDER[from.path];
      if (a === undefined || b === undefined || a === b) {
        this.pageAnim = 'page-fade';
      } else {
        // 序号变大 = 往右边的标签去，内容向左滑
        this.pageAnim = a > b ? 'page-slide-left' : 'page-slide-right';
      }
    },
    toast: function(val) {
      if (!val) return;
      var self = this;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(function() {
        self.$store.commit('CLEAR_TOAST');
      }, 3200);
    }
  },
  mounted: function() {
    this.prefetchRoutes();
  },
  methods: {
    // 空闲时把其余页面的代码先拉下来。
    //
    // 为什么需要：所有页面都是异步组件（router 里一律 import()），
    // 首次点某个标签要现场下载它的 chunk —— Notes 243KB、Chat 41KB，
    // 在平板的移动网络上这一下就是好几秒的空白，体感就是「点击没反应」。
    //
    // 为什么用 requestIdleCallback 而不是 mounted 里直接 import：
    // 首屏还在渲染、正在跑 mermaid/katex 初始化，这时候抢主线程会把
    // 首屏也拖慢。空闲回调里做，既不抢首屏，又能保证大部分时候
    // 在用户点之前就下好了。
    //
    // 失败静默：预取是纯优化，取不到就退化成原来的「点的时候再下」，
    // 不该因为它影响任何功能。
    prefetchRoutes: function() {
      var self = this;
      var run = function() {
        navItems.forEach(function(item) {
          if (!item.chunk) return;
          // import() 失败会返回 rejected promise，这里吞掉即可
          var p = item.chunk();
          if (p && p.catch) p.catch(function() {});
        });
      };

      if (typeof window.requestIdleCallback === 'function') {
        var idle = window.requestIdleCallback(run, { timeout: 3000 });
      } else {
        // 旧内核（Chrome 80 有 requestIdleCallback，但个别 WebView 壳可能没有）
        setTimeout(run, 1200);
      }
      void self;
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