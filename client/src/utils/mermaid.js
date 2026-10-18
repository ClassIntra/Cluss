/**
 * Mermaid 图表渲染
 *
 * 把 Markdown 里的 ```mermaid 代码块变成真正的 SVG。markdown.js 只负责
 * 产出占位容器（.mermaid-chart[data-code]），真正的渲染在这里。
 *
 * 三个设计决定都是被「聊天页流式输出」这个场景逼出来的：
 *
 * 1) **按需加载**。mermaid 打包后约 3MB，学生可能一整天都碰不到一次图表；
 *    静态 import 会让每个页面首屏都背上它。所以第一次真出现图表才 import()。
 *
 * 2) **按 主题+代码 缓存 SVG**。聊天页每收到几个字就把整条消息重新 v-html 一遍，
 *    已经画好的 <svg> 会被整块替换掉。缓存命中时**同步**填回去 ——
 *    updated 钩子跑在浏览器绘制之前，学生看不到"空一下又出来"的闪烁。
 *
 * 3) **串行渲染**。mermaid.render 内部共用全局配置与临时 DOM，并发调用会互相踩，
 *    所以排队一个一个来。
 *
 * 另外：流式时围栏还没闭合（data-pending="1"）的图表**不渲染**，
 * 保持骨架动画。半截代码只会渲染失败并闪一下红色报错，比不画更糟。
 */
var loadPromise = null;
var initedTheme = null;
var seq = 0;
var svgCache = Object.create(null);   // key → svg 字符串
var errCache = Object.create(null);   // key → 错误文案
var tail = Promise.resolve();         // 渲染队列

function cacheKey(code, isDark) {
  return (isDark ? 'd:' : 'l:') + code;
}

// ---------- 懒加载 ----------

function loadMermaid() {
  if (!loadPromise) {
    loadPromise = import('mermaid').then(function(mod) {
      return mod && mod.default ? mod.default : mod;
    });
  }
  return loadPromise;
}

// 预热 mermaid：提前加载 + 按当前主题初始化。
//
// 为什么需要它 —— 这是「图表渲染太慢」的主因：
//   mermaid 679KB（比 katex 还大一倍），而它原先**只在真的要画图的那一刻**
//   才开始下载（唯一触发点是 renderMermaidCharts）。于是 AI 回答里一出现图表，
//   学生就要眼睁睁等 679KB 下载完 + 初始化，图才慢慢显出来。
//   实测渲染本身只要几毫秒 —— 大量时间是在等下载，不是在画。
//
// 调用时机：① 页面空闲时（与 katex 同样"等首屏画完再拉"的门控）；
//   ② 每次发问时 —— AI 生成通常要几秒到几十秒，足够把库拉下来，
//   而这正好覆盖"学生打开页面立刻就提问"的极端情况。
// 幂等，重复调用无副作用。
export function ensureMermaid(isDark) {
  var dark = typeof isDark === 'boolean'
    ? isDark
    : document.documentElement.getAttribute('data-theme') === 'dark';
  return loadMermaid().then(function(mermaid) {
    ensureInit(mermaid, dark);
    return mermaid;
  });
}

// ---------- 初始化 ----------

function ensureInit(mermaid, isDark) {
  var theme = isDark ? 'dark' : 'default';
  if (initedTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: theme,
    // antiscript：允许标签里的 <br> 之类（流程图的换行靠它），但会摘掉脚本；
    // loose 完全不设防（模型输出可被提示注入影响，不能给），
    // strict 会把 <br> 转义成可见文本，流程图标签直接变丑。
    securityLevel: 'antiscript',
    fontFamily: 'inherit',
    // 出错时不要往页面里塞那个巨大的错误 SVG（默认行为），
    // 失败态交给我们自己的 .mermaid-error 渲染
    suppressErrorRendering: true,
    flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    mindmap: { useMaxWidth: true, padding: 16 },
    pie: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    state: { useMaxWidth: true },
    class: { useMaxWidth: true },
    er: { useMaxWidth: true },
    timeline: { useMaxWidth: true }
  });
  initedTheme = theme;
}

