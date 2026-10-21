// 「默认打开页」的**唯一实现**。
//
// 为什么值得单独一个文件（本项目其它地方尽量不新建 utils）：
//   这份偏好有**一个写入点**（设置弹窗）和**两个生效点** ——
//   ① 登录成功后的落地页；② 已登录的人再次打开应用。
//   早先三处各写一份，于是必然漂移：
//     · 设置里写了 localStorage，但打开应用时根本没人读它
//       （已登录不经过登录页 → 改完永远不生效）；
//     · Login.vue 手里只有一份路径数组，没有键名/校验；
//     · 而它判断 `query.redirect` 用的是 truthy —— 直接打开应用时守卫会带上
//       `?redirect=/`，于是"根路径的默认值"把学生的设置整条盖掉。
//
// 语义：**下一次打开应用**时落到哪一页。改完不会把学生从当前页面弹走。

export var HOME_PAGE_KEY = 'cluss_home_page';

// 值就是路由路径。新增一项要同步 router/index.js 里确实存在该路由
export var HOME_PAGES = [
  { value: '/', label: '对话' },
  { value: '/study', label: '学习' },
  { value: '/wrong-book', label: '错题本' },
  { value: '/notes', label: '笔记' }
];

var VALID = HOME_PAGES.map(function (p) { return p.value; });

// 未设置 / 非法值 / 隐私模式取不到 → 兜底对话页（保持原行为）
export function readHomePage() {
  try {
    var v = localStorage.getItem(HOME_PAGE_KEY);
    if (VALID.indexOf(v) !== -1) return v;
  } catch (e) { /* 隐私模式拿不到 localStorage，忽略 */ }
  return '/';
}

export function writeHomePage(value) {
  if (VALID.indexOf(value) === -1) return false;
  try {
    localStorage.setItem(HOME_PAGE_KEY, value);
    return true;
  } catch (e) {
    // 隐私模式 / 存储被禁用：本次会话内设置项仍显示成已选，只是不会被记住
    return false;
  }
}

// 「这一次该落到哪」：明确的来源跳转优先，其次才是默认打开页。
//
// ⚠️ redirect 为 `/` 时**不算明确来源**：
//   直接打开应用（未登录）会被守卫以 `?redirect=/` 弹回登录页，
//   那只是根路径的默认值，不是"他本来想去对话页"。
//   早先按 truthy 判断，于是登录路径上设置同样被盖掉。
//
// 只接受以单个 `/` 开头的应用内路径，避免 ?redirect=//evil.com 或
// ?redirect=https://evil.com 这类开放重定向。
export function resolveLanding(redirect) {
  var r = String(redirect || '');
  var safe = r.charAt(0) === '/' && r.charAt(1) !== '/';
  if (safe) {
    var path = r.split('?')[0].split('#')[0];
    // 根路径 = 守卫的默认值，不是学生的明确意图 → 继续往设置里看
    if (path !== '/') return r;
  }
  return readHomePage();
}
