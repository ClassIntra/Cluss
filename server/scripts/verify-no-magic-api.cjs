#!/usr/bin/env node
// 守卫：前端不允许再出现裸 '/api' 请求字面量。
//
// 为什么值得一个脚本把着：
//   Cluss 现在同时支持两种挂载 —— 根路径（http://<host>:9003/）和子路径
//   （ClassIntra HTTPS 站点反代到 /cluss-app/）。子路径下请求前缀必须跟着
//   页面路径走（utils/base-path.js 的 apiBase/apiUrl），任何一处写死 '/api'
//   都会打到**宿主**（ClassIntra）自己的接口上。而那种故障的样子特别具有误导性：
//   页面正常渲染、请求也返回 200，只是内容全是 CI 的数据，或者莫名 401 ——
//   排查时很难第一时间想到「前缀打错了对象」。
//
//   这类错误正则搜得出来，但只靠「记得搜」拦不住下一次新增。
//   本脚本进 verify:all，让 CI/发版前自动把这一关。
//
// 检查范围：client/src 下全部 .js / .vue。
// 放行：utils/base-path.js（它是前缀的唯一来源，注释里必然提到 '/api'）。

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '../../client/src');
var ALLOW = [path.join(ROOT, 'utils', 'base-path.js')];

// 匹配 '…' "…" `…` 里以 /api 开头的片段（含拼接起点 '/api/xxx' 与完整 '/api'）
var BARE = /(['"`])\/api(?=[\s'"`/]|$)/;

function walk(dir, out) {
  fs.readdirSync(dir).forEach(function(name) {
    var p = path.join(dir, name);
    var st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules') return;
      walk(p, out);
    } else if (/\.(js|vue)$/.test(name)) {
      out.push(p);
    }
  });
  return out;
}

// 去掉注释再匹配：base-path.js 之外的说明文字里提到 /api 不算违规，
// 但为了避免「注释里写错反而误导」，也只剥注释、不改代码语义。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

var files = walk(ROOT, []);
var bad = [];
files.forEach(function(f) {
  if (ALLOW.indexOf(f) !== -1) return;
  var src;
  try { src = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
  var lines = stripComments(src).split(/\r?\n/);
  lines.forEach(function(line, i) {
    if (BARE.test(line)) {
      bad.push(path.relative(ROOT, f) + ':' + (i + 1) + '  ' + line.trim().slice(0, 90));
    }
  });
});

if (bad.length) {
  console.error('✗ 发现 ' + bad.length + ' 处裸 /api 字面量（应改为 apiBase/apiUrl 拼接）：');
  bad.forEach(function(l) { console.error('   ' + l); });
  console.error('');
  console.error('  规则见 client/src/utils/base-path.js：子路径挂载时前缀必须跟随页面路径。');
  process.exit(1);
}
console.log('✓ 前端无裸 /api 字面量（检查 ' + files.length + ' 个文件）');
