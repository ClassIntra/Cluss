// 合并题库分片为最终 v2 题库
// 来源：① bank-src-A/B/C.json（三组并行产出，放在本目录）② 旧 question-bank.json（自动升级到 v2 字段）
// 去重口径：同学科下题干前 30 字相同视为重复（保留信息更全的那条）
//
// 用法：node qa/merge-bank.cjs
// 路径全部相对本脚本，不依赖调用时的 cwd。
const fs = require('fs');
const path = require('path');
const DIR = __dirname + path.sep;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

const parts = [];
for (const f of ['bank-src-A.json', 'bank-src-B.json', 'bank-src-C.json']) {
  const raw = readJson(DIR + f);
  if (!raw) { console.log('缺文件', f); continue; }
  const arr = Array.isArray(raw) ? raw : (raw.items || []);
  console.log(`${f}: ${arr.length} 条`);
  parts.push(...arr);
}

// ---- 旧题库升级到 v2：补三级提示（从 solution 抽）/ 知识标签 / 错因 ----
// ---- 旧题库选择题：把埋在题干里的 A./B./C./D. 抽成结构化 options ----
// 为什么要抽：这是**题库自身的缺陷**，不是数据格式洁癖。
// 1) 复用性差：评卷/判分/组卷时拿不到独立选项，只能每次正则再切一遍；
// 2) AI 出题与判题需要独立选项字段作为 I/O 契约；
// 3) 渲染层面：结构化后能做「选项卡」而不是一坨文本，学生做题体验完全不同。
function extractOptions(it) {
  if (it.options) return it;
  if (String(it.type) !== '选择') return it;
  const lines = String(it.stem).split('\n');
  const opt = {};
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([ABCD])[．、\.\)：:]\s*(.+)$/);
    if (m) {
      if (start < 0) start = i;
      opt[m[1]] = m[2].trim();
    }
  }
  if (Object.keys(opt).length === 4 && start >= 0) {
    const cut = lines.slice(0, start).join('\n').trim();
    if (cut.length >= 8) return Object.assign({}, it, { stem: cut, options: opt });
  }
  // 同行排布： A．xxx　B．xxx　C．xxx　D．xxx（旧题里政史地与英语都这么写）
  const inline = extractInlineOptions(it.stem);
  if (inline) return Object.assign({}, it, inline);

  // 抽不出来就保持原样：让校验器继续报错，不静默吞掉
  return it;
}

// 同行选项解析：定位四个 A/B/C/D 起点，逐段切分
function extractInlineOptions(stem) {
  const lines = String(stem).split('\n');
  if (lines.length < 2) return null;
  const last = lines[lines.length - 1];
  const marks = [];
  const re = /(?:^|[\s　])([ABCD])[．、.）)]:?/g;
  let m;
  while ((m = re.exec(last))) {
    marks.push({ key: m[1], textStart: m.index + m[0].length });
  }
  if (marks.length !== 4) return null;
  const keys = marks.map(x => x.key).join('');
  if (keys !== 'ABCD') return null;
  const opt = {};
  for (let i = 0; i < 4; i++) {
    const end = i < 3 ? marks[i + 1].textStart - 1 : last.length;
    const val = last.slice(marks[i].textStart, end).replace(/[\s　]+$/, '').trim();
    if (!val) return null;
    opt[marks[i].key] = val;
  }
  const head = lines.slice(0, -1).join('\n').trim();
  if (head.length < 8) return null;
  return { stem: head, options: opt };
}

// ---- 三级提示泄底修正 ----
// 自动迁移出来的第三级偶尔会把最终数值写进去（如"代入得 x=2"）。
// 题库是用来验证 AI「会不会抢答」的标尺，标尺自己泄底就测不准了。
function sanitizeHints(it) {
  const h = Array.isArray(it.hint_ladder) ? it.hint_ladder.slice() : [];
  if (h.length !== 3) return it;
  const ans = Array.isArray(it.answer) ? it.answer.join('；') : String(it.answer || '');
  const numbersOfAnswer = (String(ans).match(/-?\d+(\.\d+)?/g) || []);
  if (!numbersOfAnswer.length) return it;
  const h3 = String(h[2]);
  const appeared = numbersOfAnswer.filter(v => h3.indexOf(v) >= 0);
  if (!appeared.length) return it;
  // 删掉第三级里的结果值，保留思路部分；若删完太空则用通用替代表述
  let fixed = h3;
  appeared.forEach(v => { fixed = fixed.split(v).join('（此处自己算）'); });
  if (fixed.replace(/[^一-龥]/g, '').length < 8) {
    fixed = '到这一步只差代入计算了：把前面得到的量代入关键等式，自己把结果算出来再往下走。';
  }
  const next = Object.assign({}, it, { hint_ladder: [h[0], h[1], fixed] });
  next.hint_fixed = '第三级原含结果数值，已改写';
  return next;
}

function upgradeOld(items) {
  return items.map(function(x, i) {
    const sol = String(x.solution || '');
    const steps = sol.split(/\n?\d+\.\s*/).filter(Boolean).map(s => s.trim().replace(/\s+/g, ' '));
    return {
      id: String(x.id || ('OLD-' + i)),
      subject: x.subject,
      grade: x.grade || '高三',
      difficulty: x.difficulty,
      topic: x.topic,
      type: x.type || '解答',
      stem: x.stem,
      options: x.options || undefined,
      answer: x.answer,
      solution: sol,
      knowledge: x.knowledge || [x.topic].filter(Boolean),
      hint_ladder: x.hint_ladder || [
        '先确认这题属于「' + x.topic + '」，回想对应的定义与适用条件。',
        (steps[0] || '顺着条件把已知量列出来，再找它们之间的对应关系。').slice(0, 60),
        (steps[1] || '把最关键的一步等式写出来，剩下的化简自己完成。').slice(0, 60)
      ],
      trap: x.trap || '（未提供：需在授课补全）',
      misconception: x.misconception || '',
      source_name: x.source || '旧版题库迁移',
      source_url: '',
      est_sec: Number(x.est_sec) || 480,
      score: Number(x.score) || 12
    };
  });
}

