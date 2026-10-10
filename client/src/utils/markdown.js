import { marked } from 'marked';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';

// ---- katex 按需加载（322KB，曾是首屏最大的一块）----
//
// 为什么不能静态 import：Chat 页静态引本文件，katex 就进了对话页的
// 首屏关键路径 —— 学生一打开页面就要先解析 322KB 的公式引擎，
// 哪怕首屏一个公式都没有。实测冷加载时间线上 katex 在 56ms 就开始拉，
// 在低端设备上这段解析要几百毫秒，直接把首屏绘制往后顶
//（用户实测 LCP 2.74s；内联掉主线程占用后依然如此，瓶颈就是它）。
//
// 现在：katex 走动态 import。首屏只出占位（<code> 原文公式），
// katex 到位后由 onKatexReady 的回调触发整篇重绘 ——
// 空态首屏完全不等它；带公式的历史只多等几百毫秒且立刻重绘。
//
// ⚠️ CSS 保留静态引入（23KB，JS 解析不受它阻塞）：公式一旦出现就必须有
//   正确的排版，晚到会闪一下无样式的公式。JS 才是那个该让路的。
var katexRef = null;        // katex 模块本体，加载完成后赋值
var katexCbs = [];          // 等 katex 的回调（重绘用）
var katexPromise = null;

// 预加载 katex：在 Chat 挂载后调用。不阻塞任何渲染 ——
// 空态先画，公式引擎在后台下载，等第一条 AI 回复到的时候早就绪了。
export function ensureKatex() {
  if (!katexPromise) {
    katexPromise = import('katex').then(function (m) {
      katexRef = m && m.default ? m.default : m;
      var cbs = katexCbs; katexCbs = [];
      cbs.forEach(function (cb) { try { cb(); } catch (e) { /* 单个回调失败不连坐 */ } });
    }).catch(function () {
      // 加载失败：保持 katexRef = null，renderMath 永远走占位降级，
      // 公式以 <code> 原文出现 —— 比整页白屏好得多
    });
  }
  return katexPromise;
}

// 当前 katex 引用（未加载时为 null）。给 latex-renderer 共用同一个加载器，
// 避免两个模块各拉一份。
export function getKatex() { return katexRef; }

// 空闲时预加载：给各页的 mounted 用。
//
// 为什么封装在这里：四个页面（Chat/Study/Writing/Notes）都需要同一套
// 「等首屏画完再拉」的门控。⚠️ 门控必须是 **FCP**，不是 requestIdleCallback
// —— 实测主线程在等 API 响应的空档就会触发 idle（页面首绘要等数据，
// 实测 idle 在 ~210ms 触发、FCP 在 368ms），katex 255KB 照样抢在首绘前
// 下载。等真实首绘事件，拿不到就 3 秒兜底（公式可能马上就要用，
// 页面再慢预拉也不能无限期不跑）。
export function ensureKatexIdle() {
  var started = false;
  function go() {
    if (started) return;
    started = true;
    ensureKatex();
  }
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) {
        if (e.name === 'first-contentful-paint') go();
      });
    }).observe({ type: 'paint', buffered: true });
  } catch (e) {
    // 观察器不可用（老内核）：退回 idle 门控，别把 katex 彻底弄没
    var idle = window.requestIdleCallback || function (fn) { setTimeout(fn, 600); };
    idle(go);
    return;
  }
  setTimeout(go, 3000);
}

// katex 就绪（或已就绪）时回调。用于「重绘带公式的已渲染内容」。
//
// ⚠️ 这里**故意不触发加载** —— 只登记回调。
//   曾在这里顺手调 ensureKatex()，结果 Chat 挂载时注册重绘回调
//   就等于立刻加载 255KB，把「空闲再加载」的门控整个架空
//   （实测 katex 在首屏绘制前就开拉）。加载时机是调用方的决策：
//   首屏页挂在空闲回调里，次级页面挂在自己的 mounted 里。
export function onKatexReady(cb) {
  if (katexRef) { cb(); return; }
  katexCbs.push(cb);
}

// ---------- 公式 ----------

