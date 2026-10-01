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

export default router;