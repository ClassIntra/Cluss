// 一次性 codemod：把组件里散落的硬编码颜色换成设计令牌
//
// 为什么用脚本而不是手工改：156 处、15 个文件，手工改必然漏。
// 映射表是显式写死的（不是正则瞎猜），所以可审查。
//
// 安全约束：跳过「变量定义行」（^  --name: value），
// 否则会把 :root / html[data-theme] 里的定义本身也替换掉，造成自引用。
//
// 用法：node scripts/codemod-theme-tokens.js  （在 client 目录下执行）
// 跑完需人工确认：node scripts/scan-hardcoded-colors.js

var fs = require('fs');
var path = require('path');

var SRC = path.join(__dirname, '..', 'src');

// ---- 映射表：左值必须在右值之前匹配（长的/更具体的排前面）----
var MAP = [
  // 墨色阶
  ['rgba(31, 41, 72, 0.035)', 'var(--ink-1)'],
  ['rgba(31, 41, 72, 0.03)', 'var(--ink-1)'],
  ['rgba(31, 41, 72, 0.04)', 'var(--ink-1)'],
  ['rgba(31, 41, 72, 0.05)', 'var(--ink-1)'],
  ['rgba(31, 41, 72, 0.06)', 'var(--ink-2)'],
  ['rgba(31, 41, 72, 0.07)', 'var(--ink-2)'],
  ['rgba(31, 41, 72, 0.08)', 'var(--ink-2)'],
  ['rgba(31, 41, 72, 0.1)', 'var(--ink-3)'],
  ['rgba(31, 41, 72, 0.12)', 'var(--ink-3)'],
  ['rgba(31, 41, 72, 0.14)', 'var(--ink-4)'],
  ['rgba(31, 41, 72, 0.16)', 'var(--ink-4)'],
  ['rgba(31, 41, 72, 0.18)', 'var(--ink-4)'],
  ['rgba(31, 41, 72, 0.26)', 'var(--ink-5)'],

  // 面阶
  ['rgba(255, 255, 255, 0.5)', 'var(--surface-1)'],
  ['rgba(255, 255, 255, 0.66)', 'var(--surface-1)'],
  ['rgba(255, 255, 255, 0.7)', 'var(--surface-2)'],
  ['rgba(255, 255, 255, 0.72)', 'var(--surface-2)'],
  ['rgba(255, 255, 255, 0.75)', 'var(--surface-2)'],
  ['rgba(255, 255, 255, 0.8)', 'var(--surface-2)'],
  ['rgba(255, 255, 255, 0.82)', 'var(--surface-2)'],
  ['rgba(255, 255, 255, 0.85)', 'var(--surface-3)'],
  ['rgba(255, 255, 255, 0.86)', 'var(--surface-3)'],
  ['rgba(255, 255, 255, 0.9)', 'var(--surface-3)'],

  // 遮罩
  ['rgba(20, 24, 38, 0.3)', 'var(--mask)'],
  ['rgba(20, 24, 38, 0.32)', 'var(--mask)'],
  ['rgba(20, 24, 38, 0.5)', 'var(--mask-strong)'],
  ['rgba(20, 24, 38, 0.55)', 'var(--mask-strong)'],
  ['rgba(16, 19, 30, 0.86)', 'var(--mask-deep)'],
  ['rgba(28, 29, 33, 0.9)', 'var(--toast-bg)'],

  // 强调色淡化
  ['rgba(47, 107, 221, 0.18)', 'var(--accent-ring)'],
  ['rgba(47, 107, 221, 0.25)', 'var(--accent-ring)'],
  ['rgba(47, 107, 221, 0.3)', 'var(--accent-border)'],
  ['rgba(47, 107, 221, 0.4)', 'var(--accent-border-strong)'],

  // 语义淡化
  ['rgba(214, 69, 69, 0.1)', 'var(--danger-tint)'],
  ['rgba(214, 69, 69, 0.12)', 'var(--danger-tint)'],
  ['rgba(214, 69, 69, 0.18)', 'var(--danger-tint)'],
  ['rgba(31, 157, 99, 0.18)', 'var(--success-soft)'],
  ['rgba(196, 126, 18, 0.18)', 'var(--warning-soft)'],

  // 提示条正文
  ['#8f2b2b', 'var(--danger-text)'],
  ['#1f4a9c', 'var(--accent-text)'],
  ['#14663f', 'var(--success-text)'],
  ['#8a5809', 'var(--warning-text)'],

  // 渐变（整体替换，避免半截匹配）
  ['linear-gradient(140deg, #5b9bff, #2f6bdd)', 'linear-gradient(140deg, var(--brand-a), var(--brand-b))'],
  ['linear-gradient(90deg, #5b9bff, #2f6bdd)', 'linear-gradient(90deg, var(--chart-a), var(--chart-b))'],
  ['linear-gradient(180deg, #7fb0ff, #2f6bdd)', 'linear-gradient(180deg, var(--chart-a), var(--chart-b))'],
  ['linear-gradient(90deg, #b9a2ff, #8b6bff)', 'linear-gradient(90deg, var(--purple-a), var(--purple))'],
  ['linear-gradient(90deg, #f0a95c, #d64545)', 'linear-gradient(90deg, var(--danger-grad-a), var(--danger-grad-b))'],
  ['radial-gradient(circle, rgba(146, 178, 255, 0.4) 0%, rgba(146, 178, 255, 0) 70%)',
    'radial-gradient(circle, var(--glow-a) 0%, rgba(0, 0, 0, 0) 70%)'],
  ['radial-gradient(circle, rgba(198, 170, 255, 0.32) 0%, rgba(198, 170, 255, 0) 70%)',
    'radial-gradient(circle, var(--glow-b) 0%, rgba(0, 0, 0, 0) 70%)'],
  ['linear-gradient(150deg, rgba(47, 107, 221, 0.1) 0%, rgba(146, 178, 255, 0.16) 100%)', 'var(--brand-wash)'],
  ['linear-gradient(140deg, rgba(47, 107, 221, 0.1), rgba(146, 178, 255, 0.16))', 'var(--brand-wash)'],

  // 品牌紫（score 徽章）
  ['#ede8ff', 'var(--purple-soft)'],
  ['#6b4ee6', 'var(--purple-text)'],

  // Toast 语义底
  ['rgba(24, 128, 82, 0.94)', 'var(--toast-success-bg)'],
  ['rgba(190, 52, 52, 0.94)', 'var(--toast-error-bg)']
];