function renderMath(tex, displayMode) {
  // katex 未就绪：先给原文占位。onKatexReady 的回调会让调用方整篇重绘，
  // 那时这里走真正的渲染分支。占位用 <code> —— 原文公式可读，不算空白。
  if (!katexRef) return '<code>' + escapeHtml(tex) + '</code>';
  try {
    return katexRef.renderToString(tex, {
      displayMode: displayMode,
      throwOnError: false,
      // 学生端可能有大量公式，strict 关掉避免无意义的警告噪音
      strict: false,
      trust: false
    });
  } catch (e) {
    return '<code>' + escapeHtml(tex) + '</code>';
  }
}

// Markdown + LaTeX + Mermaid 渲染
//
// 处理顺序很关键，每一步都有理由，别随手调换：
//
//   1. 剥掉 <wrong-items> 结构化数据（流式下第一帧起就不该露出）
//   2. 抽出围栏代码块 → 占位符（**必须在公式之前**）
//   3. 抽公式：块级 → 行内
//   4. 走 Markdown
//   5. 还原公式 / 还原代码块（Mermaid 代码块还原成待渲染容器）
//   6. DOMPurify 净化
//
// 为什么公式要先抽走再走 Markdown：
//   Markdown 会把公式里的 _ ^ \ 当作强调与转义处理，$x_i^2$ 会被拆坏。
// 为什么代码块要先抽走再抽公式：
//   代码里的 $ 不是公式（shell 的 $HOME、Python 的 f"${x}"、正则的 \$）。
//   不先隔开，代码块就会被抽得七零八落。
//
// 占位符用 NUL(\u0000) 包起来：它不可能出现在正常文本里，
// 且 Markdown 与 HTML 都不特殊对待它。

var T = '\u0000';

// ---------- 公式 ----------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

var mathStore = [];

// 轻量模式标志：只在 renderStream 期间置真（见文件末尾的 renderStream 说明）。
// 流式每帧都要重渲染整篇内容，而 KaTeX 是这条链路上最贵的一环 ——
// 轻量模式下公式暂存**原文**而不是渲染结果，等收尾再用完整渲染补真公式。
var lightMode = false;

function stashMath(tex, displayMode) {
  var idx = mathStore.length;
  // 两种存法靠类型区分：字符串 = 渲染好的 KaTeX HTML，对象 = 待补的公式原文
  mathStore.push(lightMode
    ? { raw: (displayMode ? '$$' : '$') + tex + (displayMode ? '$$' : '$') }
    : renderMath(tex, displayMode));
  return T + 'MATH' + idx + T;
}

function restoreMath(html) {
  return String(html).replace(/\u0000MATH(\d+)\u0000/g, function(_, idx) {
    var m = mathStore[Number(idx)];
    if (m == null) return '';
    // 轻量模式：公式先以原文露面。用 <code> 而不是裸文本，
    // 让它看起来像"还没排版的公式"，而不是一句莫名其妙的话。
    if (typeof m !== 'string') {
      return '<code class="math-pending">' + escapeHtml(m.raw) + '</code>';
    }
    return m;
  });
}

// ---------- 代码块 ----------

var blockStore = [];

// 抽出 ```/~~~ 围栏代码块，返回替换成占位符之后的文本
// closed=false 表示流式输出到一半、围栏还没闭合。
// 这个信息要一路带到 Mermaid 容器上：代码没写完时不能急着去渲染，
// 否则会先闪一下"语法错误"，等围栏闭合才变正常。
function extractFences(text) {
  var lines = String(text || '').split('\n');
  var out = [];
  var i = 0;

  while (i < lines.length) {
    var m = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/.exec(lines[i]);
    if (!m) {
      out.push(lines[i]);
      i++;
      continue;
    }

    var fenceChar = m[1][0];
    var fenceLen = m[1].length;
    var lang = (m[2] || '').toLowerCase();
    var body = [];
    var closed = false;
    var j = i + 1;

    while (j < lines.length) {
      var cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
      if (cm && cm[1][0] === fenceChar && cm[1].length >= fenceLen) {
        closed = true;
        break;
      }
      body.push(lines[j]);
      j++;
    }

    var idx = blockStore.length;
    blockStore.push({ lang: lang, code: body.join('\n'), closed: closed });
    out.push(T + 'BLOCK' + idx + T);
    i = closed ? j + 1 : j;
  }

  return out.join('\n');
}

