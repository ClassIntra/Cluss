// 记忆上下文工程的验证脚本
//
// 核心断言：**偏好类记忆必须常驻**，不能依赖关键词命中 ——
// 学生问「解这个方程」时那句话里不会出现"讲解风格"，
// 靠检索等于"个性化了"这件事从来没真正生效过。
// 反向对照：用完全无关的 query，偏好仍须在场。
'use strict';
var path = require('path');
var fs = require('fs');
var D = require('better-sqlite3');

var pass = 0, fail = 0, lines = [];
function ok(n, c, e) {
  if (c) { pass++; lines.push('  PASS  ' + n); }
  else { fail++; lines.push('  FAIL  ' + n + (e !== undefined ? '  | ' + e : '')); }
}
function section(t) { lines.push(''); lines.push('== ' + t + ' =='); }
function has(n, h) { return String(h).indexOf(n) !== -1; }

var DIR = path.resolve(__dirname, 'probe-mem');
var TMP = path.join(DIR, 'cluss.db');
var REAL = path.resolve(__dirname, '..', 'database', 'cluss.db');
var U = '990001';

(async function () {
  fs.mkdirSync(DIR, { recursive: true });
  try { fs.unlinkSync(TMP); } catch (e) {}
  var real = new D(REAL, { readonly: true, fileMustExist: true });
  await real.backup(TMP);
  real.close();

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'probe-jwt';
  process.env.DB_PATH = TMP;

  var memory = require('../src/services/memory');

  var seed = [
    ['偏好_讲解风格', '他喜欢先给结论再讲过程，不喜欢一上来就展开长篇推导。'],
    ['偏好_交流方式', '他不喜欢被反复追问，喜欢一次把话说清楚。'],
    ['习惯_作息', '他常在晚上 11 点后还在问问题。'],
    ['学业_薄弱科目', '物理是他的薄弱项，尤其怕受力分析。'],
    ['情绪_考试压力', '他期中数学考了 62 分，对成绩比较焦虑。'],
    ['学业_目标', '他想考进年级前 50 名。'],
    ['事实_家庭期望', '家里希望他学理科。'],
    ['兴趣_下棋', '他在学国际象棋。'],
    ['随手记的一条', '他养了一只叫豆豆的猫。']
  ];
  var db = require('D:/NetWork/Integration/Cluss/server/src/utils/db');
  db.prepare('DELETE FROM memories WHERE user_id = ?').run(U);
  seed.forEach(function (s) { memory.upsert(U, { key: s[0], content: s[1], source: 'auto' }); });

  // ---------- ① 分类 ----------
  section('① key → 类别');
  ok('偏好_讲解风格 → preference', memory.categoryOf('偏好_讲解风格') === 'preference');
  ok('习惯_作息 → preference（习惯也影响每轮回答）', memory.categoryOf('习惯_作息') === 'preference');
  ok('学业_薄弱科目 → academic', memory.categoryOf('学业_薄弱科目') === 'academic');
  ok('情绪_考试压力 → emotion', memory.categoryOf('情绪_考试压力') === 'emotion');
  ok('事实_家庭期望 → fact', memory.categoryOf('事实_家庭期望') === 'fact');
  ok('兴趣_下棋 → fact', memory.categoryOf('兴趣_下棋') === 'fact');
  ok('随手记的一条 → other', memory.categoryOf('随手记的一条') === 'other', memory.categoryOf('随手记的一条'));
  ok('空 key → other', memory.categoryOf('') === 'other');
  ok('null → other', memory.categoryOf(null) === 'other');
  // 写入端（memory-extractor 的 EXTRACT_SYSTEM）用的是这些词，必须认得
  ok('爱好_篮球 → preference', memory.categoryOf('爱好_篮球') === 'preference');
  ok('作息_晚睡 → preference', memory.categoryOf('作息_晚睡') === 'preference');
  ok('性格_内向 → preference', memory.categoryOf('性格_内向') === 'preference');
  ok('学习_薄弱科目 → academic（提取器示例写法）', memory.categoryOf('学习_薄弱科目') === 'academic');
  ok('考试_数学 → academic', memory.categoryOf('考试_数学') === 'academic');
  ok('人际_同学关系 → fact', memory.categoryOf('人际_同学关系') === 'fact');
  ok('无前缀的记忆走包含匹配兜底（不落 other）', memory.categoryOf('不喜欢物理') !== 'other',
    memory.categoryOf('不喜欢物理'));

  section('①b 写入端与读取端对齐（源码级）');
  var exSrc = fs.readFileSync('D:/NetWork/Integration/Cluss/server/src/services/memory-extractor.js', 'utf8');
  ok('提取器提示词规定了类别词表', has('类别只能从下面四个词里选一个', exSrc));
  ok('提取器提示词列出四个类别', has('偏好（', exSrc) && has('学习（', exSrc) && has('情绪（', exSrc) && has('事实（', exSrc));
  ok('提取器禁止自创类别词', has('不要自创类别词', exSrc));

  section('② 前缀剥离（避免注入时重复）');
  ok('偏好_讲解风格 → 讲解风格', memory.stripCategoryPrefix('偏好_讲解风格') === '讲解风格', memory.stripCategoryPrefix('偏好_讲解风格'));
  ok('无前缀的 key 原样保留', memory.stripCategoryPrefix('随手记的一条') === '随手记的一条');
  ok('连字符也认', memory.stripCategoryPrefix('学业-目标') === '目标');

  // ---------- ③ 核心：偏好常驻 ----------
  section('③ 偏好类常驻（不依赖关键词命中）');
  var unrelated = memory.selectForContext(U, '帮我解这个一元二次方程 x^2-5x+6=0');
  var keys = unrelated.map(function (m) { return m.key; });
  ok('无关提问仍带上了偏好类', keys.indexOf('偏好_讲解风格') !== -1, JSON.stringify(keys));
  ok('无关提问仍带上了交流偏好', keys.indexOf('偏好_交流方式') !== -1, JSON.stringify(keys));
  ok('常驻条数不超过上限 3', unrelated.filter(function (m) {
    return memory.ALWAYS_CATEGORIES.indexOf(memory.categoryOf(m.key)) >= 0;
  }).length <= 3);
  ok('总条数不超过 MAX_INJECT', unrelated.length <= memory.MAX_INJECT, unrelated.length);

  // 反向对照：拿一个绝无可能命中任何内容的 query，偏好依然要在
  var zzz = memory.selectForContext(U, 'zzzqqq 完全无关的占位词');
  ok('反向对照：纯乱码 query 也带偏好', zzz.some(function (m) { return m.key === '偏好_讲解风格'; }),
    JSON.stringify(zzz.map(function (m) { return m.key; })));

  // ---------- ④ 相关检索仍然工作 ----------
  section('④ 相关类按关键词命中');
  var phy = memory.selectForContext(U, '受力分析这类题我总是做不对');
  var pkeys = phy.map(function (m) { return m.key; });
  ok('问物理 → 命中「学业_薄弱科目」', pkeys.indexOf('学业_薄弱科目') !== -1, JSON.stringify(pkeys));
  ok('问物理 → 仍同时带着偏好', pkeys.indexOf('偏好_讲解风格') !== -1, JSON.stringify(pkeys));

  var emo = memory.selectForContext(U, '最近压力好大，睡不着');
  var ekeys = emo.map(function (m) { return m.key; });
  ok('聊压力 → 命中「情绪_考试压力」或作息', ekeys.indexOf('情绪_考试压力') !== -1 || ekeys.indexOf('习惯_作息') !== -1,
    JSON.stringify(ekeys));

  // ---------- ⑤ 去重与上限 ----------
  section('⑤ 去重与上限');
  var dedup = {};
  var dup = false;
  unrelated.forEach(function (m) { if (dedup[m.key]) dup = true; dedup[m.key] = 1; });
  ok('结果无重复 key', !dup);
  ok('偏好排在前面（顺序稳定，利于缓存）',
    memory.ALWAYS_CATEGORIES.indexOf(memory.categoryOf(unrelated[0] && unrelated[0].key)) >= 0,
    unrelated[0] && unrelated[0].key);

  var empty = memory.selectForContext(U, '');
  ok('空 query 走兜底且非空', empty.length > 0 && empty.length <= 3, empty.length);

  var none = memory.selectForContext('888888', '随便问问');
  ok('无记忆的用户返回空数组', Array.isArray(none) && none.length === 0);

  // ---------- ⑥ 注入文本 ----------
  section('⑥ 注入文本（分组 + 主动关联措辞）');
  var sec = memory.buildMemorySection(phy);
  ok('含标题', has('【关于这个学生的长期记忆】', sec));
  ok('多类时出现分组标签', has('偏好与习惯', sec) && has('学业情况', sec), sec.slice(0, 200));
  ok('去掉了 key 里的类别前缀', !has('偏好_', sec));
  ok('含「自然用上」的鼓励', has('自然用上', sec));
  ok('含「别生搬硬套」的反滥用', has('生搬硬套', sec));
  // 实测补丁（glm53f 真实采样）：学生说「随便聊聊」，回复把记忆里的考试压力
  // 硬套上去（「刚考完试的人这会儿是放松了还是有点闲得发慌？」）。
  // 所以这里不止禁用错，还要**禁主动用**：记忆调语气，不是拿来展示的。
  ok('含「闲聊时不要主动提记忆」的硬约束', has('不要主动提起记忆里的任何事', sec));
  ok('点明记忆是调语气用的、不是用来展示', has('不是用来向他证明你记得什么', sec));
  ok('带了那条真实反面例子', has('闲得发慌', sec));
  ok('含「以他现在的说法为准」的时效声明', has('他现在的说法', sec));
  ok('含「不要原样念给他听」', has('不要把这些记忆原样念给他听', sec));

  var onlyPref = memory.buildMemorySection(memory.listMemories(U, { limit: 20 }).filter(function (m) {
    return memory.categoryOf(m.key) === 'preference';
  }));
  ok('只有单一类别时不出现分组标签', !has('偏好与习惯：', onlyPref), onlyPref);

  ok('空记忆返回空串', memory.buildMemorySection([]) === '');

  console.log(lines.join('\n'));
  console.log('');
  console.log('RESULT: PASS ' + pass + ' / FAIL ' + fail + ' (共 ' + (pass + fail) + ' 项)');
  try {
    fs.unlinkSync(TMP); fs.unlinkSync(TMP + '-wal'); fs.unlinkSync(TMP + '-shm');
  } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('探针自身异常:', e && e.stack || e);
  process.exit(2);
});
