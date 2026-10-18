// 一次性把三个 package.json 的版本号改成同一个值。
//
// 为什么要这个脚本：
//   本仓是单仓三包，历史上 root/server/client 各改各的，出现过 0.2.0 / 0.3.0 /
//   0.3.0 的分裂。而服务端只读自己的 package.json 打在启动横幅和 /api/health 上，
//   分裂时「对外报的版本」取决于哪台机器装了哪个包 —— 线上排查极具误导。
//
//   所以发版不该靠人记得改三处，而该由一个命令改三处。
//
// 跑法：
//   npm run bump -- patch          0.3.0 → 0.3.1
//   npm run bump -- minor          0.3.0 → 0.4.0
//   npm run bump -- major          0.3.0 → 1.0.0
//   npm run bump -- 0.4.0-beta.1   直接指定具体版本
//
// 只改 version 字段，其余内容与缩进原样保留（逐行改写，不重新序列化 JSON），
// 避免把整个文件重排成另一种缩进、制造出几百行无意义 diff。
'use strict';

var path = require('path');
var fs = require('fs');

var ROOT = path.resolve(__dirname, '..');

var FILES = [
  'package.json',
  'server/package.json',
  'client/package.json'
];

var KIND = { patch: 1, minor: 1, major: 1 };

function readJson(f) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}

function readCurrent() {
  // 以根包为准：它是最外层的、也是人最可能先看的那一个
  var v = String(readJson(FILES[0]).version || '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error('根包当前版本号不是 x.y.z 形式：%j —— 先手工修好再跑本脚本', v);
    process.exit(1);
  }
  return v.split('.').map(Number);
}

function writeVersion(file, next) {
  var full = path.join(ROOT, file);
  var lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  var hit = false;
  var re = /^(\s*"version"\s*:\s*)"([^"]*)"(.*)$/;
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(re);
    if (!m) continue;
    lines[i] = m[1] + '"' + next + '"' + m[3];
    hit = true;
    break;   // 只改第一处：version 在这三个文件里都只出现一次
  }
  if (!hit) {
    console.error('%s 里没找到 version 字段，未改动', file);
    process.exit(1);
  }
  fs.writeFileSync(full, lines.join('\n'));
  console.log('  · %s → %s', file, next);
}

var arg = String(process.argv[2] || '').trim();
if (!arg) {
  console.error('用法：npm run bump -- <patch|minor|major|具体版本号>');
  process.exit(1);
}

var cur = readCurrent();
var next;

if (KIND[arg]) {
  var parts = cur.slice();
  if (arg === 'patch') parts[2]++;
  else if (arg === 'minor') { parts[1]++; parts[2] = 0; }
  else { parts[0]++; parts[1] = 0; parts[2] = 0; }
  next = parts.join('.');
} else if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg)) {
  next = arg;
} else {
  console.error('看不懂的版本参数：%j', arg);
  console.error('只接受 patch / minor / major，或形如 0.4.0、1.0.0-beta.1 的具体版本');
  process.exit(1);
}

console.log('%s.%s.%s → %s（三个包同步改）', cur[0], cur[1], cur[2], next);
FILES.forEach(function(f) { writeVersion(f, next); });

console.log('');
console.log('已改完。提交前建议跑一次：npm run verify:version');