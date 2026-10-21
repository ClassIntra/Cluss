// 好感度（默契度）服务
//
// 它回答的问题：**这个 AI 和我熟不熟**。
// 不是积分（那是花掉的额度）、不是排行榜（校园里比分数是负向的），
// 而是随真实使用深度增长的亲密度。学生自己看得到，别人看不到。
//
// 规则（2026-10-20 定稿）：
//   daily   每日请教 +2   当天第一次完成一次对话回合
//   streak  坚持不懈 +1~2 连续活跃 ≥3 天 +1，≥7 天起 +2
//   memory  被记住   +3   AI 新写入一条长期记忆（学生"被记住"的直接感知）
//   feature 新大陆   +2   第一次用某个功能区（每个功能一生一次）
//   每日合计封顶 8 分：等级要靠日子堆，不能靠一天狂刷堆出来。
//
// 为什么只加不减：学生几天不来就扣分，只会让"好久没来"更不敢来。
//
// 防刷三道：
//   ① 每个 reason 每天最多加一次（daily_marks 记账）；
//   ② 探索按功能一次性（explored 数组）；
//   ③ 每日总封顶 8 分（SUM(marks) + delta <= DAILY_CAP）。
//
// 与记忆系统的耦合只有一处（noteNewMemory 被 extractor 调），
// 这里**不主动读记忆** —— 单向依赖，记忆坏了不连带好感度坏。

var db = require('../utils/db');
var time = require('../utils/time');
var NL = String.fromCharCode(10);

// 等级表：总分下限 → 称号。升序。
var LEVELS = [
  { points: 0, title: '初识' },
  { points: 24, title: '熟识' },
  { points: 72, title: '伙伴' },
  { points: 144, title: '搭档' },
  { points: 240, title: '知音' },
  { points: 360, title: '默契' },
  { points: 520, title: '灵魂搭档' }
];

var DAILY_CAP = 8;
// 功能区清单：与学生实际能走到的页面一一对应，写死以免前端乱传
var FEATURES = ['chat', 'study', 'writing', 'notes', 'draw', 'wrongbook', 'cloud', 'campus'];

// ------------------------------------------------------------
// 基础读写
// ------------------------------------------------------------
function getRow(userId) {
  var uid = String(userId || '');
  if (!uid) return null;
  var row = db.prepare('SELECT * FROM cluss_affinity WHERE user_id = ?').get(uid);
  return row || null;
}

function ensureRow(userId) {
  var uid = String(userId || '');
  if (!uid) return null;
  var row = getRow(uid);
  if (row) return row;
  var now = time.nowUtc();
  db.prepare([
    'INSERT OR IGNORE INTO cluss_affinity (user_id, points, streak_days, last_active_date, explored, daily_marks, created_at, updated_at)',
    "VALUES (?, 0, 0, '', '', '', ?, ?)"
  ].join(NL)).run(uid, now, now);
  return getRow(uid);
}

function parseMarks(raw) {
  try {
    var o = JSON.parse(String(raw || ''));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) { return {}; }
}

function parseList(raw) {
  try {
    var o = JSON.parse(String(raw || ''));
    return Array.isArray(o) ? o : [];
  } catch (e) { return []; }
}

function todayMarks(row) {
  var all = parseMarks(row.daily_marks);
  var today = time.localDay();
  // 只保留今天的；跨天遗留直接丢（新一轮从零计封顶）
  var out = all[today];
  return (out && typeof out === 'object') ? out : {};
}

function sumMarks(marks) {
  var s = 0;
  for (var k in marks) {
    if (Object.prototype.hasOwnProperty.call(marks, k)) s += Number(marks[k]) || 0;
  }
  return s;
}

// ------------------------------------------------------------
// 加分（内部）：带每日记账与封顶。返回实际加减（0 = 被规则挡下）
// ------------------------------------------------------------
function grant(userId, reason, delta) {
  var uid = String(userId || '');
  if (!uid || !(delta > 0)) return 0;
  var row = ensureRow(uid);
  if (!row) return 0;

  var today = time.localDay();
  // 整理 daily_marks：只留今天
  var marks = {};
  var all = parseMarks(row.daily_marks);
  all[today] = todayMarks(row);
  marks = all[today];

  // 每个 reason 每天只加一次；每日合计不超 DAILY_CAP
  if (Object.prototype.hasOwnProperty.call(marks, reason)) return 0;
  if (sumMarks(marks) + delta > DAILY_CAP) return 0;

  marks[reason] = delta;
  all[today] = marks;

  var now = time.nowUtc();
  // 注意：streak_days 只由 touchDaily 维护，这里**绝不能顺手回写** ——
  // grant 拿到的 row 是加本笔分之前的快照，回写会把刚刚续上的连招天数覆盖回旧值。
  db.prepare([
    'UPDATE cluss_affinity SET',
    '  points = points + ?,',
    "  last_active_date = ?,",
    '  daily_marks = ?,',
    "  updated_at = ?",
    'WHERE user_id = ?'
  ].join(NL)).run(delta, today, JSON.stringify(all), now, uid);

  db.prepare([
    'INSERT INTO cluss_affinity_log (user_id, delta, reason, created_at) VALUES (?, ?, ?, ?)'
  ].join(NL)).run(uid, delta, reason, now);
  return delta;
}

