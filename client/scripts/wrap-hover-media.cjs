// 一次性脚本：把 CSS 里的 :hover 规则收进 @media (hover: hover)。
//
// 为什么：目标设备是安卓平板。安卓 Chrome 上手指点按会让 :hover 生效并"粘住"
// （直到点别处才消失），于是导航、列表行、按钮会留下莫名其妙的常亮高亮。
// hover 本来就是"有鼠标才有"的语义 —— 规则放进 (hover: hover) 后，
// 触屏设备不再收到这些样式，桌面行为不变。
//
// 处理规则：
//   1. 只处理**顶层**规则；已在 @media / @keyframes / @supports 里的不动
//      （现有 @media (hover: none) 的兜底覆盖原样保留，双保险无害）。
//   2. 选择器列表要拆分：`.a:hover, .b { }` 拆成 `.b { }` + 包裹的 `.a:hover { }`，
//      不能整条包进去（否则 .b 在触屏上会丢样式）。
//   3. 幂等：跑完后 hover 规则都在 media 里，再跑不会二次包裹。
//
// 运行：node scripts/wrap-hover-media.cjs
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

// 读一个平衡的花括号块，返回闭合 '}' 的下标
function findBlockEnd(css, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 按顶层逗号拆选择器列表（括号内的逗号不拆，比如 :not(.a, .b)）
function splitSelectors(sel) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(s => s.trim()).filter(Boolean);
}

// 返回 { css, count }
function wrapHover(css) {
  let out = '';
  let i = 0;
  const n = css.length;
  let count = 0;

  while (i < n) {
    // 注释原样拷贝
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i);
      const stop = end === -1 ? n : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }

    // 空白原样拷贝
    if (/\s/.test(css[i])) { out += css[i]; i++; continue; }

    const open = css.indexOf('{', i);
    if (open === -1) { out += css.slice(i); break; }
    const prelude = css.slice(i, open);

    // @块（media/keyframes/supports...）：整块原样拷贝，不深入
    // （顶层 @media 里已有的 hover 规则视为作者有意为之，不再包裹）
    if (/^\s*@/.test(prelude)) {
      const end = findBlockEnd(css, open);
      if (end === -1) { out += css.slice(i); break; }
      out += css.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    const end = findBlockEnd(css, open);
    if (end === -1) { out += css.slice(i); break; }
    const body = css.slice(open, end + 1);

    const sels = splitSelectors(prelude);
    const hoverSels = sels.filter(s => s.includes(':hover'));
    const plainSels = sels.filter(s => !s.includes(':hover'));

    if (!hoverSels.length) {
      out += css.slice(i, end + 1);
    } else {
      count++;
      if (plainSels.length) {
        out += plainSels.join(',\n') + ' ' + body + '\n';
      }
      out += '@media (hover: hover) {\n' + hoverSels.join(',\n') + ' ' + body + '\n}\n';
    }
    i = end + 1;
  }
  return { css: out, count: count };
}

let total = 0;
for (const f of walk(ROOT, [])) {
  const src = fs.readFileSync(f, 'utf8');
  let out;
  if (/\.vue$/.test(f)) {
    out = src.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, function(m, open, body, close) {
      const r = wrapHover(body);
      total += r.count;
      return open + r.css + close;
    });
  } else {
    const r = wrapHover(src);
    total += r.count;
    out = r.css;
  }
  if (out !== src) {
    fs.writeFileSync(f, out, 'utf8');
    console.log('wrapped: ' + path.relative(ROOT, f));
  }
}
console.log('done, wrapped ' + total + ' hover rule(s)');
