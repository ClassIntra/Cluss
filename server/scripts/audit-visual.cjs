/**
 * 视觉一致性巡检
 *
 * 为什么需要：「统一」这件事最容易退化的方式是每来一个新需求就手写一个值，
 * 时间久了同一个含义有三四种写法（比如按钮圆角 8px 和 10px 并存、
 * 动效 0.2s 和 0.24s 混用）。人眼看不出差别，但叠在一起就不「成一套」。
 *
 * 这个脚本把「统一」变成可测量的：
 *   1. 硬编码色值 —— 应改用设计令牌（var(--accent) 等）
 *   2. 硬编码圆角 —— 应改用 --radius-* 刻度
 *   3. 动效时长 —— 是否都落在约定的档位上
 *   4. 悬停/按压态覆盖 —— 触屏设备上 :hover 会「粘住」
 *   5. 触控目标尺寸 —— 小于 40px 的可点元素
 *
 * 跑法：node server/scripts/audit-visual.cjs [--fix]
 */
const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '../../client/src');
const OUT = [];

// 设计令牌（从 global.css 里读出来的实际值，避免脚本与样式脱节）
function readTokens() {
  const css = fs.readFileSync(path.join(CLIENT, 'styles/global.css'), 'utf8');
  const names = new Set();
  const m = css.match(/^\s*(--[a-z0-9-]+)\s*:/gmi) || [];
  m.forEach(function (x) { names.add(x.replace(/[^\w-]/g, '')); });
  return names;
}
const TOKENS = readTokens();

function walk(dir, out) {
  out = out || [];
  fs.readdirSync(dir).forEach(function (f) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(vue|css)$/.test(f)) out.push(p);
  });
  return out;
}

const files = walk(CLIENT).filter(function (f) {
  return f.indexOf('legacy') < 0; // polyfills 不参与视觉审查
});

function rel(p) { return path.relative(CLIENT, p).replace(/\\/g, '/'); }
function lineOf(text, idx) { return text.slice(0, idx).split('\n').length; }

// ---- 1. 硬编码色值 ----
const NAMED = {
  '#fff': 'tokens 里已有 --text-invert / 白色面',
  '#ffffff': null, '#FFFFFF': null
};
const OK_COLOR = /^#[0-9a-f]{3,8}$/i;

