// 部署基址推导 —— 同一份构建产物同时支持「根路径」与「子路径」两种挂载方式。
//
// 背景（为什么要这个文件）：
//   Cluss 独立部署时是 http://<host>:9003/（基址 `/`）；
//   ClassIntra 的 HTTPS 站点（443）则以**同源反代**把它挂在 /cluss/ 下，
//   用来绕开「HTTPS 页面内嵌 HTTP 站点 → 浏览器按混合内容直接拦截」。
//   两种挂载下：
//     · 静态资源（js/css/字体）由 vite 的 base:'./' 在构建期转成相对路径，
//       无论挂在哪儿都指得对；
//     · API 前缀必须跟着**当前页面的路径深度**走 —— 这就是本文件唯一的职责。
//
// 为什么能靠运行时推导（而不是构建两份）：
//   Cluss 用的是 hash 路由，`#` 之后的内容浏览器根本不上送服务器，
//   所以 /cluss/ 下无论切到哪个页面，location.pathname 恒为 /cluss/，
//   推导结果恒定。换成 history 路由就会被深路径带偏（那是另一套 base 方案）。
//
// 推导规则：
//   /          → /          独立部署（9003 直连）
//   /cluss/    → /cluss/    CI 反代挂载
//   /cluss     → /cluss/    反代侧会把无斜杠请求 302 到带斜杠，这里是兜底
//   末段看起来像文件名（含 .）时先剥掉它，避免 /cluss/index.html 被当成目录

function computeBasePath() {
  try {
    var segs = window.location.pathname.split('/').filter(function(s) { return s.length > 0; });
    if (segs.length && segs[segs.length - 1].indexOf('.') !== -1) segs.pop();
    return segs.length ? '/' + segs.join('/') + '/' : '/';
  } catch (e) {
    // 取不到 location（极端环境）时按独立部署处理，绝不抛错阻断启动
    return '/';
  }
}

export var basePath = computeBasePath();

// API 根前缀。所有对 /api 的请求都必须经它拼接，不允许再出现裸 '/api' 字面量 ——
// 否则挂到子路径时请求会打到宿主的 /api 上（ClassIntra 自己的接口），
// 表现为「Cluss 页面起来了但一发请求就是 CI 的数据 / 401」。
export var apiBase = basePath + 'api';

// 便捷函数：apiUrl('/auth/login') → '/api/auth/login' 或 '/cluss/api/auth/login'
export function apiUrl(p) {
  var path = String(p || '');
  if (path.charAt(0) === '/') path = path.slice(1);
  return apiBase + '/' + path;
}

export default basePath;
