<template>
  <header class="topbar glass topbar-compact">
    <div class="topbar-left">
      <button v-if="showMenuButton" class="menu-btn" type="button" title="菜单" @click="$emit('toggle-sidebar')">
        ☰
      </button>
      <ClussLogo :size="32" />
      <div class="brand-text">
        <div class="brand-name">Cluss</div>
        <div class="brand-sub">引导式 AI 解题</div>
      </div>
      <button
        v-if="isEmbedded"
        type="button"
        class="ci-back-btn"
        title="返回 ClassIntra 桌面"
        @click="backToClassIntra"
      ><i class="fa-solid fa-chevron-left"></i><span>ClassIntra</span></button>
    </div>

    <nav class="topbar-nav">
      <router-link
        v-for="item in navItems"
        :key="item.id"
        class="nav-item"
        :class="{ active: item.id === active }"
        :to="item.to"
      >{{ item.label }}<span
        v-if="badgeFor(item.id)"
        class="nav-badge"
        :title="'今天有 ' + badgeFor(item.id) + ' 道错题该复习了'"
        :aria-label="'今天有 ' + badgeFor(item.id) + ' 道错题该复习了'"
      >{{ badgeFor(item.id) }}</span></router-link>
    </nav>

    <div class="topbar-right">
      <button
        ref="chip"
        type="button"
        class="user-chip"
        :class="{ 'is-open': menuOpen }"
        :aria-expanded="menuOpen ? 'true' : 'false'"
        aria-haspopup="menu"
        title="账号菜单"
        v-click-outside="onOutsideClick"
        @click="toggleMenu"
      >
        <div class="avatar">{{ avatarChar }}</div>
        <div class="user-meta">
          <div class="user-name">{{ displayName }}</div>
          <div class="user-sub">{{ user.user_id }}{{ user.class_no ? ' · ' + user.class_no + '班' : '' }}</div>
        </div>
        <span class="caret-down" aria-hidden="true"></span>
      </button>

      <!--
        菜单本体在打开时会被搬到 document.body 上（见 attachMenu）。
        为什么要搬：
          1. 顶栏是 .glass，带 backdrop-filter —— 它会自建层叠上下文，
             Chrome 80（Android 9 平板）上这个合成层有缺陷，菜单会被正文盖住；
          2. 菜单留在顶栏里时，任何祖先的 overflow / z-index 变化都能把它裁掉。
        搬到 body 后用 fixed + 实测坐标定位，就与这些完全解耦。
      -->
      <transition name="fade">
        <div
          v-if="menuOpen"
          ref="menu"
          class="user-menu float-panel"
          role="menu"
          @click.stop
        >
          <div class="menu-head">
            <div class="menu-avatar">{{ avatarChar }}</div>
            <div class="menu-head-text">
              <div class="menu-name">{{ displayName }}</div>
              <div class="menu-sub">{{ user.user_id }}{{ user.class_no ? ' · ' + user.class_no + '班' : '' }}</div>
              <!-- 会话来源徽标：from_classintra 是「本次由 CI 免登进来」（撞号的本地账号也算），
                   source 是「账号当初怎么来的」。取并集，学生才不会看到「我明明是 CI 进来的却没徽标」 -->
              <div v-if="user.from_classintra || user.source === 'classintra'" class="menu-badge">来自 ClassIntra</div>
            </div>
          </div>

          <router-link class="menu-item" to="/usage" role="menuitem" @click.native="closeMenu">我的消耗</router-link>

          <button class="menu-item" type="button" role="menuitem" @click="toggleTheme">
            <span class="menu-item-row">
              <span>{{ isDark ? '浅色模式' : '深色模式' }}</span>
              <span class="theme-swatch" :class="{ 'is-dark': isDark }" aria-hidden="true"></span>
            </span>
          </button>

          <router-link v-if="isAdmin" class="menu-item" to="/admin" role="menuitem" @click.native="closeMenu">管理台</router-link>

          <div class="menu-sep" aria-hidden="true"></div>

          <button class="menu-item menu-danger" type="button" role="menuitem" @click="logout">
            {{ isEmbedded ? '退出到 ClassIntra' : '退出登录' }}
          </button>

          <!-- 版本号：来源 client/package.json（与服务端约定同步改），排障时一眼对上服务端版本 -->
          <div class="menu-version tiny muted" aria-hidden="true">Cluss v{{ version }}</div>
        </div>
      </transition>
    </div>
  </header>