// ---------- 安全：只做减法 ----------

/**
 * 摘掉 SVG 里**可执行**的东西。
 *
 * 为什么不是整体过一遍 DOMPurify：mermaid 自己已经用 DOMPurify 处理过
 * 标签内容（securityLevel='antiscript' 就在做这件事），而完整的
 * DOMPurify 重建会把 <style> 与 <foreignObject> 一起削掉 ——
 * 甘特图的配色、带 HTML 标签的流程图会直接画不出来。
 * 所以这里只剥脚本与事件属性，不碰结构。
 *
 * 顺带一提：innerHTML 插入的 <script> 本来就不会执行，
 * 真正有威胁的是 on* 事件属性与 javascript: 链接，这两类都在下面挡掉。
 */
function stripExecutable(svg) {
  return String(svg)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(iframe|object|embed|link|meta)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|xlink:href)\s*=\s*(["'])\s*(?:javascript|data:text\/html|vbscript)[^"']*\2/gi, '$1=$2#$2');
}

// ---------- 单张渲染 ----------

function renderOne(mermaid, code, isDark) {
  ensureInit(mermaid, isDark);
  var id = 'cluss-mmd-' + (++seq);
  return Promise.resolve(mermaid.render(id, code)).then(function(res) {
    var svg = typeof res === 'string' ? res : (res && res.svg) || '';
    if (!svg) throw new Error('渲染结果为空');
    var safe = stripExecutable(svg);
    if (safe.indexOf('<svg') === -1) throw new Error('渲染结果异常');
    return safe;
  });
}

function enqueue(fn) {
  var run = tail.then(fn, fn);          // 前一个失败也要接着排
  tail = run.then(function() {}, function() {});
  return run;
}

// ---------- DOM 操作 ----------

function readCode(el) {
  var raw = el.getAttribute('data-code');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    return raw;
  }
}

/**
 * 读这张图的「自然宽度」—— mermaid 的 useMaxWidth 会把它写进内联 max-width，
 * 取不到时退回 viewBox 宽度（两者在实践中一致）。
 *
 * 为什么非要它：气泡宽度是固定的，而图有宽有窄（4 节点流程图 250，甘特图 960）。
 * 不按各自的自然宽去夹，就只能一律拉满容器 —— 小图被放大 2.6 倍（字比正文大三倍、
 * 一张 4 节点图占满整整一屏），大图被压成缩略图（手机上甘特图的字只剩 3px）。
 */
function naturalWidthOf(svg) {
  var m = /max-width:\s*([\d.]+)px/.exec(svg.getAttribute('style') || '');
  if (m) return parseFloat(m[1]);
  var vb = svg.getAttribute('viewBox');
  if (vb) {
    var w = parseFloat(vb.trim().split(/[\s,]+/)[2]);
    if (w > 0) return w;
  }
  return 0;
}

// 可读性下限。mermaid 的字号是 16px（viewBox 单位），缩到 0.6875 时字只剩 11px ——
// 再往下就吃力了。低于这条线就不再缩，改为让容器横向滚动，把"看不清"换成"要滑一下"。
var MIN_LEGIBLE = 11 / 16;

