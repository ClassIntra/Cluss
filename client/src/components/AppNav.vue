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
    </div>

    <nav class="topbar-nav">
      <router-link
        v-for="item in navItems"
        :key="item.id"
        class="nav-item"
        :class="{ active: item.id === active }"
        :to="item.to"
      >{{ item.label }}</router-link>
    </nav>

    <div class="topbar-right">
      <div class="user-chip" v-click-outside="closeMenu" @click="menuOpen = !menuOpen">
        <div class="avatar">{{ avatarChar }}</div>
        <div class="user-meta">
          <div class="user-name">{{ displayName }}</div>
          <div class="user-sub">{{ user.user_id }}{{ user.class_no ? ' · ' + user.class_no + '班' : '' }}</div>
        </div>
        <transition name="fade">
          <div v-if="menuOpen" class="user-menu glass" @click.stop>
            <div class="menu-head">
              <div class="menu-name">{{ user.real_name }}</div>
              <div class="menu-sub">用户名：{{ user.net_name }}</div>
              <div v-if="user.source === 'classintra'" class="menu-badge">来自 ClassIntra</div>
            </div>
            <router-link class="menu-item" to="/usage">我的消耗</router-link>
            <button class="menu-item" @click="toggleTheme">
              <span class="menu-item-row">
                <span>{{ isDark ? '浅色模式' : '深色模式' }}</span>
                <span class="theme-swatch" :class="{ 'is-dark': isDark }" aria-hidden="true"></span>
              </span>
            </button>
            <router-link v-if="isAdmin" class="menu-item" to="/admin">管理台</router-link>
            <button class="menu-item menu-danger" @click="logout">退出登录</button>
          </div>
        </transition>
      </div>
    </div>
  </header>
</template>

<script>
import ClussLogo from './ClussLogo.vue';

// 全站顶栏：四个学生入口 + 管理台（仅管理员）
// 抽成组件是因为四个页面都要用；各页自己写一份会导致导航项逐渐不一致
export default {
  name: 'AppNav',
  components: { ClussLogo },
  props: {
    active: { type: String, default: '' },
    showMenuButton: { type: Boolean, default: false }
  },
  data: function() {
    return { menuOpen: false };
  },
  computed: {
    user: function() {
      return this.$store.state.auth.user || {};
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
      var items = [
        { id: 'chat', label: '对话', to: '/' },
        { id: 'study', label: '学习', to: '/study' },
        { id: 'cloud', label: '云盘', to: '/cloud' },
        { id: 'usage', label: '消耗', to: '/usage' }
      ];
      if (this.isAdmin) {
        items.push({ id: 'admin', label: '管理台', to: '/admin' });
      }
      return items;
    }
  },
  methods: {
    closeMenu: function() {
      this.menuOpen = false;
    },
    toggleTheme: function() {
      this.$store.dispatch('theme/toggleTheme');
      // 切完即收起菜单，让学生立刻看到整体效果
      this.menuOpen = false;
    },
    logout: function() {
      var self = this;
      this.$store.dispatch('auth/logout').then(function() {
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
  gap: var(--gap-lg);
  padding: 10px 18px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.menu-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-size: 16px;
  color: var(--text-secondary);
  cursor: pointer;
}

.menu-btn:hover {
  background: var(--ink-2);
}

.brand-name {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
}

.brand-sub {
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.2;
}

.topbar-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  overflow-x: auto;
}

.nav-item {
  padding: 6px 14px;
  border-radius: var(--radius-pill);
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-secondary);
  text-decoration: none;
  white-space: nowrap;
  transition: background var(--transition), color var(--transition);
}

.nav-item:hover {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.topbar-right {
  flex-shrink: 0;
}

.user-chip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px 5px 5px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: background var(--transition);
}

.user-chip:hover {
  background: var(--glass-bg-strong);
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
}

.user-sub {
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.25;
}

.user-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 190px;
  padding: 12px;
  border-radius: var(--radius-lg);
  z-index: 320;
}

.menu-head {
  padding-bottom: 8px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--ink-2);
}

.menu-name {
  font-size: 13.5px;
  font-weight: 600;
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
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 13px;
  font-family: inherit;
  color: var(--text-primary);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.menu-item:hover {
  background: var(--ink-2);
}

/* 主题切换项：右侧带一个小色块示意当前会切到哪一边 */
.menu-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.theme-swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--ink-4);
  background: linear-gradient(135deg, #f5f7fc 50%, #d8deec 50%);
  flex-shrink: 0;
}

.theme-swatch.is-dark {
  background: linear-gradient(135deg, #2b3140 50%, #14161d 50%);
  border-color: var(--ink-3);
}

.menu-danger:hover {
  background: var(--danger-tint);
  color: var(--danger);
}

/* 窄屏：隐藏品牌副标题与用户信息，导航横向滚动 */
@media (max-width: 900px) {
  .brand-sub,
  .user-meta {
    display: none;
  }

  .topbar {
    gap: var(--gap-sm);
    padding: 8px 12px;
  }
}
</style>
