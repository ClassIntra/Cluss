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

// 探测 flex 容器是否支持 gap（Chrome 84 才支持，设备基线是 Chrome 80）。
// 不支持时给 <html> 加 .no-flex-gap，由 gen-flex-gap-fallback.cjs 生成的回退规则接手。
// 必须实测而不能查 CSS.supports：Chrome 80 认得 gap 这个属性（grid 用），
// 只是不应用在 flex 容器上，特性查询会误判为支持。
(function() {
  try {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;display:flex;gap:10px';
    probe.innerHTML = '<i style="width:10px;height:1px"></i><i style="width:10px;height:1px"></i>';
    document.body.appendChild(probe);
    // 支持时两个 10px 子项之间有 10px 间隙 → 总宽 30；不支持则为 20
    var supported = probe.offsetWidth >= 25;
    document.body.removeChild(probe);
    if (!supported) document.documentElement.className += ' no-flex-gap';
  } catch (e) {
    // 探测失败就按支持处理：宁可间距紧凑，也不要误加一堆 margin
  }
})();

// 低性能设备降级：关掉背景模糊（见 global.css 的 .low-perf 段）。
//
// backdrop-filter 是每帧都要重新采样背景的实时模糊，低端安卓 GPU 上极贵。
// 判据用 navigator.deviceMemory —— Chrome 会把它取整到 0.25/0.5/1/2/4/8，
// ≤4 表示中低端机型（目标设备 Android 9 平板正在这一段）。
//
// 刻意保守：任何一项拿不到就当作"性能足够"，宁可留着玻璃质感，
// 也不要因为探测失败把好设备降级了。
(function() {
  try {
    var mem = Number(navigator.deviceMemory || 0);
    if (mem > 0 && mem <= 4) {
      document.documentElement.className += ' low-perf';
    }
  } catch (e) {
    // 探测失败按"性能足够"处理
  }
})();

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