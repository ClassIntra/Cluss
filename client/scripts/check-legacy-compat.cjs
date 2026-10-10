/**
 * 旧内核（Chrome 80 / Android 9 / 微信 X5）兼容性守卫
 *
 * 这个脚本存在的原因：有两类问题**只在旧内核上出现，而且不报错、不难复现**：
 *   1. CSS 压缩器把 `top/right/bottom/left: 0` 合并成 `inset: 0`（Chrome 87+）。
 *      旧内核整条忽略 —— 表现是某个浮层"位置不对/不铺屏"，极易被当成样式没写对。
 *      注意：**源码是对的，坏在构建产物上**，所以只能扫 dist。
 *   2. 打包器把垫片模块当成"无副作用"摇掉。源码里明明写着，产物里没了。
 *
 * 三部分检查：
 *   A. 垫片功能自测：把原生 API 删掉，再执行垫片源码，断言行为真的对（含 $ 占位符、
 *      循环引用、instanceof 这类容易写错的点）。顺带断言"新浏览器上它是空操作"。
 *   B. 源码接线：main.js 必须把垫片放在**第一条** import。
 *   C. 产物扫描：dist 的 CSS 里不许有 inset 简写；入口包里必须还能找到垫片；
 *      并清点剩余的新 API（预期只剩懒加载的 mermaid 分片，由全局垫片覆盖）。
 *
 * 用法：node scripts/check-legacy-compat.cjs      （在 client/ 下执行）
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const polyfillPath = path.join(root, 'src/legacy/polyfills.js');
const mainPath = path.join(root, 'src/main.js');
const distDir = path.join(root, 'dist');

let failed = 0;
const fail = (msg) => { failed++; console.log('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

// ============================================================ A. 垫片功能自测
console.log('\n=== A. 垫片功能自测（把原生 API 删掉再执行垫片）===');

const src = fs.readFileSync(polyfillPath, 'utf8');

// A1) 先验"空操作"：原生都在时，跑一遍垫片，任何原生方法都不允许被替换。
// 这条能挡住"忘了写特性探测"这种错——那种垫片会在新浏览器上悄悄换掉原生实现。
const natives = {
  at: Array.prototype.at,
  replaceAll: String.prototype.replaceAll,
  hasOwn: Object.hasOwn,
  structuredClone: globalThis.structuredClone,
  AggregateError: globalThis.AggregateError
};
(0, eval)(src);
const untouched =
  Array.prototype.at === natives.at &&
  String.prototype.replaceAll === natives.replaceAll &&
  Object.hasOwn === natives.hasOwn &&
  globalThis.structuredClone === natives.structuredClone &&
  globalThis.AggregateError === natives.AggregateError;
untouched ? ok('原生 API 齐全时，垫片是空操作（原生实现未被替换）')
          : fail('垫片替换了原生实现 —— 说明缺特性探测');

// A2) 删掉原生，再执行垫片 —— 模拟 Chrome 80（这个进程是临时的，污染无所谓）
delete Array.prototype.at;
delete String.prototype.replaceAll;
delete Object.hasOwn;
delete globalThis.structuredClone;
delete globalThis.AggregateError;
(0, eval)(src);

const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? ok(label) : fail(label + '：得到 ' + g + '，期望 ' + w);
};

// Array.prototype.at
eq('Array.at(-1) 取末元素', [1, 2, 3].at(-1), 3);
eq('Array.at(0)', [1, 2, 3].at(0), 1);
eq('Array.at 越界返回 undefined', [1, 2, 3].at(5), undefined);
eq('Array.at(-9) 越界返回 undefined', [1, 2, 3].at(-9), undefined);
eq('空数组 at(-1)', [].at(-1), undefined);

// String.prototype.replaceAll
eq('replaceAll 字符串替换全部', 'a-b-a'.replaceAll('a', 'x'), 'x-b-x');
// 必须是**全局**正则才允许：传 /b/ 会抛 TypeError（这是原生规范行为，
// 不是垫片的额外限制）—— 下面那条单独验它。
eq('replaceAll 全局正则替换', 'abc'.replaceAll(/b/g, 'X'), 'aXc');
eq('replaceAll 非全局正则会抛错', (() => {
  try { 'abc'.replaceAll(/b/, 'X'); return 'no-throw'; }
  catch (e) { return e instanceof TypeError ? 'TypeError' : 'other'; }
})(), 'TypeError');
// 关键点：替换串里的 $ 占位符必须按规范解释。
// 用 split().join() 实现会原样塞进 "$&"，得到 "a$&a$&" —— 这条就是拦它的。
eq('replaceAll 解释 $& 占位符', 'a1a2'.replaceAll('a', '[$&]'), '[a]1[a]2');

// Object.hasOwn
eq('Object.hasOwn 自有属性为真', Object.hasOwn({ a: 1 }, 'a'), true);
eq('Object.hasOwn 原型属性为假', Object.hasOwn({}, 'toString'), false);
eq('Object.hasOwn(null) 抛 TypeError', (() => {
  try { Object.hasOwn(null, 'a'); return 'no-throw'; }
  catch (e) { return e instanceof TypeError ? 'TypeError' : 'other'; }
})(), 'TypeError');

// structuredClone
const original = { a: 1, nested: { b: [1, 2, 3] }, d: new Date(0), m: new Map([['k', 'v']]) };
const copy = structuredClone(original);
eq('structuredClone 是深拷贝（改副本不影响原件）', (() => {
  copy.nested.b.push(99);
  return original.nested.b.length;
})(), 3);
eq('structuredClone 保留 Date', copy.d.getTime(), 0);
eq('structuredClone 保留 Map', copy.m.get('k'), 'v');
const cyclic = { self: null };
cyclic.self = cyclic;
// 循环引用：副本的 self 必须指回**副本自己**，而不是原件、也不是 undefined。
// （写成 structuredClone(cyclic).self === structuredClone(cyclic) 是错的 ——
//   两次调用各产生一个新副本，永远不相等，那样的断言恒真且什么都没验。）
const cyclicCopy = structuredClone(cyclic);
eq('structuredClone 能处理循环引用', cyclicCopy.self === cyclicCopy, true);

// AggregateError —— 重点验 instanceof，这是 mermaid 唯一的用法
const agg = new AggregateError([new Error('x')], 'boom');
eq('AggregateError instanceof 自身', agg instanceof AggregateError, true);
eq('AggregateError instanceof Error', agg instanceof Error, true);
eq('AggregateError.errors', agg.errors.length, 1);
eq('AggregateError.name', agg.name, 'AggregateError');
eq('AggregateError.message', agg.message, 'boom');

// ============================================================ B. 源码接线
console.log('\n=== B. 源码接线 ===');
const mainSrc = fs.readFileSync(mainPath, 'utf8');
const importLines = mainSrc.split('\n').filter((l) => /^\s*import\s/.test(l));
if (importLines.length && /legacy\/polyfills/.test(importLines[0])) {
  ok('main.js 的第一条 import 就是垫片');
} else {
  fail('main.js 里垫片不是第一条 import（当前第一条：' + (importLines[0] || '无').trim() + '）');
}

// ============================================================ C. 产物扫描
console.log('\n=== C. 构建产物扫描 ===');
if (!fs.existsSync(distDir)) {
  console.log('  – 未找到 dist（还没构建），跳过产物扫描');
} else {
  const assetsDir = path.join(distDir, 'assets');
  const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];

  // C1) CSS 里不许出现 inset 简写
  const insetRe = /(^|[;{\s])inset\s*:/;
  const badCss = [];
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(assetsDir, f), 'utf8');
    if (insetRe.test(css)) badCss.push(f);
  }
  if (badCss.length) {
    fail('CSS 里出现了 inset 简写（Chrome 87+，旧内核整条忽略）：' + badCss.join(', '));
    console.log('     修法：确认 vite.config.js 的 build.cssTarget 是 \'chrome80\'');
  } else {
    ok('构建后的 CSS 里没有 inset 简写');
  }

  // C2) 入口包里垫片必须还在（防被 tree-shaking 摇掉）
  const entry = files.find((f) => /^index-.*\.js$/.test(f));
  if (!entry) {
    fail('找不到入口包 index-*.js');
  } else {
    const js = fs.readFileSync(path.join(assetsDir, entry), 'utf8');
    const marks = [
      ['Array.prototype.at', /defineProperty\(Array\.prototype,\s*["']at["']/],
      ['String.prototype.replaceAll', /["']replaceAll["']/],
      ['Object.hasOwn', /["']hasOwn["']/],
      ['structuredClone', /structuredClone/],
      ['AggregateError', /AggregateError/]
    ];
    const missing = marks.filter(([, re]) => !re.test(js)).map(([n]) => n);
    missing.length
      ? fail('入口包里找不到这些垫片（可能被摇掉了）：' + missing.join(', '))
      : ok('入口包 ' + entry + ' 里五个垫片都在');
  }

  // C3) 清点剩余的新 API（信息性：预期只剩懒加载的 mermaid 分片）
  const risky = [
    ['Array.at', /\.at\(/],
    ['String.replaceAll', /\.replaceAll\(/],
    ['Object.hasOwn', /Object\.hasOwn\(/],
    ['structuredClone', /structuredClone/],
    ['AggregateError', /AggregateError/]
  ];
  const found = {};
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    if (entry && f === entry) continue;               // 入口包 = 垫片自身，不算
    const js = fs.readFileSync(path.join(assetsDir, f), 'utf8');
    for (const [name, re] of risky) {
      if (re.test(js)) (found[name] = found[name] || []).push(f.replace(/-[A-Za-z0-9_-]{8}\.js$/, ''));
    }
  }
  const names = Object.keys(found);
  if (names.length) {
    console.log('  – 其余分片里仍能搜到这些 API（预期：懒加载的 mermaid，运行时由垫片覆盖）');
    for (const n of names) console.log('      ' + n + ' ← ' + [...new Set(found[n])].join(', '));
    if (names.some((n) => !/mermaid|cytoscape|dagre|Diagram/.test(found[n].join(',')))) {
      fail('有 mermaid 之外的分片也在用这些 API —— 请复核是否真的都在图表路径上');
    }
  } else {
    ok('除入口包外，没有分片使用 Chrome 80 之后的 API');
  }
}

console.log('\n' + (failed ? '失败 ' + failed + ' 项' : '全部通过'));
process.exit(failed ? 1 : 0);