</template>

<script>
import ClussLogo from './ClussLogo.vue';
import navItems from '@/utils/nav-items';
import { isEmbedded, backToClassIntra } from '@/utils/embedded';
import { version } from '../../package.json';

// 全站顶栏：六个学生入口 + 管理台（仅管理员）
// 抽成组件是因为各页都要用；各页自己写一份会导致导航项逐渐不一致
export default {
  name: 'AppNav',
  components: { ClussLogo },
  props: {
    active: { type: String, default: '' },
    showMenuButton: { type: Boolean, default: false }
  },
  data: function() {
    return {
      menuOpen: false,
      version: version
    };
  },
  computed: {
    user: function() {
      return this.$store.state.auth.user || {};
    },
    // 嵌入态：被 ClassIntra 的 Cluss 应用以内嵌 iframe 打开时，
    // 在品牌区显示「返回 ClassIntra」，点击给宿主页发消息让它退出应用。
    // 判据与出口统一在 utils/embedded.js —— 登录页的兜底出口也用同一份。
    isEmbedded: function() {
      return isEmbedded();
    },
    isAdmin: function() {
      return this.$store.getters['auth/isAdmin'];
    },
    isDark: function() {
      return this.$store.getters['theme/isDark'];
    },
    displayName: function() {
      return this.user.real_name || this.user.net_name || '同学';
    },
    avatarChar: function() {
      return String(this.user.real_name || this.user.net_name || '?').slice(0, 1);
    },
    navItems: function() {
      // 列表本体在 utils/nav-items.js（TabBar 与这里共用一份，防漂移）。
      // 「消耗」不放在导航里：它是低频页，留着会把导航挤成 7 项
      // （窄屏平板上一行放不下，只能横向滚动，反而更难用）。
      // 它已挂在用户菜单里，入口不丢。
      return navItems;
    },
    dueWrongCount: function() {
      return this.$store.getters['wrongBook/dueCount'];
    }
  },
  mounted: function() {
    // 每个页面各自渲染一个 AppNav，所以"进入新页面"天然就是刷新时机。
    // 失败静默（见 store 里的说明）——角标是提示，不是功能，绝不能因此报错。
    this.$store.dispatch('wrongBook/refreshOverview');
    this.hintAdminOnce();
  },
  watch: {
    // 路由变化时收起：菜单挂在 body 上，不跟着组件走，必须显式关
    '$route': function() {
      this.closeMenu();
    }
  },
  beforeDestroy: function() {
    this.detachMenu();
    this.destroyMenuNode();
  },
  methods: {
    // 给宿主（ClassIntra 应用壳）发消息让它退出 Cluss 应用；宿主未监听时静默
    backToClassIntra: backToClassIntra,

    // 班管第一次进来时指一次路：管理台入口藏在右上角头像菜单里，
    // 不指一下真的找不到 —— 这正是「从 ClassIntra 进来的班管看不到管理台」的另一种成因
    // （另一种是身份没同步进来，见服务端 syncCiAdminFlag）。
    // 每个浏览器只提示一次：重复提示就从「贴心」变成「噪音」了。
    hintAdminOnce: function() {
      if (!this.isAdmin) return;
      try {
        if (localStorage.getItem('cluss_admin_hint')) return;
        localStorage.setItem('cluss_admin_hint', '1');
      } catch (e) {
        return; // 隐私模式等拿不到 localStorage 就干脆不提示
      }
      var self = this;
      this.$nextTick(function() {
        self.$store.dispatch('toast', {
          message: '你是班级管理员：管理台在右上角头像菜单里',
          type: 'info'
        });
      });
    },
    // 导航项角标：目前只有错题本有，但走一个统一入口，
    // 将来别的入口要挂角标时不用再改模板
    badgeFor: function(itemId) {
      if (itemId === 'wrong-book') return this.dueWrongCount;
      return 0;
    },

    toggleMenu: function() {
      var self = this;
      if (this.menuOpen) {
        this.closeMenu();
        return;
      }
      this.menuOpen = true;
      this.$nextTick(function() { self.attachMenu(); });
    },

    // 把菜单搬到 body 并按触发按钮的实测位置定位
    attachMenu: function() {
      var menu = this.$refs.menu;
      if (!menu) return;
      if (menu.parentNode !== document.body) document.body.appendChild(menu);
      this.positionMenu();

      if (this._bound) return;
      this._bound = true;
      window.addEventListener('resize', this.positionMenu);
      window.addEventListener('orientationchange', this.positionMenu);
      // 捕获阶段监听：菜单自身滚动、页面内滚动都要跟着走
      window.addEventListener('scroll', this.positionMenu, true);
    },

    // 坐标全部按实测算：不依赖任何祖先的定位上下文
    positionMenu: function() {
      var menu = this.$refs.menu;
      var chip = this.$refs.chip;
      if (!menu || !chip) return;

      var pad = 8;
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var w = menu.offsetWidth;
      var h = menu.offsetHeight;
      var r = chip.getBoundingClientRect();

      // 纵向：默认挂在下边；下方装不下就翻到上边；
      // 上下都装不下（极端矮屏）时贴底放，并交给菜单内部滚动
      var top = r.bottom + pad;
      if (top + h > vh - pad) {
        var above = r.top - pad - h;
        top = above >= pad ? above : Math.max(pad, vh - h - pad);
      }

      // 横向：与头像右对齐，再夹进安全区
      var left = r.right - w;
      if (left < pad) left = pad;
      if (left + w > vw - pad) left = Math.max(pad, vw - w - pad);

      menu.style.top = top + 'px';
      menu.style.left = left + 'px';
      menu.style.maxHeight = (vh - pad * 2) + 'px';
    },

    // 只解绑监听。菜单节点本身交给 v-if 移除 ——
    // 这里手动 removeChild 会在 Vue 打补丁前先把节点摘掉，
    // <transition> 的淡出动画就播不出来了。
    detachMenu: function() {
      if (!this._bound) return;
      this._bound = false;
      window.removeEventListener('resize', this.positionMenu);
      window.removeEventListener('orientationchange', this.positionMenu);
      window.removeEventListener('scroll', this.positionMenu, true);
    },

    // 仅在组件销毁时兜底摘节点：菜单挂在 body 上，不随组件一起走
    destroyMenuNode: function() {
      var menu = this.$refs.menu;
      if (menu && menu.parentNode === document.body) {
        menu.parentNode.removeChild(menu);
      }
    },

    closeMenu: function() {
      this.menuOpen = false;
      this.detachMenu();
    },

    // 菜单已不在 .user-chip 里，点它自身不能再被 click-outside 判成「点到外面」
    onOutsideClick: function(event) {
      var menu = this.$refs.menu;
      if (menu && event && menu.contains(event.target)) return;
      this.closeMenu();
    },

    toggleTheme: function() {
      this.$store.dispatch('theme/toggleTheme');
      // 切完即收起菜单，让学生立刻看到整体效果
      this.closeMenu();
    },

    // 嵌入态下**不能**把学生丢到 Cluss 登录页：他没有 Cluss 密码，
    // 而登录页是没有顶栏的（返回按钮挂在顶栏里）—— 那是一条死路。
    // 所以嵌入态退出 = 清会话 + 请宿主回 ClassIntra 桌面；
    // 宿主万一没监听，登录页也备了「返回 ClassIntra」兜底（见 Login.vue）。
    logout: function() {
      var self = this;
      var embedded = this.isEmbedded;
      this.closeMenu();
      this.$store.dispatch('auth/logout').then(function() {
        if (embedded) {
          backToClassIntra();
          // 顺带把当前页收回首页：宿主万一没接消息，就不会停在
          // 一个「会话已清、页面还在」的错位上（守卫会把首页换成登录页，
          // 而登录页备了「返回 ClassIntra」出口）
          self.$router.replace('/');
          return;
        }
        self.$router.replace('/login');
      });
    }
  }
};
</script>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  padding: 10px 18px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  /* 必须定位并给出层级：.glass 的 backdrop-filter 虽然让顶栏自成一个层叠上下文，
     但 static 元素的层叠层级仍是 0，会排在同为文档流内的正文之下 ——
     结果就是下拉菜单被消息气泡盖住。抬到正文之上才是 header 应有的层级。 */
  position: relative;
  z-index: 100;
}

