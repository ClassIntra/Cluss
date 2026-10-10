// 题库分片校验：结构 + id 唯一 + 难度分布 + 三级提示是否泄底
// 用法: node check-bank.cjs <file.json> [...]
const fs = require('fs');

const REQUIRED = [
  'id', 'subject', 'grade', 'difficulty', 'topic', 'type',
  'stem', 'answer', 'solution', 'knowledge', 'hint_ladder',
  'trap', 'source_name', 'est_sec', 'score'
];
const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理'];
const DIFFS = ['基础', '中档', '拔高'];

// 从文本里抓所有数值（含负号与小数）
function nums(s) {
  return (String(s).match(/-?\d+(\.\d+)?/g) || []);
}

function norm(obj) {
  return Array.isArray(obj) ? obj.join(' ') : String(obj);
}

function check(file) {
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`[${file}] ✗ JSON 解析失败: ${e.message}`);
    return 1;
  }
  // 允许 {items:[...]} 外壳
  const items = Array.isArray(arr) ? arr : (arr.items || []);
  const errs = [];
  const seen = new Set();

  for (const it of items) {
    const tag = it.id || '(无 id)';
    for (const f of REQUIRED) {
      if (it[f] === undefined || it[f] === null || it[f] === '') {
        if (f === 'source_url') continue;
        errs.push(`${tag} 缺字段 ${f}`);
      }
    }
    if (it.id && seen.has(it.id)) errs.push(`${tag} id 重复`);
    seen.add(it.id);
    if (it.subject && !SUBJECTS.includes(it.subject)) errs.push(`${tag} 非法学科 ${it.subject}`);
    if (it.difficulty && !DIFFS.includes(it.difficulty)) errs.push(`${tag} 非法难度 ${it.difficulty}`);
    if (it.hint_ladder && (!Array.isArray(it.hint_ladder) || it.hint_ladder.length !== 3)) {
      errs.push(`${tag} hint_ladder 必须长度为 3`);
    }
    if (it.type === '选择' && !it.options) errs.push(`${tag} 选择题缺 options`);
    if (it.type === '选择' && it.options) {
      const keys = Object.keys(it.options).sort().join('');
      if (keys !== 'ABCD') errs.push(`${tag} 选项键应为 ABCD，实际 ${keys}`);
    }
    // 泄底检查
    const ans = norm(it.answer);
    const h3 = String((it.hint_ladder && it.hint_ladder[2]) || '');
    if (ans.length >= 2 && h3.includes(ans)) errs.push(`${tag} 三级提示直接包含整条答案`);
    const an = nums(ans);
    if (an.length) {
      // 答案里的每个数值都出现在第三级提示 => 疑似直接给数
      const hn = new Set(nums(h3));
      if (an.every(v => hn.has(v)) && /\d/.test(ans)) {
        errs.push(`${tag} 三级提示疑似直接给出结果数值 (${an.join(',')})`);
      }
    }
  }

  const bySubject = items.reduce((p, x) => { p[x.subject] = (p[x.subject] || 0) + 1; return p; }, {});
  const byDiff = items.reduce((p, x) => { p[x.difficulty] = (p[x.difficulty] || 0) + 1; return p; }, {});
  const badUrl = items.filter(x => x.source_url && !/^https?:\/\//.test(x.source_url)).map(x => x.id);

  console.log(`\n=== ${file} ===`);
  console.log(`条数 ${items.length} | 唯一 id ${seen.size}`);
  console.log('学科分布', JSON.stringify(bySubject, null, 0));
  console.log('难度分布', JSON.stringify(byDiff, null, 0));
  if (badUrl.length) console.log('⚠ 非法 URL 条目:', badUrl.join(','));
  if (errs.length) {
    console.log(`✗ 问题 ${errs.length} 条:`);
    errs.slice(0, 40).forEach(e => console.log('   -', e));
    if (errs.length > 40) console.log(`   ...还有 ${errs.length - 40} 条`);
    return 1;
  }
  console.log('✓ 全部通过');
  return 0;
}

let fail = 0;
for (const f of process.argv.slice(2)) fail = check(f) || fail;
process.exit(fail);
