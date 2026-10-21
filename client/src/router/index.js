import Vue from 'vue';
import VueRouter from 'vue-router';
import store from '@/store';
import { readHomePage } from '@/utils/home-page';
import { apiUrl } from '@/utils/base-path';
import { basePath } from '@/utils/base-path';

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
    path: '/notes',
    name: 'Notes',
    component: function() { return import('@/views/Notes.vue'); },
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

// base 必须跟部署路径走，不能写死 '/'：
//   hash 模式下 VueRouter 会把 base 拼在 `#` 之前（地址形如 /cluss/#/study）。
//   若 base 固定为 '/'，iframe 挂在 /cluss/ 下时一切换页地址就变成
//   https://<宿主>/#/study —— 路径掉回宿主根目录，整个 iframe 被宿主的
//   SPA 兜底接管，Cluss 界面"凭空消失"。根部署时 basePath 就是 '/'，行为不变。
var router = new VueRouter({
  mode: 'hash',
  base: basePath,
  routes: routes
});

// 「默认打开页」只认**本次打开的第一次导航**。
//
// 为什么放在这里：已登录的学生再打开应用根本不经过登录页，早先把生效点
// 只放在"登录成功那一刻"，于是设置里改了却永远不生效（实测反馈）。
// 只在落到根路径时接管 —— 深链（#/study 这类）是明确意图，绝不抢；
// 刷新在 /notes 上也不该被拽走。
var bootNavPending = true;

router.beforeEach(function(to, from, next) {
  // auth 模块是 namespaced，getter 必须带命名空间前缀；
  // 写成 store.getters.isLoggedIn 会恒为 undefined，导致登录后仍被弹回登录页
  var loggedIn = store.getters['auth/isLoggedIn'];

  if (bootNavPending) {
    bootNavPending = false;
    if (to.path === '/' && loggedIn) {
      var home = readHomePage();
      if (home !== '/') return next(home);
    }
  }

  if (to.meta.requiresAuth && !loggedIn) {
    return next({ name: 'Login', query: { redirect: to.fullPath } });
  }

  if (to.meta.requiresAdmin && loggedIn) {
    if (!store.getters['auth/isAdmin']) {
      return next({ name: 'Chat' });
    }
  }

  // 已登录时不再进登录/注册页 —— 落到他自己的默认打开页，而不是硬编码对话页
  if (to.meta.guest && loggedIn) {
    return next(readHomePage());
  }

  next();
});

// 部署会整体替换带 hash 的 chunk 文件名。已经打开的旧页面再点懒加载路由时，
// 请求的那个 chunk 已经不存在，服务端的 SPA 兜底又会把 index.html 当 JS 返回，
// 浏览器按 MIME 严格校验拒绝执行 —— 表现就是「点了没反应」，学生只会以为坏了。
// 这里刷新一次拿新的 index.html 即可。
var CHUNK_ERROR = /Loading chunk|Loading CSS chunk|Failed to fetch dynamically imported module|Importing a module script failed/i;
var CHUNK_RELOAD_KEY = 'cluss_chunk_reload_at';

// 好感度「探索」上报：到过一个功能页就记一次（幂等，每个功能一生只加一次分）。
//
// 为什么放路由层而不是每个页面里写：探索的定义就是"来过这里"，
// 在 afterEach 一处映射，新增页面只要往表里加一行，不会漏。
// 为什么用原生 fetch 而不是 utils/api：api.js 本身就 import 了 router，
// 这里再引回去就是循环依赖（组件还没挂载时 router 先执行，prototype 上还没有 $http）。
var EXPLORE_MAP = {
  '/': 'chat',
  '/study': 'study',
  '/writing': 'writing',
  '/notes': 'notes',
  '/wrong-book': 'wrongbook',
  '/cloud': 'cloud'
};

// 同一浏览器会话内已上报过的功能不再重复发 —— 路由层每次切页都会走到这里，
// 去重只是少几次无谓请求（服务端本来也幂等）。
var EXPLORED_SENT = {};

router.afterEach(function(to) {
  var feature = EXPLORE_MAP[to.path];
  if (!feature || EXPLORED_SENT[feature]) return;
  EXPLORED_SENT[feature] = true;
  try {
    var token = store.state.auth.token;
    if (!token) return;
    fetch(apiUrl('affinity/explore'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ feature: feature })
    }).catch(function() { /* 探索加分是增强项，失败静默 */ });
  } catch (e) { /* 同上 */ }
});

router.onError(function(err) {
  var msg = (err && err.message) || '';
  if (!CHUNK_ERROR.test(msg)) return;

  // 只兜底刷一次：万一新版本本身有问题，不能变成无限刷新
  // sessionStorage 在受限 WebView 里可能拿不到对象（为 null），包一层避免 onError 里再抛错
  var last = 0;
  try { last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0); } catch (e) {}
  if (Date.now() - last < 15000) return;
  try { sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now())); } catch (e) {}
  window.location.reload();
});

export default router;