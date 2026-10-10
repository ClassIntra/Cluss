// 旧内核垫片必须是**第一条** import：ESM 按源码顺序求值，放在这里才能保证
// 在任何应用代码（以及后加载的 mermaid 图表分片）之前把 API 补齐。
// 详见 src/legacy/polyfills.js 里的说明。
import './legacy/polyfills';

import Vue from 'vue';
import App from './App.vue';
import router from './router';
import store, { showToast } from './store';
import api from './utils/api';
import { applyToDom } from './store/theme';
import { startOrientation } from './utils/device-orientation';
import './styles/global.css';
// 跨页面共用的组件样式（目前只有「引用笔记 chip」一组）。
// 为什么放全局而不是各页 <style scoped>：scoped 会给选择器加属性后缀，
// 从外部文件 import 进来的样式不会被处理 —— 写在 scoped 里等于没写。
// 而这三页用的是同一份 mixin，样式也该只有一份。
import './styles/note-refs.css';

Vue.config.productionTip = false;

// 设备方向与 <html> 上的方向类（is-portrait / use-drawer）**只在这里维护**。
// 必须在首帧之前起：晚一步竖屏进入就会先闪一帧横屏布局。
// 各页面只订阅（mixins/orientation、TabBar），不再自己算 —— 见 utils/device-orientation.js
startOrientation();

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
// 判据不能只看 navigator.deviceMemory —— 目标机型（Chrome 80 WebView /
// Android 9 平板）上它可能报得偏高甚至缺失，漏判一次所有降级都不生效。
// 三条任一命中即降级：
//   1) deviceMemory ≤ 4 —— Chrome 会取整到 0.25/0.5/1/2/4/8，≤4 是中低端机型；
//   2) Android 且硬件线程 ≤ 4 —— 主线程与 GPU 都紧张，是判据 1 报不准时的补充；
//   3) Android 且 Chrome 主版本 < 87 —— 老 WebView 本身性能差、渲染 bug 多
//      （合成层降质会让整片文字发虚，见 global.css 低配段的说明），
//      目标设备 Chrome 80 从这条稳稳命中。
// 刻意保守：任何一项拿不到就跳过该项，宁可留着玻璃质感，也不要误降好设备
// （比如桌面弱机不命中任何一条，就保持完整玻璃效果）。
(function() {
  try {
    var ua = navigator.userAgent || '';
    var isAndroid = ua.indexOf('Android') !== -1;
    var low = false;

    var mem = Number(navigator.deviceMemory || 0);
    if (mem > 0 && mem <= 4) low = true;

    var cores = Number(navigator.hardwareConcurrency || 0);
    if (isAndroid && cores > 0 && cores <= 4) low = true;

    if (isAndroid) {
      var m = /Chrome\/(\d+)/.exec(ua);
      if (m && Number(m[1]) < 87) low = true;
    }

    if (low) document.documentElement.className += ' low-perf';
  } catch (e) {
    // 探测失败按"性能足够"处理
  }
})();

// :focus-visible 能力探测（Chrome 86 才支持，设备基线是 Chrome 80）。
// 不支持时给 <html> 加 .no-focus-visible —— 否则 global.css 里那条
// `.btn:focus-visible { outline: … }` 会被**整条丢弃**（选择器列表里只要有一个
// 内核无法解析的伪类，整条规则失效），于是点过的按钮会一直挂着 UA 默认焦点环，
// 实测在目标平板上是一圈很扎眼的**黄框**（触屏上焦点不会自己离开）。
//
// 判据用 document.querySelector(':focus-visible')：
//   不支持的内核 → 选择器无法解析，**抛 SyntaxError**；
//   支持的内核   → 返回 null（当前没有匹配元素）。
// 比 CSS.supports('selector(:focus-visible)') 可靠：后者要 Chrome 83+ 才认得
// selector() 语法，在我们要保护的 80 上同样给假阴性。
//
// 这里只负责"标注内核不支持"，真正的显隐切换交给 kbd-focus 类：
// 触屏点击不留环（正确观感），但按 Tab 时把环还回来（键盘可达性不降级）。
(function() {
  var root = document.documentElement;
  var supported = false;
  try {
    document.querySelector(':focus-visible');
    supported = true;
  } catch (e) {
    supported = false;
  }
  if (supported) return;

  root.className += ' no-focus-visible';

  // 捕获阶段监听：即使某个组件里 stopPropagation 也挡不住它。
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Tab') root.classList.add('kbd-focus');
  }, true);
  document.addEventListener('mousedown', function() {
    root.classList.remove('kbd-focus');
  }, true);
  document.addEventListener('touchstart', function() {
    root.classList.remove('kbd-focus');
  }, { capture: true, passive: true });
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

// 免登失败必须说清原因：学生是从 ClassIntra 点进来的，落地却看到 Cluss 登录页，
// 不解释一句他只会以为「坏了」。文案按失败类型分（见 describeBootFailure）。
var bootFailure = '';

// ClassIntra 免登：联动应用壳以 ?token= 注入 CI 签发的 JWT（hash 路由下 query 在 # 之前，
// 直接读 location.search）。校验完成后立即把 token 从地址栏抹掉，避免残留在历史记录。
// 必须等校验结束再挂载应用，否则路由守卫会抢先把未登录状态弹回登录页。
// ⚠️ 这段时间页面是空的 —— 所以 index.html 里备了启动占位（只在带 token 时显示）。
var bootReady = (function() {
  var m = /[?&]token=([^&#]+)/.exec(window.location.search);
  if (!m) return Promise.resolve();
  var token = decodeURIComponent(m[1]);
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  } catch (e) { /* replaceState 失败不影响主流程，仅残留地址栏 */ }
  return store.dispatch('auth/acceptExternalToken', token).catch(function(e) {
    bootFailure = describeBootFailure(e);
    console.warn('[Boot] ClassIntra 免登失败:', e && e.message);
  });
})();

// 把免登失败翻译成学生看得懂的一句话（要短：toast 3.2 秒就收了）
function describeBootFailure(err) {
  var resp = err && err.response;
  var body = resp && resp.data;
  if (!resp) {
    // 没有响应 = 压根没连上（超时 / 断网 / 后端没起来）
    return '连不上 Cluss 服务，免登未完成';
  }
  if (body && body.code === 401) {
    return 'ClassIntra 登录已过期，请回到 ClassIntra 重新进入';
  }
  var detail = (body && body.message) || err.message || '';
  return 'ClassIntra 免登未成功' + (detail ? '：' + detail : '');
}

bootReady.then(function() {
  // 收掉启动占位的标记类：挂载会整体替换 #app 的内容，占位节点本身随之消失，
  // 这里只需要别让那个类继续挂在 <html> 上
  document.documentElement.classList.remove('boot-embedded');

  new Vue({
    router: router,
    store: store,
    render: function(h) { return h(App); }
  }).$mount('#app');

  // 挂载之后再提示：App.vue 的 toast 监听器是在挂载时才注册的，
  // 提前 dispatch 没人接（且 3.2 秒自动收起的定时器也不会启动）
  if (bootFailure) showToast(bootFailure, 'error');
});