// 单值替换：这些只在「值的位置」出现，可以用更宽松的匹配
var SIMPLE = [
  // 用户气泡上的缩略图占位底
  ['rgba(255, 255, 255, 0.2)', 'var(--surface-on-accent)'],
  // 纯白表面（输入框聚焦、分段控件选中）
  ['background: #fff;', 'background: var(--surface-3);'],
  // 反色文字
  ['color: #fff;', 'color: var(--text-invert);']
];

function isVarDefinition(line) {
  return /^\s*--[\w-]+\s*:/.test(line);
}

function transform(content) {
  var lines = content.split('\n');
  var changed = 0;

  for (var i = 0; i < lines.length; i++) {
    if (isVarDefinition(lines[i])) continue;   // 变量定义行原样保留

    var line = lines[i];
    var before = line;

    for (var m = 0; m < MAP.length; m++) {
      if (line.indexOf(MAP[m][0]) !== -1) {
        line = line.split(MAP[m][0]).join(MAP[m][1]);
      }
    }
    for (var s = 0; s < SIMPLE.length; s++) {
      if (line.indexOf(SIMPLE[s][0]) !== -1) {
        line = line.split(SIMPLE[s][0]).join(SIMPLE[s][1]);
      }
    }

    if (line !== before) {
      lines[i] = line;
      changed++;
    }
  }

  return { content: lines.join('\n'), changed: changed };
}

function walk(dir, out) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(vue|css)$/.test(e.name)) out.push(full);
  }
  return out;
}

var files = walk(SRC, []);
var totalChanged = 0;

for (var f = 0; f < files.length; f++) {
  var file = files[f];
  var original = fs.readFileSync(file, 'utf8');
  var result = transform(original);

  if (result.changed > 0) {
    fs.writeFileSync(file, result.content, 'utf8');
    totalChanged += result.changed;
    console.log('  ' + path.relative(SRC, file) + '  →  ' + result.changed + ' 行');
  }
}

console.log('\n共替换 ' + totalChanged + ' 行。');
console.log('接下来跑 scan-hardcoded-colors.js 确认没有遗漏。');