// ------------------------------------------------------------
// 对外：每次对话回合结束后调（发射后不管，绝不抛给调用方）
// ------------------------------------------------------------
function touchDaily(userId) {
  try {
    var row = ensureRow(userId);
    if (!row) return { changed: false };

    var today = time.localDay();
    var last = String(row.last_active_date || '');
    if (last === today) return { changed: false }; // 今天已活跃过，连招奖励照旧按天算

    // 连续天数：差 1 天续上，否则从 1 重新数。
    // ⚠️ localDayDiff(a, b) 返回的是 **b - a** 的天数，所以这里要传 (last, today)：
    //    昨天 → 今天 = +1。传反了会恒等于 -1，连招永远续不上（且没有任何报错）。
    var diff = last ? time.localDayDiff(last, today) : 0;
    var streak = (last && diff === 1) ? (Number(row.streak_days) || 0) + 1 : 1;

    db.prepare([
      'UPDATE cluss_affinity SET',
      '  streak_days = ?,',
      "  last_active_date = ?,",
      "  updated_at = ?",
      'WHERE user_id = ?'
    ].join(NL)).run(streak, today, time.nowUtc(), String(userId));

    var got = grant(userId, 'daily', 2);
    if (got && streak >= 7) grant(userId, 'streak', 2);
    else if (got && streak >= 3) grant(userId, 'streak', 1);

    return { changed: true, streak: streak, points: got };
  } catch (e) {
    // 好感度是增强项：任何失败都不能影响对话本身
    console.warn('[Affinity] touchDaily 失败（已忽略）：' + e.message);
    return { changed: false };
  }
}

// ------------------------------------------------------------
// 对外：AI 新写入一条记忆时调（memory-extractor 专用）
// ------------------------------------------------------------
function noteNewMemory(userId) {
  try {
    ensureRow(userId);
    return grant(userId, 'memory', 3);
  } catch (e) {
    console.warn('[Affinity] noteNewMemory 失败（已忽略）：' + e.message);
    return 0;
  }
}

// ------------------------------------------------------------
// 对外：探索了一个新功能区（幂等，每功能一生一次）
// ------------------------------------------------------------
function featureExplored(userId, feature) {
  try {
    var f = FEATURES.indexOf(String(feature || '')) >= 0 ? String(feature) : '';
    if (!f) return { explored: false, points: 0 };
    var row = ensureRow(userId);
    if (!row) return { explored: false, points: 0 };
    var done = parseList(row.explored);
    if (done.indexOf(f) >= 0) return { explored: false, points: 0 };
    done.push(f);
    db.prepare([
      'UPDATE cluss_affinity SET explored = ?, updated_at = ? WHERE user_id = ?'
    ].join(NL)).run(JSON.stringify(done), time.nowUtc(), String(userId));
    var got = grant(userId, 'feature', 2);
    return { explored: got > 0, points: got };
  } catch (e) {
    console.warn('[Affinity] featureExplored 失败（已忽略）：' + e.message);
    return { explored: false, points: 0 };
  }
}

// ------------------------------------------------------------
// 等级与视图
// ------------------------------------------------------------
function levelOf(points) {
  var p = Math.max(0, Number(points) || 0);
  var idx = 0;
  for (var i = 0; i < LEVELS.length; i++) {
    if (p >= LEVELS[i].points) idx = i;
  }
  return idx;
}

// 学生可见的状态。progress 是「当前级内进度」，满级时为 1。
function getState(userId) {
  var uid = String(userId || '');
  var empty = {
    points: 0, level: 0, title: LEVELS[0].title,
    levelPoints: LEVELS[0].points, nextPoints: LEVELS[1].points, nextTitle: LEVELS[1].title,
    progress: 0, streakDays: 0, explored: [], dailyCap: DAILY_CAP, everyNTurns: 4
  };
  var row = uid ? getRow(uid) : null;
  if (!row) return empty;

  var idx = levelOf(row.points);
  var cur = LEVELS[idx];
  var nxt = LEVELS[idx + 1] || null;
  var progress = 1;
  if (nxt) {
    var span = nxt.points - cur.points;
    progress = span > 0 ? Math.min(1, Math.max(0, ((row.points - cur.points) / span))) : 0;
  }
  return {
    points: row.points,
    level: idx + 1,
    title: cur.title,
    levelPoints: cur.points,
    nextPoints: nxt ? nxt.points : null,
    nextTitle: nxt ? nxt.title : null,
    progress: progress,
    streakDays: row.streak_days,
    explored: parseList(row.explored),
    dailyCap: DAILY_CAP,
    everyNTurns: 4
  };
}

// 高等级增益：记忆检索条数随默契度放宽
//   Lv1-2: 8 条（默认）   Lv3-4: 10 条   Lv5+: 14 条
// 语义上也说得通：越熟，AI 越"记得你的事"。
function injectLimit(userId) {
  var idx = levelOf(getState(userId).points);
  if (idx >= 4) return 14;   // 知音及以上
  if (idx >= 2) return 10;   // 伙伴及以上
  return 8;
}

module.exports = {
  LEVELS: LEVELS,
  DAILY_CAP: DAILY_CAP,
  FEATURES: FEATURES,
  touchDaily: touchDaily,
  noteNewMemory: noteNewMemory,
  featureExplored: featureExplored,
  getState: getState,
  injectLimit: injectLimit,
  _internal: {
    grant: grant,
    levelOf: levelOf
  }
};