/* Chrome 80 不认 flex 容器的 gap（Chrome 84 才支持），用相邻 margin 兜底。
   支持 gap 的浏览器两条都命中，margin 会被后面的 margin:0 覆盖，不重复计。 */
.topbar > * + * {
  margin-left: var(--gap-lg);
}

.topbar-left {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.topbar-left > * + * {
  margin-left: 10px;
}

.menu-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  font-size: 16px;
  color: var(--text-secondary);
  cursor: pointer;
}

@media (hover: hover) {
.menu-btn:hover {
  background: var(--ink-2);
}
}

/* 嵌入态返回按钮：被 ClassIntra 内嵌时出现在品牌区，贴 iOS 返回样式 */
.ci-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 10px;
  padding: 5px 12px 5px 8px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.ci-back-btn i {
  font-size: 11px;
}
.ci-back-btn:active {
  transform: scale(0.96);
}
@media (max-width: 768px) {
  .ci-back-btn span {
    display: none;
  }
}

.brand-name {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
}

.brand-sub {
  /* 11px 在平板大屏上几乎读不到；配色已加深，字号也随视口长一点 */
  font-size: clamp(11px, 9.464px + 0.16vw, 13px);
  color: var(--text-tertiary);
  line-height: 1.2;
}

.topbar-nav {
  display: flex;
  align-items: center;
  margin-left: auto;
  overflow-x: auto;
  /* 横向滚动条不该出现在顶栏里 */
  scrollbar-width: none;
}