const oldRaw = readJson(DIR + 'question-bank-v1-legacy.json');
if (oldRaw) {
  let oldItems = upgradeOld(oldRaw.items || []);
  const before = oldItems.length;
  oldItems = oldItems.map(extractOptions).map(sanitizeHints);
  console.log('旧题库升级:', oldItems.length, '条；其中结构化出选项',
    oldItems.filter(x => x.options).length, '条；修正提示',
    oldItems.filter(x => x.hint_fixed).length, '条（原 ' + before + '）');
  parts.push(...oldItems);
}

// ---- 合并去重 ----
function key(it) {
  const stem = String(it.stem || '').replace(/\s+/g, '').slice(0, 30);
  return it.subject + '|' + stem;
}
function richness(it) {
  return JSON.stringify(it).length;
}
const map = new Map();
let dup = 0;
for (const it of parts) {
  const k = key(it);
  if (map.has(k)) {
    if (richness(it) > richness(map.get(k))) map.set(k, it);
    dup++;
  } else map.set(k, it);
}
const items = [...map.values()];
console.log(`合并后 ${items.length} 条（去重 ${dup} 条）`);

// ---- 统计 ----
const bySubject = items.reduce((p, x) => { p[x.subject] = (p[x.subject] || 0) + 1; return p; }, {});
const byDiff = items.reduce((p, x) => { p[x.difficulty] = (p[x.difficulty] || 0) + 1; return p; }, {});
const byType = items.reduce((p, x) => { p[x.type] = (p[x.type] || 0) + 1; return p; }, {});
const byGrade = items.reduce((p, x) => { p[x.grade] = (p[x.grade] || 0) + 1; return p; }, {});
const withUrl = items.filter(x => x.source_url && /^https?:\/\//.test(x.source_url)).length;
const topics = new Set(items.map(x => x.topic));
const knowledge = new Set(items.flatMap(x => x.knowledge || []));
console.log('学科:', JSON.stringify(bySubject));
console.log('难度:', JSON.stringify(byDiff));
console.log('题型:', JSON.stringify(byType));
console.log('年级:', JSON.stringify(byGrade));
console.log('知识点数:', topics.size, ' 标签数:', knowledge.size, ' 带真实来源 URL:', withUrl);

const out = {
  version: '2.0',
  generated_at: new Date().toISOString().slice(0, 10),
  description: `高中生引导式 AI 解题应用的测试题库 v2：${items.length} 题，覆盖 ${Object.keys(bySubject).length} 学科、${Object.keys(byType).length} 类题型、${topics.size} 个知识点`,
  stats: {
    total: items.length, by_subject: bySubject, by_difficulty: byDiff,
    by_type: byType, by_grade: byGrade, topics: topics.size, knowledge_tags: knowledge.size, with_source_url: withUrl
  },
  items: items
};
fs.writeFileSync(DIR + 'question-bank-v2.json', JSON.stringify(out, null, 2), 'utf8');
console.log('\n已写出 question-bank-v2.json');

// ---- Markdown 版（给人看）----
const md = [];
md.push('# Cluss 测试题库 v2');
md.push('');
md.push(`共 **${items.length}** 题。学科 ${JSON.stringify(bySubject)}，难度 ${JSON.stringify(byDiff)}，题型 ${JSON.stringify(byType)}。`);
md.push('');
md.push('> 每题带三级引导提示（hint_ladder），用于验证 AI 是否做到「给方向而不直接给答案」。');
md.push('');
const subjects = Object.keys(bySubject);
for (const sub of subjects) {
  md.push('---');
  md.push('');
  md.push('## ' + sub);
  md.push('');
  for (const it of items.filter(x => x.subject === sub)) {
    md.push(`### ${it.id}｜${it.difficulty}｜${it.type}｜${it.topic}`);
    md.push('');
    md.push('**题目：**');
    md.push('');
    md.push(String(it.stem).split('\n').map(l => l).join('\n'));
    if (it.options) {
      md.push('');
      for (const k of Object.keys(it.options)) md.push('- ' + k + '. ' + it.options[k]);
    }
    md.push('');
    md.push('**参考答案：** ' + (Array.isArray(it.answer) ? it.answer.join('；') : it.answer));
    md.push('');
    md.push('**解析：**');
    md.push('');
    md.push(String(it.solution).split('\n').join('\n'));
    md.push('');
    md.push('**引导提示（三级）：**');
    md.push('');
    md.push('1. ' + it.hint_ladder[0]);
    md.push('2. ' + it.hint_ladder[1]);
    md.push('3. ' + it.hint_ladder[2]);
    md.push('');
    md.push('**易错点：** ' + it.trap);
    md.push('');
    md.push(`<sub>知识点：${(it.knowledge || []).join('、')}｜建议 ${it.est_sec}s／${it.score} 分｜来源：${it.source_name}${it.source_url ? '｜' + it.source_url : ''}</sub>`);
    md.push('');
  }
}
fs.writeFileSync(DIR + 'question-bank-v2.md', md.join('\n'), 'utf8');
console.log('已写出 question-bank-v2.md（' + md.join('\n').length + ' 字符）');
