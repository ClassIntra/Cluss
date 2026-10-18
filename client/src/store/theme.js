// 主题（浅色 / 深色）
//
// 按项目决定：**只做手动切换**，不读系统 prefers-color-scheme。
// 好处是行为可预测——学生选了深色，就不会因为系统设置在晚上自动变回去。
//
// 实现要点：主题通过 <html data-theme="dark"> 生效，
// 所有颜色都走 CSS 变量，所以切换只是改一个属性，不触发任何组件重渲染。

var STORAGE_KEY = 'cluss_theme';
var THEMES = ['light', 'dark'];

// 主题色 meta：影响移动端浏览器地址栏/状态栏的着色
var THEME_COLOR = {
  light: '#eef1f8',
  dark: '#14161d'
};

function readStored() {
  try {
    var v = localStorage.getItem(STORAGE_KEY);
    return THEMES.indexOf(v) !== -1 ? v : 'light';
  } catch (e) {
    return 'light';
  }
}

// 主题切换的过渡窗口（毫秒）。比 CSS 里的 0.22s 略长，确保样式落定后再摘类。
var TRANSITION_CLASS = 'theme-switching';
var TRANSITION_MS = 260;
var transitionTimer = null;

// 把主题应用到 DOM（store 与 index.html 的内联脚本共用同一套约定）
//
// opts.instant —— 不做过渡，直接切。
//   必须区分这两条路径：**启动时**应用主题是"把页面画成它本该有的样子"，
//   带上过渡就变成了"从浅色渐变到深色"的闪动（深色用户每次启动都会看到）。
//   只有用户主动点切换，那次变化才值得动画。
function applyToDom(theme, opts) {
  var t = THEMES.indexOf(theme) !== -1 ? theme : 'light';
  var root = document.documentElement;

  if (!(opts && opts.instant)) {
    root.classList.add(TRANSITION_CLASS);
    if (transitionTimer) clearTimeout(transitionTimer);
    transitionTimer = setTimeout(function() {
      root.classList.remove(TRANSITION_CLASS);
      transitionTimer = null;
    }, TRANSITION_MS);
  }

  root.setAttribute('data-theme', t);

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[t]);
}

var state = {
  theme: readStored()
};

var getters = {
  theme: function(state) { return state.theme; },
  isDark: function(state) { return state.theme === 'dark'; }
};

var mutations = {
  SET_THEME: function(state, theme) {
    var t = THEMES.indexOf(theme) !== -1 ? theme : 'light';
    state.theme = t;
    try { localStorage.setItem(STORAGE_KEY, t); } catch (e) { /* 隐私模式下会抛，忽略 */ }
    applyToDom(t);
  }
};

var actions = {
  setTheme: function(context, theme) {
    context.commit('SET_THEME', theme);
  },

  toggleTheme: function(context) {
    context.commit('SET_THEME', context.state.theme === 'dark' ? 'light' : 'dark');
  }
};

export default {
  namespaced: true,
  state: state,
  getters: getters,
  mutations: mutations,
  actions: actions
};

export { applyToDom, THEMES };
