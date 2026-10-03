// 一次性脚本：把 CSS 里的 `inset: 0` 展开成四条边。
// 原因：inset 简写 Chrome 87+ 才支持，而设备基线是 Android 9 / Chrome 80。
// 未展开时 position:fixed 的遮罩拿不到任何偏移，尺寸塌成内容大小 ——
// 表现就是「弹窗遮不住、上传按钮点不动」。
// 只匹配整行独立的 inset 声明，不会误伤 --shadow-inset 之类的自定义属性。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'src');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(vue|css)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT, []);

// 注意：这里**不能**展开成 top/right/bottom/left: 0。
// Vite 的 CSS 压缩器会把这四条重新合并回 inset: 0，源码改了等于没改（实测踩过）。
// 用 top/left + width/height:100% 表达，压缩器无法折叠成 inset，
// 且在 box-sizing: border-box（项目已全局设置）下与 inset:0 完全等价。
const FOUR_SIDES = 'top: 0;\n{INDENT}left: 0;\n{INDENT}width: 100%;\n{INDENT}height: 100%;';

const reInset = /^([ \t]*)inset:[ \t]*0;[ \t]*$/gm;
// 兼容上一版已经展开成四边的写法，一并转成不会被折叠的形式
const reFour = /^([ \t]*)top:[ \t]*0;[ \t]*\n\1right:[ \t]*0;[ \t]*\n\1bottom:[ \t]*0;[ \t]*\n\1left:[ \t]*0;[ \t]*$/gm;

let total = 0;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let next = src.replace(reInset, function(_m, indent) {
    total++;
    return indent + FOUR_SIDES.split('{INDENT}').join(indent);
  });
  next = next.replace(reFour, function(_m, indent) {
    total++;
    return indent + FOUR_SIDES.split('{INDENT}').join(indent);
  });
  if (next !== src) {
    fs.writeFileSync(f, next, 'utf8');
    console.log('fixed ' + path.relative(ROOT, f));
  }
}

console.log('done, replaced ' + total + ' declaration(s)');
