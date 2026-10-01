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
  var loggedIn = store.getters.isLoggedIn;

  if (to.meta.requiresAuth && !loggedIn) {
    return next({ name: 'Login', query: { redirect: to.fullPath } });
  }

  if (to.meta.requiresAdmin && loggedIn) {
    if (!store.getters.isAdmin) {
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