function auditColors() {
  const items = [];
  files.forEach(function (f) {
    const t = fs.readFileSync(f, 'utf8');
    // 只看 <style> 块内的（模板里的颜色通常来自 style）
    const styleStart = t.indexOf('<style');
    if (styleStart < 0) return;
    const head = t.slice(0, styleStart);
    const style = t.slice(styleStart);
    const re = /#[0-9a-fA-F]{3,8}\b/g;
    let m;
    while ((m = re.exec(style))) {
      const hex = m[0];
      const lower = hex.toLowerCase();
      // 纯黑纯白与带 8 位 alpha 的渐变端点不算「该用令牌」的范畴
      if (lower === '#000' || lower === '#000000') continue;
      if (/^#[0-9a-f]{8}$/i.test(hex)) continue;
      // 渐变定义里的中间色：允许，但要记账
      const before = style.slice(Math.max(0, m.index - 60), m.index);
      const inGradient = /linear-gradient|radial-gradient/.test(before);
      items.push({ file: f, line: lineOf(style, m.index) + lineOf(head, styleStart) - 1, hex: hex, inGradient: inGradient });
    }
  });
  return items;
}

// ---- 2. 硬编码圆角 ----
function auditRadii() {
  const items = [];
  files.forEach(function (f) {
    const t = fs.readFileSync(f, 'utf8');
    const re = /border-radius:\s*([0-9]+)px/g;
    let m;
    while ((m = re.exec(t))) {
      const v = Number(m[1]);
      if (v > 40) continue;                       // 胶囊类走 --radius-pill
      if ([2, 4, 6, 8, 10, 12, 14, 16, 20, 24].indexOf(v) >= 0) continue; // 已有刻度
      items.push({ file: f, line: lineOf(t, m.index), value: v });
    }
  });
  return items;
}

// ---- 3. 动效时长档位 ----
function auditDurations() {
  const items = [];
  files.forEach(function (f) {
    const t = fs.readFileSync(f, 'utf8');
    // 只看 transition/animation 里的时长
    const re = /(?:transition|animation)[^;{}]*?([0-9]*\.?[0-9]+)s/g;
    let m;
    while ((m = re.exec(t))) {
      const v = parseFloat(m[1]);
      if (!isFinite(v)) continue;
      // 约定的档位（秒）
      if ([0.12, 0.15, 0.2, 0.24, 0.26, 0.3, 0.35, 0.4, 0.5, 0.6].some(function (x) { return Math.abs(v - x) < 0.005; })) continue;
      items.push({ file: f, line: lineOf(t, m.index), value: v });
    }
  });
  return items;
}

// ---- 4. 触屏上的 :hover 覆盖 ----
// 项目自己在 global.css 里立了规矩：「:hover 规则收进 @media (hover: hover)」，
// 这里检查是否有裸的 :hover。
function auditHover() {
  const items = [];
  files.forEach(function (f) {
    const t = fs.readFileSync(f, 'utf8');
    const styleStart = t.indexOf('<style');
    if (styleStart < 0) return;
    const style = t.slice(styleStart);
    // 找出所有 @media (hover: hover) 的范围
    const guarded = [];
    const re = /@media\s*\(hover:\s*hover\)\s*\{/g;
    let m;
    while ((m = re.exec(style))) {
      // 粗略取到配对的 } —— 用深度计数
      let depth = 1, i = re.lastIndex;
      while (i < style.length && depth > 0) {
        if (style[i] === '{') depth++;
        else if (style[i] === '}') depth--;
        i++;
      }
      guarded.push([m.index, i]);
    }
    const hre = /:hover/g;
    while ((m = hre.exec(style))) {
      const inside = guarded.some(function (r) { return m.index > r[0] && m.index < r[1]; });
      if (!inside) items.push({ file: f, line: lineOf(style, m.index) + lineOf(t.slice(0, styleStart), styleStart) - 1 });
    }
  });
  return items;
}

// ---- 5. 触控目标 ----
function auditTouchTargets() {
  const items = [];
  files.forEach(function (f) {
    const t = fs.readFileSync(f, 'utf8');
    // 找出 @click 的元素所属的 class，再看那个 class 的尺寸
    const clickRe = /@click[^\n]*|class="([^"]+)"/g;
    // 简化：只报告显式小尺寸的按钮类（padding + font 算出高度 < 40）
    const sizeRe = /(\.[a-z][\w-]*(?:btn|button|icon-btn|chip|tag-close)[^{]*)\{([^}]*)\}/gi;
    let m;
    while ((m = sizeRe.exec(t))) {
      // 选择器**末尾**是 svg / i / span / path 时，说明这条规则描述的是图标本身，
      // 而不是可点的按钮 —— 可点区域由父级的 padding / min-height 撑开。
      // 报它们只会淹没真问题（实测 :hostile 里 7 条有 2 条是这类）。
      var tail = (m[1].trim().split(/\s+/).pop() || '').toLowerCase();
      if (['svg', 'i', 'span', 'path', 'b', 'strong', 'em'].indexOf(tail) >= 0) continue;
      const body = m[2];
      const pad = /padding:\s*(\d+)px\s+(\d+)px/.exec(body) || /padding:\s*(\d+)px/.exec(body);
      const h = /height:\s*(\d+)px/.exec(body);
      if (h) {
        const hv = Number(h[1]);
        if (hv > 0 && hv < 32) items.push({ file: f, line: lineOf(t, m.index), sel: m[1].trim(), why: 'height=' + hv + 'px' });
        continue;
      }
      if (pad) {
        const p = Number(pad[1]);
        const fs = /font-size:\s*([\d.]+)px/.exec(body);
        const fsz = fs ? Number(fs[1]) : 14;
        const total = p * 2 + fsz * 1.5;
        if (total < 36) items.push({ file: f, line: lineOf(t, m.index), sel: m[1].trim(), why: '约 ' + Math.round(total) + 'px' });
      }
      // clamp() / min() / max() 是响应式放大（本项目大量用于「按视口把命中区做大」），
      // 脚本无法静态求值 —— 标出来而不是当问题报，否则真正的漏网之鱼会被淹没。
      if (/clamp\(|min\(|max\(/.test(body) && (/width:|height:/.test(body))) {
        items.push({ file: f, line: lineOf(t, m.index), sel: m[1].trim(), why: 'clamp 响应式，需人工确认', soft: true });
      }
    }
  });
  return items;
}

function report(title, items, fmt, hint) {
  OUT.push({ title: title, items: items, fmt: fmt, hint: hint });
}

report('硬编码色值（应改用设计令牌）', auditColors(),
  function (x) { return x.hex + (x.inGradient ? '（渐变中间色，可接受）' : ''); },
  '令牌在 global.css 的 :root 里，共 ' + TOKENS.size + ' 个');

report('硬编码圆角（应改用 --radius-* 刻度）', auditRadii(),
  function (x) { return x.value + 'px'; },
  '刻度：2xs 6 / xs 8 / sm 10 / md 14 / lg 20 / xl 24 / pill 999');

report('非档位动效时长', auditDurations(),
  function (x) { return x.value + 's'; },
  '档位：0.12 / 0.15 / 0.2 / 0.24 / 0.26 / 0.3 / 0.35 / 0.4 / 0.5 / 0.6s');

report('裸露的 :hover（触屏会粘住）', auditHover(),
  function () { return ''; },
  '项目约定：:hover 收进 @media (hover: hover)，见 global.css');

report('偏小的触控目标（<36px）', auditTouchTargets(),
  function (x) { return x.sel + ' → ' + x.why; },
  '触屏建议 ≥40px');

var total = 0;
OUT.forEach(function (g) {
  var real = g.items.filter(function (x) {
    // 「可接受」= 渐变中间色；soft = 需人工确认（响应式）
    if (x.soft) return false;
    var s = g.fmt(x);
    return !(typeof s === 'string' && s.indexOf('可接受') >= 0);
  });
  var soft = g.items.filter(function (x) { return x.soft; });
  total += real.length;
  console.log('\n=== ' + g.title + ' —— ' + real.length + ' 处' + (soft.length ? '（另有 ' + soft.length + ' 处需人工确认）' : '') + ' ===');
  console.log('  （' + g.hint + '）');
  if (!real.length) { console.log('  ✓ 无'); }
  else {
    var byFile = {};
    real.forEach(function (x) { (byFile[x.file] = byFile[x.file] || []).push(x); });
    Object.keys(byFile).sort(function (a, b) { return byFile[b].length - byFile[a].length; }).forEach(function (f) {
      console.log('  ' + rel(f) + '（' + byFile[f].length + '）');
      byFile[f].slice(0, 8).forEach(function (x) {
        console.log('    L' + x.line + '  ' + g.fmt(x));
      });
      if (byFile[f].length > 8) console.log('    …… 还有 ' + (byFile[f].length - 8) + ' 处');
    });
  }
});

console.log('\n' + '='.repeat(50));
console.log('合计需要收口：' + total + ' 处');