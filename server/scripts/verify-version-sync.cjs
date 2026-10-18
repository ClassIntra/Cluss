// 验证脚本：三个 package.json 的版本号必须一致
//
// 为什么要有这个检查：
//   本仓库是单仓三包（root / server / client），历史上三者各改各的，
//   结果出现过 root=0.2.0 而 server=client=0.3.0 的分裂。服务端只读自己的
//   package.json 打在启动横幅和 /api/health 上，所以分裂时「对外报的版本」
//   取决于哪台机器装的是哪个包，排查线上问题时非常误导。
//
//   单靠人记着不够 —— 发版时最容易漏的就是根包。固化成一条命令，
//   顺手挂进 pretest/提交钩子，下次不一致会当场叫出来而不是等上线后才发现。
//
// 跑法：node server/scripts/verify-version-sync.cjs
// 不需要任何环境变量，不碰数据库。
'use strict';

var path = require('path');
var fs = require('fs');

var ROOT = path.resolve(__dirname, '..', '..');

var TARGETS = [
  { label: '根包', file: 'package.json' },
  { label: '服务端', file: 'server/package.json' },
  { label: '前端', file: 'client/package.json' }
];

var failed = 0;

var versions = TARGETS.map(function(t) {
  var full = path.join(ROOT, t.file);
  if (!fs.existsSync(full)) {
    console.error('  ✗ %s（%s）不存在', t.label, t.file);
    failed++;
    return { label: t.label, file: t.file, version: null };
  }
  var pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    console.error('  ✗ %s（%s）不是合法 JSON：%s', t.label, t.file, err.message);
    failed++;
    return { label: t.label, file: t.file, version: null };
  }
  var v = String(pkg.version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error('  ✗ %s（%s）版本号不是 x.y.z 形式：%j', t.label, t.file, v);
    failed++;
  }
  console.log('  · %s %s → %s', t.label, t.file, v || '(缺失)');
  return { label: t.label, file: t.file, version: v };
});

var uniq = {};
versions.forEach(function(v) { if (v.version) uniq[v.version] = true; });
var distinct = Object.keys(uniq);

console.log('');
if (failed > 0) {
  console.error('✗ 版本号校验失败：%d 项问题', failed);
  process.exit(1);
}
if (distinct.length > 1) {
  console.error('✗ 三个包的版本号不一致：%s', distinct.join(' / '));
  console.error('  本仓是单仓三包，对外只报一个版本；分裂会让启动横幅与 /api/health');
  console.error('  打出不同版本号，排查线上问题时极具误导性。统一后再提交。');
  process.exit(1);
}

console.log('✓ 三个包版本号一致：%s', distinct[0]);