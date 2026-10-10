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
    const style = stripComments(t.slice(styleStart));   // 注释剔除
    const re = /#[0-9a-fA-F]{3,8}\b/g;
    let m;
    while ((m = re.exec(style))) {
      const hex = m[0];
      const lower = hex.toLowerCase();
      // 纯黑与带 8 位 alpha 的（渐变端点）不算
      if (lower === '#000' || lower === '#000000') continue;
      if (/^#[0-9a-f]{8}$/i.test(hex)) continue;

      const before = style.slice(Math.max(0, m.index - 80), m.index);
      const after = style.slice(m.index, m.index + 40);
      const decl = before.split(/[;{}]/).pop() + hex + after.split(';')[0];

      // var(--x, #fff) —— 是**兜底值**，令牌存在时不会用到；不算问题
      const inVarFallback = /var\([^)]*$/.test(before);
      if (inVarFallback) continue;

      // 色板 / 主题预览：这类元素的作用**就是**展示颜色本身，
      // 必须写死具体色值（AppNav 的 .theme-swatch 就是「浅色一半 + 深色一半」）。
      const sel = /([^{};]*)\{[^}]*$/.exec(before);
      const selName = sel ? sel[1].split(/[;{}]/).pop().trim() : '';
      if (/swatch|preview|palette|theme-.*(dot|circle)|color-dot/.test(selName)) continue;

      // #fff / #FFFFFF 用作 color，且同一声明里背景是彩色 → 「白字配彩色底」是合理用法
      const isWhite = /^#(fff|ffffff)$/i.test(hex);
      if (isWhite && /(^|[\s-])color\s*:/.test(decl)) continue;
      // 同理：背景是白/黑时前景用 #fff 也常见
      if (isWhite && /background/.test(decl) && /rgba?\(255,\s*255,\s*255/.test(after)) continue;

      items.push({ file: f, line: lineOf(style, m.index) + lineOf(head, styleStart) - 1, hex: hex });
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
// ⚠️ 只管**过渡**（transition），不管 animation ——
//   实测 27 处「偏离」里绝大多数是误报：
//     0s   → transition: none（关掉动画，不是时长）
//     0.8s → loading 的 spin 循环（循环动画该慢，不是过渡）
//     0.05s → 画布按下的即时反馈（刻意要快，改慢反而变卡）
//   把这些报出来，真问题（0.22 / 0.28 / 0.32 这类散值）就被淹没了。
function auditDurations() {
  const items = [];
  files.forEach(function (f) {
    const t = fs.readFileSync(f, 'utf8');
    const codeOnly = stripComments(t);

    // transition 声明里的时长
    const re = /transition:\s*([^;{}]+)/g;
    let m;
    while ((m = re.exec(codeOnly))) {
      const decl = m[1];
      // transition: none → 跳过
      if (/\bnone\b/.test(decl) && !/\d/.test(decl)) continue;
      const nums = decl.match(/([0-9]*\.?[0-9]+)s/g);
      if (!nums) continue;
      nums.forEach(function (raw) {
        const v = parseFloat(raw);
        if (!isFinite(v) || v === 0) return;   // 0s 视为 none
        if (T_DURATIONS.some(function (x) { return Math.abs(v - x) < 0.005; })) return;
        // 数字不在令牌档位里：要么该换成令牌，要么是刻意的特殊值
        items.push({ file: f, line: lineOf(codeOnly, m.index), value: v, decl: decl.trim().substring(0, 50) });
      });
    }

    // 另一类问题：明明有令牌却写了字面量 —— 这才是「统一」真正要治的
    var lit = /(?:^|[\s;])transition:\s*([^;{}]*\d[^;{}]*)/g;
    while ((m = lit.exec(codeOnly))) {
      var d = m[1];
      if (/var\(--dur-|var\(--transition|var\(--duration/.test(d)) continue; // 已用令牌
      if (/transition:\s*none/.test(d)) continue;
      if (!/[0-9]/.test(d)) continue;
      // 这个声明里的所有时长都命中令牌值 → 说明就是「该用令牌却写了字面量」
      var litNums = (d.match(/([0-9]*\.?[0-9]+)s/g) || []);
      if (!litNums.length) continue;
      var allMatch = litNums.every(function (raw) {
        var v2 = parseFloat(raw);
        return T_DURATIONS.some(function (x) { return Math.abs(v2 - x) < 0.005; });
      });
      if (allMatch) {
        items.push({ file: f, line: lineOf(codeOnly, m.index), value: 'literal',
          decl: d.trim().substring(0, 50) });
      }
    }
  });
  return items;
}

// 约定的过渡档位 —— **从 global.css 的实际令牌读出来**，不自己编。
// ⚠️ 踩过的坑：最初我凭直觉写了「0.12/0.15/0.2/0.24/0.26…」这一套档位，
//   结果把项目里正确使用 0.22s（--dur-base）的地方全报成「偏离」。
//   门槛必须锚定项目自己的设计令牌，否则脚本本身就是错的。
function readDurationTokens() {
  var css = fs.readFileSync(path.join(CLIENT, 'styles/global.css'), 'utf8');
  var out = [];
  var re = /--dur-[a-z]+:\s*([0-9.]+)s/g;
  var m;
  while ((m = re.exec(css))) out.push(parseFloat(m[1]));
  // 额外允许 0（transition: none 会被过滤，这里只是兜底）与常见的整数档
  return out.length ? out : [0.2];
}
var T_DURATIONS = readDurationTokens();

// ---- 4. 触屏上的 :hover 覆盖 ----
// 项目自己在 global.css 里立了规矩：「:hover 规则收进 @media (hover: hover)」，
// 这里检查是否有裸的 :hover。
//
// ⚠️ 必须排除注释里的 :hover —— 本项目大量注释会解释
//   「为什么必须包 @media (hover: hover)」，那些文字里全是 :hover。
//   实测不过滤的话，Notes.vue 报的 4 处**全是注释**，真问题一个没有。
//   判断方式是**逐字符追踪是否处于 /* */ 内**，而不是看行首
//   （块注释的中间行既不以 * 开头也不以 // 开头）。
function stripComments(text) {
  // 返回与原文等长的字符串，注释部分用空格替换（保留换行以维持行号）
  var out = '';
  var inBlock = false, inLine = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i], n = text[i + 1];
    if (inBlock) {
      if (c === '*' && n === '/') { out += '  '; i++; inBlock = false; continue; }
      out += (c === '\n' ? '\n' : ' ');
      continue;
    }
    if (inLine) {
      if (c === '\n') { inLine = false; out += '\n'; } else out += ' ';
      continue;
    }
    if (c === '/' && n === '*') { out += '  '; i++; inBlock = true; continue; }
    if (c === '/' && n === '/') { inLine = true; out += '  '; i++; continue; }
    out += c;
  }
  return out;
}

function auditHover() {
  const items = [];
  files.forEach(function (f) {
    const t = fs.readFileSync(f, 'utf8');
    const styleStart = t.indexOf('<style');
    if (styleStart < 0) return;
    const style = t.slice(styleStart);
    const codeOnly = stripComments(style);   // 注释已剔除

    const guarded = [];
    const re = /@media\s*\(hover:\s*hover\)\s*\{/g;
    let m;
    while ((m = re.exec(codeOnly))) {
      let depth = 1, i = re.lastIndex;
      while (i < codeOnly.length && depth > 0) {
        if (codeOnly[i] === '{') depth++;
        else if (codeOnly[i] === '}') depth--;
        i++;
      }
      guarded.push([m.index, i]);
    }
    const hre = /:hover/g;
    while ((m = hre.exec(codeOnly))) {
      const inside = guarded.some(function (r) { return m.index > r[0] && m.index < r[1]; });
      if (!inside) items.push({ file: f, line: lineOf(style, m.index) + lineOf(t.slice(0, styleStart), styleStart) - 1 });
    }
  });
  return items;
}

// ---- 5. 触控目标 ----
// ⚠️ 只报**可点**元素：给纯展示的 span/label 加命中区是有害的
//   ——它会挡住下面真正可点的东西（伪元素默认参与命中测试）。
//   实测踩过：msel-chip（18px）是纯标签，加了命中区反而点不到下拉箭头。
function auditTouchTargets() {
  const items = [];
  files.forEach(function (f) {
    const t = fs.readFileSync(f, 'utf8');

    // 先建立「哪些 class 出现在可点标签上」的映射
    var clickable = Object.create(null);
    var tagRe = /<(button|a|input|select|textarea)\b[^>]*>/gi;
    var tm;
    while ((tm = tagRe.exec(t))) {
      var cls = /class="([^"]*)"/.exec(tm[0]);
      if (!cls) continue;
      cls[1].split(/\s+/).forEach(function (cn) {
        if (cn) clickable[cn] = true;
      });
    }

    // 再扫尺寸：只对可点的 class 报告
    // ⚠️ 已经加了命中区（::after 撑到 40px）的**不算问题** ——
    //   视觉尺寸本来就该小，扩的是「点得到」的范围。
    //   漏判会让修完的地方一直被报，噪声淹没真问题（实测：加了命中区的
    //   5 处仍然被报「偏小」，而它们其实已经修好了）。
    var hitFixed = Object.create(null);
    var afterRe = /\.([a-z][\w-]*)::after\s*\{([^}]*)\}/gi;
    var am;
    while ((am = afterRe.exec(t))) {
      if (/width:\s*(40|3\d|4\d)px|height:\s*(40|3\d|4\d)px|min-height:\s*(32|3\d|4\d)px/.test(am[2])) {
        hitFixed[am[1]] = true;
      }
    }

    var sizeRe = /(\.[a-z][\w-]*(?:btn|button|icon-btn|chip|tag-close|-btn)[^{]*)\{([^}]*)\}/gi;
    var m;
    while ((m = sizeRe.exec(t))) {
      var tailSel = m[1].trim().split(/\s+/).pop() || '';
      if (['svg', 'i', 'span', 'path', 'b', 'strong', 'em'].indexOf(tailSel.toLowerCase()) >= 0) continue;
      // 提取 class 名（取最后一个 . 开头的标识符）
      var cm = /\.([a-z][\w-]*)/gi; var lastCls = null; var c2;
      while ((c2 = cm.exec(m[1]))) lastCls = c2[1];
      if (!lastCls) continue;
      if (!clickable[lastCls]) continue;  // 纯展示，不报
      if (hitFixed[lastCls]) continue;    // 已加命中区，不报

      var body = m[2];
      var h = /height:\s*(\d+)px/.exec(body);
      if (h) {
        var hv = Number(h[1]);
        if (hv > 0 && hv < 32) items.push({ file: f, line: lineOf(t, m.index), sel: '.' + lastCls, why: 'height=' + hv + 'px' });
        continue;
      }
      var pad = /padding:\s*(\d+)px\s+(\d+)px/.exec(body) || /padding:\s*(\d+)px/.exec(body);
      if (pad) {
        var p = Number(pad[1]);
        var fsM = /font-size:\s*([\d.]+)px/.exec(body);
        var fsz = fsM ? Number(fsM[1]) : 14;
        var total = p * 2 + fsz * 1.5;
        if (total < 36) items.push({ file: f, line: lineOf(t, m.index), sel: '.' + lastCls, why: '约 ' + Math.round(total) + 'px' });
      }
      if (/clamp\(|min\(|max\(/.test(body) && (/width:|height:/.test(body))) {
        items.push({ file: f, line: lineOf(t, m.index), sel: '.' + lastCls, why: 'clamp 响应式，需人工确认', soft: true });
      }
    }
  });
  return items;
}

function report(title, items, fmt, hint) {
  OUT.push({ title: title, items: items, fmt: fmt, hint: hint });
}

report('硬编码色值（应改用设计令牌）', auditColors(),
  function (x) { return x.hex; },
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