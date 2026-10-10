// ============================================================
// 设备方向的**唯一真相源**
// ============================================================
//
// 为什么要有这个文件：方向判定原来散在四个地方各算各的 ——
//   mixins/orientation.js（写 html.is-portrait / html.use-drawer）
//   TabBar.vue::sync（决定底栏显不显示）
//   Study.vue::checkOrientation（用视口比例覆写组件里的 isPortrait）
//   CSS @media (orientation: ...)（视口比例）
// 任何两处不一致，屏幕上就会出现「同一页一半横、一半竖」。
// 现在改成：**只有这里算方向，其他人只订阅**。
//
// ------------------------------------------------------------
// 判据为什么不能首选 screen.orientation.type（2026-10-10 实测）
// ------------------------------------------------------------
// 受管平板（Android WebView / X5 内核）上实测到：
//
//   竖屏握持时   screen.orientation.type = 'landscape-primary'   ← 撒谎
//                screen.width/height     = 680 × 960             ← 是对的
//                innerWidth/Height       = 680 × 960             ← 是对的
//
// 而 orientationchange 事件在这种"方向没被系统重新广播"的场景下也不会派发，
// 于是旧实现（首选 so.type，有值就直接 return）整页判成横屏，
// **重新进入 App 也不会自愈** —— 就是学生看到的「竖屏进去，变横屏样式，还退不出来」。
//
// 所以判据改成**几何优先**：
//   ① screen.width/height —— 几何量，不受软键盘影响，实测随方向更新
//   ② screen.orientation.type —— 键盘安全，但如上所述可能是陈旧值，只作备选
//   ③ 视口比例 —— 唯一会被软键盘影响的，只作最后兜底
//
// 一个有用的不对称性：软键盘只会让视口变**矮**（更"横"），绝不会把视口变成竖的。
// 所以「屏幕说竖、视口说横」= 键盘压的，仍信屏幕；反过来「屏幕说横、视口说竖」
// 只能是屏幕尺寸不随方向更新，那就信视口。

var DRAWER_MAX_WIDTH = 1024;   // 超过这个宽度就不必用抽屉（窄竖屏才要）

var state = { portrait: false, useDrawer: false };
var listeners = [];
var started = false;
var queued = false;

function num(v) {
  return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
}

// 物理屏幕尺寸（几何量）
function screenPortrait() {
  var sw = 0, sh = 0;
  try {
    sw = num(window.screen.width);
    sh = num(window.screen.height);
  } catch (e) { /* 拿不到就算不可用 */ }
  if (sw && sh && sw !== sh) return sw < sh;
  return null;
}

// 设备方向 API（可能陈旧）
function apiPortrait() {
  try {
    var so = window.screen && window.screen.orientation;
    if (so && typeof so.type === 'string') {
      if (so.type.indexOf('portrait') === 0) return true;
      if (so.type.indexOf('landscape') === 0) return false;
    }
  } catch (e) { /* 老 WebView 没有 */ }
  return null;
}

export function detectPortrait() {
  var byScreen = screenPortrait();
  var byViewport = window.innerHeight >= window.innerWidth;

  if (byScreen === null) {
    var byApi = apiPortrait();
    return (byApi === null) ? byViewport : byApi;
  }
  // 两者一致 → 高置信，直接用
  if (byScreen === byViewport) return byScreen;
  // 屏幕说竖、视口说横 → 视口被软键盘压扁了，方向仍是竖
  if (byScreen === true) return true;
  // 屏幕说横、视口说竖 → 屏幕尺寸大概率不随方向更新，信视口
  return byViewport;
}

function syncClasses() {
  var root = document.documentElement;
  root.classList.toggle('is-portrait', state.portrait);
  root.classList.toggle('use-drawer', state.useDrawer);
}

function notify() {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](state); } catch (e) { /* 单个订阅者出错不拖垮其他 */ }
  }
}

function compute() {
  var portrait = detectPortrait();
  var useDrawer = portrait && window.innerWidth <= DRAWER_MAX_WIDTH;

  if (portrait === state.portrait && useDrawer === state.useDrawer) {
    // 值没变也要重写一次类：类名可能被外部（历史代码 / 切页残留）改坏
    syncClasses();
    return;
  }

  state.portrait = portrait;
  state.useDrawer = useDrawer;
  syncClasses();
  notify();
}

export function getOrientation() {
  return state;
}

export function refreshOrientation() {
  compute();
  // 个别 WebView 在页面刚恢复时几何量还没刷新出来，隔几拍再校一次
  setTimeout(compute, 60);
  setTimeout(compute, 320);
}

// 订阅方向变化；立即回调一次当前值。返回退订函数。
export function subscribeOrientation(fn) {
  listeners.push(fn);
  try { fn(state); } catch (e) { /* ignore */ }
  return function () {
    for (var i = 0; i < listeners.length; i++) {
      if (listeners[i] === fn) { listeners.splice(i, 1); break; }
    }
  };
}

// 全局只需调用一次（main.js）。此后方向类的维护与页面的生灭无关。
export function startOrientation() {
  if (started) return;
  started = true;

  function schedule() {
    if (queued) return;
    queued = true;
    var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
    raf(function () {
      queued = false;
      compute();
    });
  }

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  try {
    if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
      window.screen.orientation.addEventListener('change', schedule);
    }
  } catch (e) { /* ignore */ }

  // ⚠️ 关键补丁：从后台 / 别的 App 回来时，Android WebView 常常**不派发**
  // resize / orientationchange，方向会永远停在离开时的旧值（"重进也没彻底退出"）。
  // 这三个入口把它兜住。pageshow 还覆盖 bfcache 恢复。
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshOrientation();
  });
  window.addEventListener('pageshow', refreshOrientation);
  window.addEventListener('focus', refreshOrientation);

  // 冷启动第一帧的读数可能是陈旧的，多校几次
  compute();
  setTimeout(compute, 80);
  setTimeout(compute, 400);
  setTimeout(compute, 1200);
}
