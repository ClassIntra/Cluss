// 一次性清理：gen-flex-gap-fallback.cjs 只对自己的产物幂等，
// 与早期手写的 `html.no-flex-gap ...` 回退撞了车，生成了一批完全相同的重复规则。
// 同一文件里选择器与声明完全相同的规则块，级联结果不变，直接去重即可。
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

// 匹配一条完整的规则块（含其前的换行缩进），用于整体摘出比较
const RULE_RE = /html\.no-flex-gap[^{}]*\{[^{}]*\}/g;

let total = 0;
for (const f of walk(ROOT, [])) {
  const src = fs.readFileSync(f, 'utf8');
  const seen = new Set();
  let out = src.replace(RULE_RE, function (m) {
    const key = m.replace(/\s+/g, ' ').trim();
    if (seen.has(key)) { total++; return ''; }
    seen.add(key);
    return m;
  });
  // 摘掉规则后残留的多余空行（三连以上换行压成两连）
  out = out.replace(/\n{3,}/g, '\n\n');
  if (out !== src) {
    fs.writeFileSync(f, out, 'utf8');
    console.log('deduped ' + path.relative(ROOT, f));
  }
}
console.log('done, removed ' + total + ' duplicate rule(s)');
