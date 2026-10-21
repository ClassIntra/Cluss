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

    <!-- 全局密码弹窗：隐藏会话与私密笔记共用的解锁入口（见 store/lock） -->
    <LockPrompt />

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
import LockPrompt from './components/LockPrompt.vue';
import navItems from './utils/nav-items';

// 学生主导航页的先后次序：决定切页动画往左还是往右。
// 不在这张表里的页（登录 / 注册 / 管理台 / 我的消耗）没有方向感可言，走淡化。
var ORDER = {};
navItems.forEach(function(item, index) {
  ORDER[item.to] = index;
});

export default {
  name: 'App',
  components: { TabBar, ConfirmDialog, LockPrompt },
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
    // 首次点某个标签要现场下载它的 chunk —— Notes 243KB / Chat 41KB，
    // 在平板的移动网络上这一下就是好几秒的空白，体感就是「点击没反应」。
    //
    // ⚠️ 但这一段曾经**把首屏拖慢了 1.5 秒**（实测 LCP 1.3s → 2.76s）：
    //   原实现是 mounted 里就 requestIdleCallback(fn, { timeout: 3000 }) ——
    //   timeout 的意思是「主线程一直忙也强制在 3 秒后跑」。而冷加载时
    //   主线程恰恰一直忙（下载 chunk、跑 mermaid/katex、渲染），
    //   于是 7 个页面 chunk 在首屏渲染期间被一次性全量拉下来，
    //   实测占用主线程 1549ms，把首屏的绘制挤到最后。
    //   管理台尤其惨：LCP 元素是名册卡片里的一句说明文字 ——
    //   因为在那之前整个卡片区都还是空的。
    //
    // 现在改成两道保险：
    //   1. 等**真实的 FCP**（first-contentful-paint）才开始，
    //      而不是两次 rAF —— 实测两次 rAF 在 ~100ms 就过了，
    //      而本页首绘要等 API 回来（实测 464ms），中间主线程一闲下来
    //      idle 回调就开跑，预取照样撞进首屏窗口
    //      （时间线上 Notes 的依赖清单把 katex 255KB 在 196ms 拽下来，
    //      与首屏绘制完全重叠）。FCP 拿不到就每 200ms 重查，
    //      3 秒兜底 —— 页面再慢预取也不能永远不跑。
    //   2. 逐个串行加载，每个之间让出一次主线程，
    //      且**不设 timeout** —— 忙就等着，宁可晚点预取也不抢首屏
    //      （预取晚 3 秒没人察觉，首屏慢 1.5 秒人人可感）
    //
    // 失败静默：预取是纯优化，取不到就退化成原来的「点的时候再下」，
    // 不该因为它影响任何功能。
    prefetchRoutes: function() {
      var list = navItems.filter(function (item) { return !!item.chunk; });
      var index = 0;

      function prefetchOne() {
        if (index >= list.length) return;
        var item = list[index++];
        // import() 失败会返回 rejected promise，吞掉即可
        var p = item.chunk();
        if (p && p.catch) p.catch(function () {});
        // 让出一次主线程再取下一个：一次只压一个 chunk 进来，
        // 避免七个一起解析把某个交互卡住
        scheduleIdle(prefetchOne);
      }

      function scheduleIdle(fn) {
        if (typeof window.requestIdleCallback === 'function') {
          // 不传 timeout —— 忙就等着
          window.requestIdleCallback(fn);
        } else {
          setTimeout(fn, 300);
        }
      }

      var painted = false;
      try {
        new PerformanceObserver(function (l) {
          l.getEntries().forEach(function (e) {
            if (e.name === 'first-contentful-paint') painted = true;
          });
        }).observe({ type: 'paint', buffered: true });
      } catch (e) {
        // 观察器不可用（老内核）：退回旧行为，别把预取彻底弄没
        painted = true;
      }

      var waited = 0;
      function kick() {
        if (painted || waited >= 3000) { scheduleIdle(prefetchOne); return; }
        waited += 200;
        setTimeout(kick, 200);
      }
      kick();
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
  transition: opacity var(--dur-base) ease, transform var(--dur-base) cubic-bezier(0.32, 0.72, 0, 1);
}

.toast-enter,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-12px);
}
</style>