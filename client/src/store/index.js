import Vue from 'vue';
import Vuex from 'vuex';
import authStore from './auth';
import themeStore from './theme';
import wrongBookStore from './wrong-book';

Vue.use(Vuex);

var store = new Vuex.Store({
  modules: {
    auth: authStore,
    theme: themeStore,
    wrongBook: wrongBookStore
  },
  state: {
    toast: null,
    // 全局确认弹窗（ConfirmDialog 渲染；dispatch('confirm') 返回 Promise<boolean>）
    confirm: null
  },
  mutations: {
    SHOW_TOAST: function(state, payload) {
      state.toast = {
        message: payload.message,
        type: payload.type || 'info',
        id: Date.now()
      };
    },
    CLEAR_TOAST: function(state) {
      state.toast = null;
    },
    SHOW_CONFIRM: function(state, payload) {
      state.confirm = {
        title: payload.title || '',
        message: payload.message || '',
        confirmText: payload.confirmText || '确定',
        cancelText: payload.cancelText || '取消',
        danger: !!payload.danger,
        // resolve 函数挂在 state 上只是寄存，不参与任何渲染
        _resolve: payload._resolve
      };
    },
    CLEAR_CONFIRM: function(state) {
      state.confirm = null;
    }
  },
  actions: {
    toast: function(context, payload) {
      context.commit('SHOW_TOAST', payload);
    },
    // 用法：this.$store.dispatch('confirm', { message: '确定删除？', danger: true })
    //   .then(function(ok) { if (ok) ... })
    confirm: function(context, payload) {
      return new Promise(function(resolve) {
        context.commit('SHOW_CONFIRM', Object.assign({}, payload, { _resolve: resolve }));
      });
    },
    // 先关弹窗再兑现 Promise：界面响应不等业务代码
    resolveConfirm: function(context, val) {
      var c = context.state.confirm;
      context.commit('CLEAR_CONFIRM');
      if (c && c._resolve) c._resolve(val);
    }
  }
});

export default store;
export function showToast(message, type) {
  store.commit('SHOW_TOAST', { message: message, type: type || 'info' });
}