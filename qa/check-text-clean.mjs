// 文本清洁度检查：揪出混进代码的乱码串
// 判据：① 非预期的非中日常用字符（如 Cyrillic / Thai / Arabic / Hangul）
//       ② 注释行里连续 3 个以上「非驼峰小写英文单词」（英文散文才会这样）
// 用法: node check-text-clean.mjs <file1> [file2 ...]
import fs from 'fs';

const SUSPICIOUS = /[\u0400-\u04FF\u0600-\u06FF\u0E00-\u0E7F\u0900-\u097F\uAC00-\uD7AF]/g;
// 连续 >=3 个小写英文单词（中间可有空格），例： "the 模型 is'
const PROSE = /\b(?:[a-z]{2,}\b\s+){2,}[a-z]{2,}\b/g;

function isCommentish(line) {
  return /^\s*(\/\/|\*|\/\*)/.test(line) || /\/\/ /.test(line);
}

function check(file) {
  const s = fs.readFileSync(file, 'utf8');
  const out = [];
  s.split('\n').forEach((ln, i) => {
    SUSPICIOUS.lastIndex = 0;
    let m;
    while ((m = SUSPICIOUS.exec(ln))) {
      out.push(`${file}:${i + 1} 非预期字符 U+${[...m[0]].map(c => c.codePointAt(0).toString(16)).join(',')} :: ${ln.trim().slice(0, 100)}`);
    }
    if (isCommentish(ln)) {
      const stripped = ln.replace(/`[^`]*`/g, '').replace(/<[a-zA-Z][^>]*>/g, '').replace(/'[^']*'/g, '');
      PROSE.lastIndex = 0;
      let p;
      while ((p = PROSE.exec(stripped))) {
        const seg = p[0].trim();
        if (seg.split(' ').length >= 3) out.push(`${file}:${i + 1} 可疑外文串 "${seg.slice(0, 60)}" :: ${ln.trim().slice(0, 90)}`);
      }
    }
  });
  return out;
}

let total = 0;
for (const f of process.argv.slice(2)) {
  let ps;
  try { ps = check(f); } catch (e) { ps = [`读取失败 ${f}: ${e.message}`]; }
  total += ps.length;
  if (ps.length) { console.log(`\n✗ ${f} —— ${ps.length} 处`); ps.slice(0, 25).forEach(p => console.log('   ' + p)); }
  else console.log(`✓ ${f}`);
}
console.log(`\n合计 ${total} 处可疑`);
process.exit(total ? 1 : 0);
