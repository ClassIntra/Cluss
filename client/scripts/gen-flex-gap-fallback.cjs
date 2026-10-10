// 生成 flex 容器 gap 的兼容回退。
//
// 背景：Chrome 84 才支持 flex 容器上的 gap，而设备基线是 Android 9 / Chrome 80。
// 在这台机器上 gap 会被整条丢弃 —— 所有靠 gap 排布的行列都挤成一团。
//
// 做法：扫描源码里的 CSS，凡是同时声明了 display:flex 与 gap 的规则，
// 就在它后面补一条 `html.no-flex-gap <选择器> > * + * { margin-*: 同值 }`。
// 前缀 html.no-flex-gap 由 main.js 的实测探测加上，所以新浏览器不会重复计间距。
//
// 只动项目自己的 .vue <style> 与 global.css，不碰任何第三方样式。
// 幂等：已经带 no-flex-gap 的选择器不会再生成第二条。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'src');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(vue|css)$/.test(name)) out.push(p);
  }
  return out;
}

// 注释整体抹掉：否则 "/* 按钮 */\n.btn" 会被当成选择器的一部分
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function scanRules(css) {
  const rules = [];
  let i = 0;
  const n = css.length;

  function readBlock() {
    let depth = 0;
    const start = i;
    while (i < n) {
      const c = css[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { i++; return { text: css.slice(start, i), open: start, close: i - 1 }; }
      }
      i++;
    }
    return { text: css.slice(start, n), open: start, close: n - 1 };
  }

  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;
    if (css[i] === '}') { i++; continue; }

    if (css[i] === '@') {
      const atEnd = css.indexOf('{', i);
      if (atEnd < 0) break;
      const head = stripComments(css.slice(i, atEnd)).trim();
      i = atEnd;
      const block = readBlock();
      if (/^@media/.test(head)) {
        for (const r of scanRules(block.text.slice(1, -1))) {
          r.media = head;
          rules.push(r);
        }
      }
      continue;
    }

    const brace = css.indexOf('{', i);
    if (brace < 0) break;
    const selector = stripComments(css.slice(i, brace)).replace(/\s+/g, ' ').trim();
    i = brace;
    const block = readBlock();
    rules.push({
      selector: selector,
      body: block.text.slice(1, -1),
      close: block.close,
      media: ''
    });
  }

  return rules;
}

function buildFallback(rule) {
  const sel = rule.selector;
  if (!sel || sel.indexOf('@') === 0) return null;
  if (sel.indexOf('::') >= 0) return null;
  // 幂等：已经生成过就不再生成
  if (/no-flex-gap/.test(sel)) return null;

  const body = stripComments(rule.body);
  if (!/display:\s*(inline-)?flex\b/.test(body)) return null;

  const gap = body.match(/(^|[;\s])gap:\s*([^;]+);/);
  if (!gap) return null;
  const value = gap[2].trim();
  if (!value || value === '0' || value === 'normal') return null;
  // gap: 8px 12px 这种双值不处理（项目里没用到，硬套会算错方向）
  if (/\s/.test(value)) return null;

  const isColumn = /flex-direction:\s*column(-reverse)?\b/.test(body);
  const prop = isColumn ? 'margin-top' : 'margin-left';
  const pad = rule.media ? '  ' : '';

  return {
    media: rule.media,
    text: pad + 'html.no-flex-gap ' + sel + ' > * + * {\n' + pad + '  ' + prop + ': ' + value + ';\n' + pad + '}'
  };
}

function applyFallbacks(css) {
  const rules = scanRules(css);

  // 幂等的前提：**先看看这份样式里已经有哪些回退规则了**。
  //
  // 曾经的写法只判断"当前这条规则的**选择器**里有没有 no-flex-gap"，
  // 那只挡得住"别拿回退规则再生成回退规则"，挡不住"同一条源规则再生成一条"。
  // 于是每跑一次就往每条源规则后面再插一份 —— 实测跑多了之后
  // WrongBook.vue 里堆到 108 条，其中 90 条是逐字重复的；Chat.vue 同样 107/89。
  // 现在按「媒体上下文 + 目标选择器」先去重登记，已有就不再生成。
  const keys = new Set();
  for (const r of rules) {
    if (/^html\.no-flex-gap /.test(r.selector)) {
      keys.add((r.media || '') + '|' + r.selector.replace(/\s*>\s*\*\s*\+\s*\*\s*$/, ''));
    }
  }

  const items = [];
  for (const r of rules) {
    const fb = buildFallback(r);
    if (!fb) continue;
    const key = (r.media || '') + '|html.no-flex-gap ' + r.selector;
    if (keys.has(key)) continue;   // 这份样式里已经有了
    keys.add(key);                 // 同一轮里同一目标也只生成一次
    items.push({ close: r.close, text: fb.text });
  }
  if (!items.length) return { css: css, count: 0 };

  // 从后往前插，保证先算好的下标不被后续插入影响
  items.sort(function(a, b) { return b.close - a.close; });

  let out = css;
  for (const it of items) {
    const at = it.close + 1; // 紧跟原规则的 '}'
    out = out.slice(0, at) + '\n' + it.text + '\n' + out.slice(at);
  }
  return { css: out, count: items.length };
}

let total = 0;
for (const f of walk(ROOT, [])) {
  const src = fs.readFileSync(f, 'utf8');
  let out = src;

  if (/\.vue$/.test(f)) {
    out = src.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, function(_m, open, body, close) {
      const r = applyFallbacks(body);
      total += r.count;
      return open + r.css + close;
    });
  } else {
    const r = applyFallbacks(src);
    total += r.count;
    out = r.css;
  }

  if (out !== src) {
    fs.writeFileSync(f, out, 'utf8');
    console.log('patched ' + path.relative(ROOT, f));
  }
}

console.log('done, generated ' + total + ' fallback rule(s)');