// ```latex 块整个当**块级公式**处理：
// AI 有时会把公式整段塞进代码块，照代码渲染出来就是一堆反斜杠。
function isMathFence(lang) {
  return lang === 'latex' || lang === 'tex' || lang === 'math';
}

function renderCodeBlockHtml(code, lang) {
  var cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
  var label = lang ? '<div class="code-lang">' + escapeHtml(lang) + '</div>' : '';
  return '<div class="code-block">' + label + '<pre><code' + cls + '>' +
    escapeHtml(code) + '</code></pre></div>';
}

function renderMermaidHtml(code, closed) {
  // data-code 用 encodeURIComponent：产物只有 ASCII，双引号与 & 都被转义，
  // 放进双引号属性里绝对安全，读回来也不可能有编码歧义。
  // （不用 btoa：它对非 Latin1 会直接抛，中文标签就废了。）
  return '<div class="mermaid-chart-wrapper">' +
    '<div class="mermaid-chart"' +
      ' data-code="' + escapeHtml(encodeURIComponent(code)) + '"' +
      (closed ? '' : ' data-pending="1"') + '>' +
      '<div class="mermaid-skeleton"><i class="mermaid-spin"></i>' +
        (closed ? '正在绘制图表…' : '图表生成中…') +
      '</div>' +
    '</div>' +
  '</div>';
}

function blockHtml(idx) {
  var b = blockStore[idx];
  if (!b) return '';
  if (isMathFence(b.lang)) {
    // 轻量模式不跑 KaTeX：公式块按代码块原样给出，收尾的完整渲染会换成真公式
    if (lightMode) return renderCodeBlockHtml(b.code, b.lang);
    return renderMath(b.code.trim(), true);
  }
  // 轻量模式下图表一律挂骨架（closed=false → data-pending）：
  // 流式每帧都会整块重建 DOM，真去画的话每帧都要把整张 SVG 重新 innerHTML 一遍，
  // 缓存省掉的只是 mermaid.render，插 DOM 这一下照样很贵。收尾再画。
  if (b.lang === 'mermaid') return renderMermaidHtml(b.code, lightMode ? false : b.closed);
  return renderCodeBlockHtml(b.code, b.lang);
}

function restoreBlocks(html) {
  var s = String(html);
  // marked 会把独占一行的占位符包进 <p>，先连壳一起换掉，别留下空段落
  s = s.replace(/<p>\s*\u0000BLOCK(\d+)\u0000\s*<\/p>/g, function(_, i) {
    return blockHtml(Number(i));
  });
  // 兜底：夹在段落中间的代码块
  s = s.replace(/\u0000BLOCK(\d+)\u0000/g, function(_, i) {
    return blockHtml(Number(i));
  });
  return s;
}

// ---------- 公式抽取 ----------

// 块级：$$...$$ 与 \[...\]
function extractDisplayMath(text) {
  var out = String(text);
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, function(_, tex) {
    return stashMath(tex.trim(), true);
  });
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, function(_, tex) {
    return stashMath(tex.trim(), true);
  });
  return out;
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