.topbar-nav::-webkit-scrollbar {
  display: none;
}

.topbar-nav > * + * {
  margin-left: 4px;
}

.nav-item {
  /* 大屏下同步放大：导航是最高频的点击目标，33.6px 高在平板上偏小。
     clamp 下限等于原值，960×680 基线不变。 */
  padding: clamp(6px, 0.45vw + 1.68px, 10px) clamp(14px, 0.9vw + 5.36px, 22px);
  border-radius: var(--radius-pill);
  font-size: clamp(13.5px, 11.58px + 0.2vw, 15.5px);
  font-weight: 500;
  color: var(--text-secondary);
  text-decoration: none;
  white-space: nowrap;
  transition: background var(--transition), color var(--transition);
}

@media (hover: hover) {
.nav-item:hover {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}
}

.nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 到期角标
   用 margin-left 而不是 flex gap：基线是 Chrome 80 的安卓平板，
   容器 gap 在那个内核上不生效（项目已有 html.no-flex-gap 兜底体系，
   但这里更简单——单个子元素根本不需要 flex）。
   min-width + 居中是为了让「9」和「12」都是个圆润的小胶囊，不歪。 */
.nav-badge {
  display: inline-block;
  min-width: 16px;
  margin-left: 5px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--danger);
  color: var(--text-invert);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  vertical-align: 1px;
}

.topbar-right {
  flex-shrink: 0;
}

