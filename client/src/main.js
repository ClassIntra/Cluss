import Vue from 'vue';
import App from './App.vue';
import router from './router';
import store from './store';
import api from './utils/api';
import { applyToDom } from './store/theme';
import './styles/global.css';

Vue.config.productionTip = false;

// 挂到原型：组件内用 this.$http 统一走带鉴权与错误净化的实例
Vue.prototype.$http = api;

// 把 store 里读到的主题同步到 DOM。
// index.html 的内联脚本已经设过一次（防刷新闪白），这里再设一次是为了
// 覆盖两种内联脚本管不到的情况：多标签页改过主题、以及 localStorage 被清。
applyToDom(store.state.theme.theme);

// 全局指令：点击外部关闭浮层（下拉菜单等）
Vue.directive('click-outside', {
  bind: function(el, binding) {
    el.__clickOutside__ = function(event) {
      if (!el.contains(event.target)) {
        binding.value(event);
      }
    };
    document.addEventListener('click', el.__clickOutside__);
  },
  unbind: function(el) {
    document.removeEventListener('click', el.__clickOutside__);
    delete el.__clickOutside__;
  }
});

new Vue({
  router: router,
  store: store,
  render: function(h) { return h(App); }
}).$mount('#app');