// 行内：$...$，逐字符扫描
//
// 为什么不用一个正则就完事 —— 这里踩过一个真实的坑：
//   早先写的是 /(^|[^\d$])\$([^\n$]+?)\$([^\d$]|$)/g，
//   把公式两侧的字符一起并进了匹配里。String.replace 会把扫描位置推过
//   **整个匹配**，于是紧跟其后的那个 $ 再也没机会当"开括号"：
//     $a$ $b$ $c$        → 只认第一对，第二个 $ 被当成上一对的尾巴吃掉
//     $\cos x=1$（$x=2k\pi$）→ 第二个公式整段变字面量，反斜杠都露在外面
//   而且一旦错位就会连锁：后面每一对都跟着错开一格，整段排版全乱。
//   断言（(?=...)）能不消费字符，但保险起见这里直接手写扫描，
//   把"什么时候算开括号、什么时候算闭括号"写死成可读的规则。
//
// 扫描规则：
//   开 $：前面不是数字（$5 是金额不是公式）、后面不是空白与 $
//   闭 $：同一行内、未被 \ 转义、**前面不是空白**、后面不紧跟数字
//
//   为什么闭括号前面不能是空白：
//     `花 $5 买 $x$ 个` —— 第一个 $ 的候选闭括号是 `买 ` 后面那个 $，
//     但它前面是空格：公式不会以空格结尾，而"$5 买 "这种金额+中文才会。
//     靠这一条就能把金额放过去（继续找下一个 $），同时不影响
//     `$x = 1$`（闭括号前是 `1`）这类真的公式。
//     只挡"后面跟数字"是不够的：那样 $5 和 $10 元 会让 $10 那个 $ 变成开括号。
//
//   已经在围栏代码块里的内容根本到不了这里（extractFences 先抽走了）；
//   行内代码 `...` 里的 $ 在这里跳过。
function extractInlineMath(text) {
  var s = String(text);
  var n = s.length;
  var out = '';
  var i = 0;

  while (i < n) {
    var ch = s[i];

    // 转义字符整对跳过：\$ 不是公式
    if (ch === '\\' && i + 1 < n) {
      out += ch + s[i + 1];
      i += 2;
      continue;
    }

    // 行内代码：找等长的反引号串配对，中间原样带过
    if (ch === '`') {
      var run = 1;
      while (i + run < n && s[i + run] === '`') run++;
      var marker = s.slice(i, i + run);
      var close = s.indexOf(marker, i + run);
      if (close !== -1) {
        out += s.slice(i, close + run);
        i = close + run;
        continue;
      }
      out += s.slice(i, i + run);
      i += run;
      continue;
    }

    if (ch !== '$') {
      out += ch;
      i++;
      continue;
    }

    // 开括号守卫
    if (i > 0 && isDigit(s[i - 1])) { out += ch; i++; continue; }
    var next = s[i + 1];
    if (next === undefined || next === ' ' || next === '\t' || next === '$') {
      out += ch;
      i++;
      continue;
    }

    // 找闭括号
    var j = i + 1;
    var closed = -1;
    while (j < n) {
      var c = s[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') break;
      if (c === '$') {
        // 闭括号前面是空白的候选不收（金额句的典型形态），后面紧跟数字的也不收
        var prevIsSpace = s[j - 1] === ' ' || s[j - 1] === '\t';
        var nextIsDigit = j + 1 < n && isDigit(s[j + 1]);
        if (!prevIsSpace && !nextIsDigit) closed = j;
        break;
      }
      j++;
    }

    if (closed === -1) {
      out += ch;
      i++;
      continue;
    }

    var tex = s.slice(i + 1, closed);
    // 公式里两侧的空白是排版噪音，不是内容
    if (tex.trim() === '') {
      out += s.slice(i, closed + 1);
      i = closed + 1;
      continue;
    }
    out += stashMath(tex.trim(), false);
    i = closed + 1;
  }

  return out;
}

// ---------- Markdown 配置 ----------

var renderer = new marked.Renderer();

// 链接统一新窗口打开，并加 noopener 防钓鱼
renderer.link = function(href, title, text) {
  var url = String(href || '');
  if (!/^https?:\/\//i.test(url)) {
    // 非 http(s) 链接（javascript: 等）直接降级为纯文本，防止 XSS
    return text;
  }
  var titleAttr = title ? ' title="' + escapeHtml(title) + '"' : '';
  return '<a href="' + escapeHtml(url) + '"' + titleAttr +
    ' target="_blank" rel="noopener noreferrer">' + text + '</a>';
};

// 兜底：没被 extractFences 抽走的代码块（缩进式代码块）
renderer.code = function(code, infostring) {
  var lang = String(infostring || '').trim().split(/\s+/)[0].toLowerCase();
  // 轻量模式下与 blockHtml 保持同口径：图表挂骨架、公式块不跑 KaTeX
  // —— 这条路径不走 extractFences，容易漏，所以这里必须单独判一次
  if (lang === 'mermaid') return renderMermaidHtml(String(code), !lightMode);
  if (isMathFence(lang)) {
    return lightMode ? renderCodeBlockHtml(String(code), lang) : renderMath(String(code).trim(), true);
  }
  return renderCodeBlockHtml(String(code), lang);
};

// 表格套一层横向滚动容器：
// 窄屏（手机 / 竖屏平板）上列一多就把气泡撑破，套上后是本页滚动而不是整页滚动。
renderer.table = function(header, body) {
  return '<div class="table-wrap"><table><thead>' + header +
    '</thead><tbody>' + body + '</tbody></table></div>';
};

marked.setOptions({
  renderer: renderer,
  breaks: true,          // 单换行即换行：聊天场景更符合直觉
  gfm: true,
  headerIds: false,
  mangle: false
});

// ---------- 剥离结构化数据块 ----------
//
// 批改结果末尾，模型会额外输出一段 <wrong-items>JSON</wrong-items>
// 供后端收录进错题本。学生不该看到这坨 JSON。
//
// 关键：这里用**截断**而不是"用正则删除整块"。
// 理由：流式输出时，后半个标记（</wrong-items>）还没到达，
// 正则匹配不上整块，JSON 就会短暂地显示在学生眼前。
// 截断到起始标记之前则从第一帧起就不会露出。
var WRONG_ITEMS_MARK = '<wrong-items';

function stripStructured(text) {
  var s = String(text || '');
  var idx = s.indexOf(WRONG_ITEMS_MARK);
  if (idx === -1) return s;
  return s.slice(0, idx).replace(/\n+$/, '');
}

// ---------- 主入口 ----------

// 渲染主流程：renderMarkdown 与 renderStream 共用，两者只差 lightMode 一个标志
function renderInternal(text) {
  mathStore = [];
  blockStore = [];

  var source = stripStructured(text);
  var withoutFences = extractFences(source);
  var withMath = extractDisplayMath(withoutFences);
  withMath = extractInlineMath(withMath);

  var html = marked.parse(withMath || '');
  html = restoreMath(html);
  html = restoreBlocks(html);

  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext'],
    ADD_ATTR: ['target', 'rel', 'encoding']
  });
}

