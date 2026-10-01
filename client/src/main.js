import Vue from 'vue';
import App from './App.vue';
import router from './router';
import store from './store';
import api from './utils/api';
import './styles/global.css';

Vue.config.productionTip = false;

// 挂到原型：组件内用 this.$http 统一走带鉴权与错误净化的实例
Vue.prototype.$http = api;

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