function paintSvg(el, svg) {
  el.innerHTML = svg;
  el.setAttribute('data-state', 'done');
  var s = el.querySelector('svg');
  if (!s) return;

  var natural = naturalWidthOf(s);
  s.style.width = '100%';
  s.style.height = 'auto';
  s.style.maxWidth = natural ? natural + 'px' : '100%';
  s.style.minWidth = natural ? Math.round(natural * MIN_LEGIBLE) + 'px' : '';

  // 展开提示与按压反馈挂在 wrapper 上（挂在滚动容器里会跟着内容滑走，见 global.css）
  var wrap = el.closest && el.closest('.mermaid-chart-wrapper');
  if (wrap) wrap.classList.add('is-done');
  // 刻意不在这里判断"要不要横向滚动"并打标记：那个结论依赖容器当前宽度，
  // 而旋屏、抽屉开合都会改宽度，JS 只算一次就必然过期（本轮走查实测到了）。
  // 宽度夹取交给 CSS 的 width/max-width/min-width 实时算，溢出与否由此天然正确。
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 图没了（改坏语法、或主题切换要重画）时，wrapper 上的"可点开"状态必须一起撤掉 ——
// 否则会留着一个点不开的角标，比不给提示更糟。
// 用 closest 而不是 parentNode：结构万一多包一层，parentNode 会静默指错地方。
function clearWrapperState(el) {
  var wrap = el && el.closest && el.closest('.mermaid-chart-wrapper');
  if (wrap) wrap.classList.remove('is-done');
}

function paintError(el, message) {
  el.setAttribute('data-state', 'error');
  clearWrapperState(el);
  // 报错文案里带上原始定义：学生可以自己核对，也能整段复制走。
  // 默认折叠 —— 学生要的是"这张图没画出来"，不是一屏代码。
  el.innerHTML =
    '<div class="mermaid-error">' +
      '<div class="mermaid-error-title">这张图没能画出来</div>' +
      '<div class="mermaid-error-hint">图表定义可能不完整，或者用到了不支持的写法。</div>' +
      '<details class="mermaid-error-detail"><summary>查看图表定义</summary>' +
        '<pre>' + escapeHtml(readCode(el)) + '</pre>' +
      '</details>' +
      (message ? '<div class="mermaid-error-msg">' + escapeHtml(message) + '</div>' : '') +
    '</div>';
}

// ---------- 对外入口 ----------

/**
 * 扫描 root 下所有待渲染的图表并画出来。
 * 由 mixins/mermaid.js 在 mounted / updated 后调用，无需手动调。
 *
 * @param {Element} root  组件根元素
 * @param {boolean} isDark 当前是否深色主题（决定 mermaid 主题，也进缓存 key）
 */
export function mountMermaidCharts(root, isDark) {
  if (!root || !root.querySelectorAll) return;

  var nodes = root.querySelectorAll('.mermaid-chart');
  if (!nodes.length) return;

  var todo = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var state = el.getAttribute('data-state');
    if (state === 'done' || state === 'rendering' || state === 'error') continue;

    var code = readCode(el);
    if (!code) continue;

    // 流式还没写完：保持骨架，别去画半截代码
    if (el.getAttribute('data-pending') === '1') continue;

    var key = cacheKey(code, isDark);
    if (svgCache[key]) { paintSvg(el, svgCache[key]); continue; }
    if (errCache[key]) { paintError(el, errCache[key]); continue; }

    el.setAttribute('data-state', 'rendering');
    todo.push({ el: el, code: code, key: key });
  }

  if (!todo.length) return;

  loadMermaid().then(function(mermaid) {
    for (var k = 0; k < todo.length; k++) {
      (function(item) {
        enqueue(function() {
          return renderOne(mermaid, item.code, isDark).then(function(svg) {
            svgCache[item.key] = svg;
            paintSvg(item.el, svg);
          }).catch(function(err) {
            var msg = (err && (err.message || String(err))) || '';
            // 只是日志噪音：mermaid 的报错文本很长，但对定位问题有用
            console.warn('[mermaid] 渲染失败:', msg);
            errCache[item.key] = msg;
            paintError(item.el, msg);
          });
        });
      })(todo[k]);
    }
  }).catch(function(err) {
    console.warn('[mermaid] 加载失败:', err);
    for (var k = 0; k < todo.length; k++) {
      paintError(todo[k].el, '图表组件没能加载');
    }
  });
}

/** 主题切换后调用：丢掉"已渲染"标记，让下一次扫描按新主题重画。 */
export function invalidateMermaidCharts(root) {
  if (!root || !root.querySelectorAll) return;
  var nodes = root.querySelectorAll('.mermaid-chart[data-state]');
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].removeAttribute('data-state');
    clearWrapperState(nodes[i]);
  }
}