// 把一条 AI 回复渲染为可直接 v-html 的安全 HTML（完整版：公式走 KaTeX、图表真画）
export function renderMarkdown(text) {
  lightMode = false;
  return renderInternal(text);
}

// 流式期间的轻量渲染 —— 只给"正在往外冒字"的那几秒用，收尾必须换回 renderMarkdown。
//
// 为什么需要它：流式每收到一段就把整篇内容重渲染一次，而一次完整渲染要跑
// marked + KaTeX + DOMPurify 三遍全量处理。内容越长单帧越重 —— 表现就是
// "刚开始很顺，写到几百字后字开始一顿一顿，而且总体变慢"。
// 变慢不只是观感：主线程被渲染占满 → 流的读取（microtask）排不上 →
// 背压一路传到服务端 → 上游出字也跟着变慢。这是真的把模型拖慢了。
//
// 轻量版砍掉两块最贵的：
//   1. KaTeX：公式暂存原文，以 <code> 露面（见 stashMath 的注释）
//   2. 图表：一律挂骨架，不去 innerHTML 整张 SVG（见 blockHtml 的注释）
// 剩下的 marked 解析与 DOMPurify 净化是安全底线，不砍。
export function renderStream(text) {
  lightMode = true;
  try {
    return renderInternal(text);
  } finally {
    // 必须复位：异常时也要还原，否则后续本该完整的渲染会一直降级
    lightMode = false;
  }
}

// 纯文本摘要（会话列表标题等场景）
export function stripMarkdown(text) {
  return stripStructured(text)
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/\$\$[\s\S]+?\$\$/g, ' [公式] ')
    .replace(/\$[^\n$]+?\$/g, ' [公式] ')
    .replace(/[#*`>_~\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export { stripStructured };
