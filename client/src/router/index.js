import Vue from 'vue';
import VueRouter from 'vue-router';
import store from '@/store';

Vue.use(VueRouter);

var routes = [
  {
    path: '/login',
    name: 'Login',
    component: function() { return import('@/views/Login.vue'); },
    meta: { guest: true }
  },
  {
    path: '/register',
    name: 'Register',
    component: function() { return import('@/views/Register.vue'); },
    meta: { guest: true }
  },
  {
    path: '/',
    name: 'Chat',
    component: function() { return import('@/views/Chat.vue'); },
    meta: { requiresAuth: true }
  },
  {
    path: '/study',
    name: 'Study',
    component: function() { return import('@/views/Study.vue'); },
    meta: { requiresAuth: true }
  },
  {
    path: '/cloud',
    name: 'Cloud',
    component: function() { return import('@/views/Cloud.vue'); },
    meta: { requiresAuth: true }
  },
  {
    path: '/writing',
    name: 'Writing',
    component: function() { return import('@/views/Writing.vue'); },
    meta: { requiresAuth: true }
  },
  {
    path: '/records',
    name: 'Records',
    component: function() { return import('@/views/Records.vue'); },
    meta: { requiresAuth: true }
  },
  {
    path: '/wrong-book',
    name: 'WrongBook',
    component: function() { return import('@/views/WrongBook.vue'); },
    meta: { requiresAuth: true }
  },
  {
    path: '/usage',
    name: 'Usage',
    component: function() { return import('@/views/Usage.vue'); },
    meta: { requiresAuth: true }
  },
  {
    path: '/admin',
    name: 'Admin',
    component: function() { return import('@/views/Admin.vue'); },
    meta: { requiresAuth: true, requiresAdmin: true }
  },
  {
    path: '*',
    redirect: '/'
  }
];

var router = new VueRouter({
  mode: 'hash',
  routes: routes
});

router.beforeEach(function(to, from, next) {
  // auth 模块是 namespaced，getter 必须带命名空间前缀；
  // 写成 store.getters.isLoggedIn 会恒为 undefined，导致登录后仍被弹回登录页
  var loggedIn = store.getters['auth/isLoggedIn'];

  if (to.meta.requiresAuth && !loggedIn) {
    return next({ name: 'Login', query: { redirect: to.fullPath } });
  }

  if (to.meta.requiresAdmin && loggedIn) {
    if (!store.getters['auth/isAdmin']) {
      return next({ name: 'Chat' });
    }
  }

  // 已登录时不再进登录/注册页
  if (to.meta.guest && loggedIn) {
    return next({ name: 'Chat' });
  }

  next();
});

// 部署会整体替换带 hash 的 chunk 文件名。已经打开的旧页面再点懒加载路由时，
// 请求的那个 chunk 已经不存在，服务端的 SPA 兜底又会把 index.html 当 JS 返回，
// 浏览器按 MIME 严格校验拒绝执行 —— 表现就是「点了没反应」，学生只会以为坏了。
// 这里刷新一次拿新的 index.html 即可。
var CHUNK_ERROR = /Loading chunk|Loading CSS chunk|Failed to fetch dynamically imported module|Importing a module script failed/i;
var CHUNK_RELOAD_KEY = 'cluss_chunk_reload_at';

router.onError(function(err) {
  var msg = (err && err.message) || '';
  if (!CHUNK_ERROR.test(msg)) return;

  // 只兜底刷一次：万一新版本本身有问题，不能变成无限刷新
  var last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0);
  if (Date.now() - last < 15000) return;
  try { sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now())); } catch (e) {}
  window.location.reload();
});

export default router;