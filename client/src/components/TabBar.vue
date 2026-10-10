<template>
  <nav v-if="visible" class="tabbar glass" aria-label="主导航">
    <!-- 滑动指示器：位置由激活项下标驱动，transform 过渡跟手又顺滑 -->
    <span class="tab-ind" :style="indStyle" aria-hidden="true"></span>
    <router-link
      v-for="item in items"
      :key="item.id"
      class="tab-item"
      :class="{ active: isActive(item) }"
      :to="item.to"
      @click.native="onTabClick(item, $event)"
    >
      <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path :d="icons[item.id].d" />
        <circle v-if="icons[item.id].circle" :cx="icons[item.id].circle.cx" :cy="icons[item.id].circle.cy" :r="icons[item.id].circle.r" />
      </svg>
      <span class="tab-label">{{ item.label }}</span>
      <!-- 到期角标：绝对定位，不能作为 flex 子项参与流式布局 ——
           .tab-item 是 column flex，角标若在流内会把图标和文字顶歪，
           且 html.no-flex-gap 的回退规则（> * + * 加 margin-top）还会再推它一下 -->
      <span
        v-if="badgeFor(item.id)"
        class="tab-badge"
        :title="'今天有 ' + badgeFor(item.id) + ' 道错题该复习了'"
      >{{ badgeFor(item.id) }}</span>
    </router-link>
  </nav>
</template>

<script>
import navItems from '@/utils/nav-items';
import { subscribeOrientation } from '@/utils/device-orientation';

// ============================================================
// 竖屏底部标签栏
// ------------------------------------------------------------
// 为什么竖屏需要一个底栏，而顶栏里那排链接不够用：
//   竖屏窄屏（680~1024）上顶栏要同时塞下 ☰、品牌、6 个链接、头像 ——
//   链接只能横向滚动，第二个之后的入口是"看不见的"。
//   更根本的是可达性：顶栏在屏幕上缘，而竖屏握持时拇指活动范围在下半屏。
//   底栏让六个入口全部落在拇指热区里，且永远可见、不用滚。
//
// 何时显示：订阅 utils/device-orientation 的 useDrawer（＝设备竖屏 且 视口宽 ≤ 1024），
// 与页面里的抽屉是**同一份**判定。不引 mixins/orientation（它带着抽屉手势的
// document 级监听，挂在 App.vue 会和页面实例重复注册）；也不自己算方向 ——
// 曾经这里另算一份，在受管平板上与页面那几份分叉过（底栏竖屏、正文横屏）。
//
// 横屏与大竖屏平板（>1024）不显示：顶栏横排链接在那里本来就是最优解，
// 底栏反而浪费垂直空间 —— 横屏矮屏上垂直空间是最贵的。
// ============================================================

// 线性图标，stroke 用 currentColor，随激活态变色。
// 手绘 path 而不引图标库：六个图标不值得多一个依赖与加载成本。
var ICONS = {
  chat: {
    d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9.6L5 19.8V16A2.5 2.5 0 0 1 4 13.5z'
  },
  study: {
    d: 'M4.5 8.5A2 2 0 0 1 6.4 6.6h2.1l1.3-1.8h4.4l1.3 1.8h2.1a2 2 0 0 1 1.9 1.9V17a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2z',
    circle: { cx: 12, cy: 12.6, r: 3.1 }
  },
  writing: {
    d: 'M4.5 19.5l.9-3.6L15.9 5.4a2.1 2.1 0 0 1 3 3L8.4 18.9l-3.9.6zM13.9 7.4l3 3'
  },
  records: {
    d: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm0 4v4.3l3 1.7'
  },
  notes: {
    d: 'M6 3.5h9.5a2.5 2.5 0 0 1 2.5 2.5v12a2.5 2.5 0 0 1-2.5 2.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2zM8.5 8h5M8.5 11.5h5M8.5 15h3'
  },
  'wrong-book': {
    d: 'M6.5 4h11A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-13A1.5 1.5 0 0 1 6.5 4zM9 4v16M12.5 9.5l4 5m0-5l-4 5'
  },
  cloud: {
    d: 'M7.2 18.5h9a4 4 0 0 0 .7-7.94A5.6 5.6 0 0 0 6 9.4a4.6 4.6 0 0 0 1.2 9.1z'
  }
};