.user-chip {
  position: relative;
  display: flex;
  align-items: center;
  padding: 5px 10px 5px 5px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  font-family: inherit;
  cursor: pointer;
  transition: background var(--transition), border-color var(--transition);
}

.user-chip > * + * {
  margin-left: 8px;
}

.user-chip.is-open {
  background: var(--glass-bg-strong);
  border-color: var(--ink-3);
}
@media (hover: hover) {
.user-chip:hover {
  background: var(--glass-bg-strong);
  border-color: var(--ink-3);
}
}

.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: linear-gradient(140deg, var(--brand-a), var(--brand-b));
  color: var(--text-invert);
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.user-name {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25;
  text-align: left;
}

.user-sub {
  /* 学号·班级是「确认我是我」的关键信息，不该是全站最小的字 */
  font-size: clamp(11px, 9.464px + 0.16vw, 13px);
  color: var(--text-tertiary);
  line-height: 1.25;
  text-align: left;
}

/* 下拉指示：三角用边框画，不额外引入图标依赖 */
.caret-down {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--text-tertiary);
  flex-shrink: 0;
  margin-left: 6px;
}

/* 定位坐标由 JS 实测写入（见 positionMenu），这里只管外观。
   挂 fixed 是为了彻底摆脱祖先的层叠上下文与 overflow 影响。 */
.user-menu {
  position: fixed;
  z-index: 1000;
  min-width: 210px;
  max-width: calc(100vw - 16px);
  padding: 10px;
  border-radius: var(--radius-lg);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.menu-head {
  display: flex;
  align-items: center;
  padding: 6px 8px 10px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--ink-2);
}

.menu-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: linear-gradient(140deg, var(--brand-a), var(--brand-b));
  color: var(--text-invert);
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.menu-head-text {
  min-width: 0;
  margin-left: 10px;
}

.menu-name {
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-sub {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.menu-badge {
  display: inline-block;
  margin-top: 5px;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10.5px;
}

.menu-item {
  display: block;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 13px;
  font-family: inherit;
  /* 按下即时、松开柔和回落（见 global.css 的触屏手感段） */
  transition: background var(--transition), color var(--transition);
  color: var(--text-primary);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

@media (hover: hover) {
.menu-item:hover {
  background: var(--ink-2);
}
}

/* 主题切换项：右侧带一个小色块示意当前会切到哪一边 */
.menu-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.theme-swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--ink-4);
  background: linear-gradient(135deg, #f5f7fc 50%, #d8deec 50%);
  flex-shrink: 0;
  margin-left: 10px;
}

.theme-swatch.is-dark {
  background: linear-gradient(135deg, #2b3140 50%, #14161d 50%);
  border-color: var(--ink-3);
}

.menu-sep {
  height: 1px;
  margin: 6px 8px;
  background: var(--ink-2);
}

.menu-danger {
  color: var(--danger);
}

@media (hover: hover) {
.menu-danger:hover {
  background: var(--danger-tint);
  color: var(--danger);
}
}

.menu-version {
  padding: 6px 10px 2px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  /* 不可点、不可选：纯展示信息 */
  user-select: none;
  -webkit-user-select: none;
}

/* 窄屏：隐藏品牌副标题与用户信息，导航横向滚动 */
@media (max-width: 900px) {
  .brand-sub,
  .user-meta {
    display: none;
  }

  .topbar {
    padding: 8px 12px;
  }

  .topbar > * + * {
    margin-left: var(--gap-sm);
  }
}

/* 竖屏窄屏：底部标签栏（TabBar）接管导航，顶栏链接整个收掉。
   判据用 html.has-tabbar（TabBar 挂载时写入）而不是自己再做方向检测——
   顶栏链接与底栏必须同时只有一套可见，让同一个真相来源决定。 */
html.has-tabbar .topbar-nav {
  display: none;
}

/* 同一时刻顶栏只剩 ☰ + 品牌 + 头像，副标题可以留出更多呼吸感 */
html.has-tabbar .brand-sub {
  display: none;
}
</style>
