import Vue from 'vue';
import Vuex from 'vuex';
import authStore from './auth';
import themeStore from './theme';

Vue.use(Vuex);

var store = new Vuex.Store({
  modules: {
    auth: authStore,
    theme: themeStore
  },
  state: {
    toast: null
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
    }
  },
  actions: {
    toast: function(context, payload) {
      context.commit('SHOW_TOAST', payload);
    }
  }
});

export default store;
export function showToast(message, type) {
  store.commit('SHOW_TOAST', { message: message, type: type || 'info' });
}