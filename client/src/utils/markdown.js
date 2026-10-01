import { marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';

// Markdown + LaTeX 渲染
//
// 处理顺序很关键：**先抽走公式再走 Markdown**。
// 若反过来，Markdown 会把公式里的 _ ^ \ 当作强调/转义处理，把 $x_i^2$ 弄坏。
// 所以先把公式替换为占位符，渲染完再换回 KaTeX 的 HTML。

function renderMath(tex, displayMode) {
  try {
    return katex.renderToString(tex, {
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

var mathStore = [];

function stashMath(tex, displayMode) {
  var idx = mathStore.length;
  mathStore.push(renderMath(tex, displayMode));
  // 用不会被 Markdown 改写的占位符（不含 * _ ` 等语法字符）
  return '\u0000MATH' + idx + '\u0000';
}

function extractMath(text) {
  var out = String(text || '');

  // 1) 块级公式 $$...$$（跨行）
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, function(_, tex) {
    return stashMath(tex.trim(), true);
  });

  // 2) 行内公式 $...$（不跨行、前后不紧跟数字，避免误伤「$5 和 $10」这类金额写法）
  out = out.replace(/(^|[^\d$])\$([^\n$]+?)\$([^\d$]|$)/g, function(_, pre, tex, post) {
    return pre + stashMath(tex.trim(), false) + post;
  });

  // 3) 显式行内 \(...\) 与块级 \[...\]
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, function(_, tex) {
    return stashMath(tex.trim(), true);
  });
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, function(_, tex) {
    return stashMath(tex.trim(), false);
  });

  // 4) ```latex 代码块（AI 有时会把公式整段放进代码块）
  out = out.replace(/```latex\n?([\s\S]*?)```/g, function(_, tex) {
    return stashMath(tex.trim(), true);
  });

  return out;
}

function restoreMath(html) {
  return String(html).replace(/\u0000MATH(\d+)\u0000/g, function(_, idx) {
    return mathStore[Number(idx)] || '';
  });
}

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

// 代码块：加语言标签，便于学生辨认
renderer.code = function(code, infostring) {
  var lang = String(infostring || '').trim().split(/\s+/)[0];
  var cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
  var label = lang ? '<div class="code-lang">' + escapeHtml(lang) + '</div>' : '';
  return '<div class="code-block">' + label + '<pre><code' + cls + '>' +
    escapeHtml(code) + '</code></pre></div>';
};

marked.setOptions({
  renderer: renderer,
  breaks: true,          // 单换行即换行：聊天场景更符合直觉
  gfm: true,
  headerIds: false,
  mangle: false
});

// 主入口：把一条 AI 回复渲染为可直接 v-html 的安全 HTML
export function renderMarkdown(text) {
  mathStore = [];

  var source = extractMath(text);
  var html = marked.parse(source || '');
  html = restoreMath(html);

  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext'],
    ADD_ATTR: ['target', 'rel', 'encoding']
  });
}

// 纯文本摘要（会话列表标题等场景）
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/\$\$[\s\S]+?\$\$/g, ' [公式] ')
    .replace(/\$[^\n$]+?\$/g, ' [公式] ')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/[#*`>_~\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}