export default {
  name: 'TabBar',
  data: function() {
    return {
      items: navItems,
      icons: ICONS,
      narrowPortrait: false
    };
  },
  computed: {
    visible: function() {
      // 未登录（登录/注册页）不显示；路由守卫会把未登录访问重定向到 /login，
      // 这里再看一眼 token，避免登出瞬间底栏残留在登录页上
      if (!this.$store.state.auth.token) return false;
      return this.narrowPortrait;
    },
    activeIndex: function() {
      for (var i = 0; i < this.items.length; i++) {
        if (this.isActive(this.items[i])) return i;
      }
      return -1;
    },
    // 指示器的宽度 = 一格（nav 内宽 / 项数），translateX 按格数平移 ——
    // translateX 的百分比基于元素自身宽度，一格一跳，正好落在激活项底下
    indStyle: function() {
      if (this.activeIndex < 0) return { opacity: '0' };
      return {
        width: 'calc((100% - 12px) / ' + this.items.length + ')',
        transform: 'translateX(' + this.activeIndex * 100 + '%)'
      };
    },
    dueWrongCount: function() {
      return this.$store.getters['wrongBook/dueCount'];
    }
  },
  watch: {
    // 登录/登出切换时底栏出现/消失，页面预留的底部空隙也要跟着对上 ——
    // html.use-drawer 上的标记由各页面的 orientation mixin 维护，
    // 但登录页没有 mixin，所以这里补写一份，保证两处永远同步
    visible: function(val) {
      document.documentElement.classList.toggle('has-tabbar', !!val);
    }
  },
  mounted: function() {
    var self = this;
    // 订阅判据（订阅时会立刻回调一次当前值）；visible 的 watcher 会接着同步 has-tabbar
    this._unsubOrientation = subscribeOrientation(function(s) {
      self.narrowPortrait = s.useDrawer;
    });
    // 与顶栏同一个刷新时机：底栏也是每页各挂一个实例
    this.$store.dispatch('wrongBook/refreshOverview');
    document.documentElement.classList.toggle('has-tabbar', this.visible);
  },
  beforeDestroy: function() {
    if (this._unsubOrientation) {
      this._unsubOrientation();
      this._unsubOrientation = null;
    }
    document.documentElement.classList.remove('has-tabbar');
  },
  methods: {
    // 与顶栏一致：只有错题本挂角标，走统一入口便于以后扩展
    badgeFor: function(itemId) {
      if (itemId === 'wrong-book') return this.dueWrongCount;
      return 0;
    },
    isActive: function(item) {
      // 「对话」的 to 是 '/'，不能直接全等：/study 不能点亮 / 的 tab
      if (item.to === '/') return this.$route.path === '/';
      return this.$route.path.indexOf(item.to) === 0;
    },

    // 再点当前页的标签 = 送回顶部（商业 App 的通用习惯）。
    // 每页的主滚动容器各不相同，且都在页面内部滚动（body 不滚），
    // 所以按"第一个真的滚得动的 overflow 容器"去找，不写死类名。
    onTabClick: function(item) {
      if (!this.isActive(item)) return;
      var root = document.querySelector('#app-root > div');
      if (!root) return;
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.scrollHeight - el.clientHeight < 60) continue;
        var oy = '';
        try { oy = getComputedStyle(el).overflowY; } catch (e) { /* ignore */ }
        if (oy !== 'auto' && oy !== 'scroll') continue;
        if (el.scrollTo) {
          try { el.scrollTo({ top: 0, behavior: 'smooth' }); }
          catch (e) { el.scrollTop = 0; }
        } else {
          el.scrollTop = 0;
        }
        return;
      }
    }
  }
};
</script>

<style scoped>
.tabbar {
  position: fixed;
  left: 10px;
  right: 10px;
  bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  z-index: 95;
  display: flex;
  align-items: stretch;
  padding: 6px;
  border-radius: var(--radius-lg);
  /* 浮在正文上：底色用近不透明，盖在消息上时下层文字不透出来（float-panel 同理） */
  background: var(--menu-bg);
  border: 1px solid var(--menu-border);
  box-shadow: var(--shadow-float);
  /* 出现时从底部浮入（只播一次）；transform/opacity 都在合成层 */
  animation: tabbarIn 0.4s var(--ease-out);
  /* 抽屉开合时底栏退让（见 html.drawer-open），也要有过渡 */
  transition: transform 0.28s var(--ease-out), opacity 0.28s ease;
}

@keyframes tabbarIn {
  from {
    transform: translateY(28px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}

/* 抽屉打开 / 拖出时，底栏像被"压住"的层一样退后一点再变暗 ——
   层级关系用位移+透明度表达，比干等遮罩盖上来更有纵深。
   drawer-open 类由 orientation mixin 在抽屉开合与拖动时维护 */
html.drawer-open .tabbar {
  transform: translateX(-16px) scale(0.98);
  opacity: 0.5;
}

/* 滑动指示器：激活项底下的那块淡色底。
   不用每个 item 自己画背景，而是让这一条按激活下标滑过去 ——
   页面切换时高亮是"移动"的，不是"消失又出现"的 */
.tab-ind {
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 6px;
  width: calc((100% - 12px) / 6);
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  transition: transform 0.28s var(--ease-out), opacity 0.2s ease;
  pointer-events: none;
}

.tab-item {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 6px 0 5px;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
  transition: color var(--transition), background var(--transition);
}
html.no-flex-gap .tab-item > * + * {
  margin-top: 2px;
}






.tab-icon {
  width: 21px;
  height: 21px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 到期角标
   绝对定位是必须的：.tab-item 是 column flex，角标若留在流内会挤走图标与文字。
   视觉上从图标右上角"探出来"——中心线往右偏 6px，压在图标上沿。
   margin 显式清零：no-flex-gap 的 `> * + *` 回退规则会给它加 margin-top。 */
.tab-badge {
  position: absolute;
  top: 2px;
  left: 50%;
  margin: 0 0 0 6px;
  min-width: 16px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--danger);
  color: var(--text-invert);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  pointer-events: none;
}

/* 激活瞬间图标弹一下：到底激活的是哪个，一目了然。
   弹跳只走合成层，且只在类切换那一刻播放 */
.tab-item.active .tab-icon {
  animation: tabPop 0.32s var(--ease-out);
}

@keyframes tabPop {
  0% { transform: scale(0.8); }
  55% { transform: scale(1.14); }
  100% { transform: scale(1); }
}

.tab-label {
  /* 底部导航是竖屏下的主导航，学生要反复扫它确认「我在哪一页」。
     10.5px 是全站最小的字号 —— 导航字小到需要辨认，导航本身就失效了。
     直接提到 12px：竖屏底栏本来就是待修项，这里不需要保 10.5 的基线。 */
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
}

.tab-item.active {
  color: var(--accent);
}

/* 按下即时变色（global.css 触屏手感同款节奏），router-link 需要显式列出 */
html .tab-item:active {
  background: var(--ink-2);
  transition-duration: 0s;
}
</style>
