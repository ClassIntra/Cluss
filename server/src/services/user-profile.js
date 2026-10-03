// 学生画像
//
// 为什么需要：模型每轮都从零开始看这个学生 —— 不知道他几年级、哪科弱、
// 上次问到哪。结果就是每轮都按"面对一个陌生高中生"的平均水平讲：
// 讲深了听不懂、讲浅了嫌啰嗦，同一类错反复犯也从没人提醒。
//
// 数据来源全部是已有的库表，不额外维护一份"档案"：
//   - users.user_id（学号 YYNNCC）→ 入学年份与班级
//   - wrong_questions            → 薄弱学科与常错类型
//   - ai_conversations           → 最近在学什么
//
// 不额外建表是刻意的：任何需要单独维护的档案都会和实际使用脱节，
// 而从行为数据推导出来的永远是当前的 —— 学生刚错完一道题，
// 下一轮画像里就应该有它。
//
// 另一个刻意的选择：画像**只做统计，不做评价**。
// 不写"该生数学较差"这种结论，只给"数学 5 道待复习、常错类型是…"，
// 把判断留给模型，避免系统替学生贴标签。

var db = require('../utils/db');

// 缓存窗口：一轮对话里短期缓存即可，太长会让学生刚错的题迟迟进不了画像
var CACHE_TTL_MS = 60 * 1000;
var cache = {};

// 学号 YYNNCC 解析
//   YY = 入学年份后两位，NN = 班级号，CC = 班内注册编号
//   800001+ 是编号用尽后的保留段 —— 此时前两位不再表示入学年份，不能反推
function parseStudentNo(userId) {
  var id = String(userId || '').trim();
  if (!/^\d{6}$/.test(id)) return null;
  if (Number(id) >= 800001) return null;

  var yy = parseInt(id.slice(0, 2), 10);
  var classNo = parseInt(id.slice(2, 4), 10);
  if (!isFinite(yy) || !isFinite(classNo) || classNo <= 0) return null;

  var enrollYear = 2000 + yy;
  var now = new Date();
  // 学年从 9 月开始：9 月之后算新学年
  var schoolYearStart = (now.getMonth() + 1) >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  var gradeIndex = schoolYearStart - enrollYear + 1;

  // 超出合理范围说明这不是学号（管理员号之类），别硬推
  if (gradeIndex < 1 || gradeIndex > 12) return null;

  return { enrollYear: enrollYear, classNo: classNo, gradeIndex: gradeIndex };
}

// 薄弱学科：只统计**未掌握**的错题 —— 已掌握的说明问题解决了，不该再影响讲解
function loadWeakSubjects(userId) {
  var rows = db.prepare([
    'SELECT subject, COUNT(*) AS c FROM wrong_questions',
    'WHERE user_id = ? AND mastered = 0 AND subject != \'\'',
    'GROUP BY subject ORDER BY c DESC, subject ASC LIMIT 5'
  ].join('\n')).all(userId);

  return rows.map(function(r) {
    return { subject: r.subject, count: r.c };
  });
}

// 常错类型：取最近未掌握错题的错因，去重后留前 3 条
// 错因是模型自己写的，长短与措辞都不统一，所以只做截断与去重，不做语义归并
function loadCommonReasons(userId) {
  var rows = db.prepare([
    'SELECT reason FROM wrong_questions',
    'WHERE user_id = ? AND mastered = 0 AND reason != \'\'',
    'ORDER BY id DESC LIMIT 12'
  ].join('\n')).all(userId);

  var seen = {};
  var out = [];
  for (var i = 0; i < rows.length && out.length < 3; i++) {
    var t = String(rows[i].reason || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    // 同一类错因措辞可能只差几个字，用前 12 个字做粗略去重
    var key = t.slice(0, 12);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(t.length > 30 ? t.slice(0, 30) + '…' : t);
  }
  return out;
}

// 最近在问什么：会话标题就是学生自己那句提问的前 20 字，足够说明主题
function loadRecentTopics(userId) {
  var rows = db.prepare([
    'SELECT title FROM ai_conversations WHERE user_id = ?',
    'ORDER BY updated_at DESC LIMIT 10'
  ].join('\n')).all(userId);

  var seen = {};
  var out = [];
  for (var i = 0; i < rows.length && out.length < 4; i++) {
    var t = String(rows[i].title || '').trim();
    if (!t || t === '新对话' || seen[t]) continue;
    seen[t] = true;
    out.push(t);
  }
  return out;
}

// opts: { force?: boolean }
function buildProfile(userId, opts) {
  var uid = String(userId || '');
  if (!uid) return null;

  var o = opts || {};
  var now = Date.now();
  if (!o.force && cache[uid] && (now - cache[uid].at) < CACHE_TTL_MS) {
    return cache[uid].profile;
  }

  var profile = null;
  try {
    var user = db.prepare(
      'SELECT user_id, real_name, class_no, gender, is_admin FROM users WHERE user_id = ?'
    ).get(uid);

    // 管理员不是学生，不给他画像（他也不会用这个号做题）
    if (!user || Number(user.is_admin) === 1) {
      cache[uid] = { at: now, profile: null };
      return null;
    }

    var parsed = parseStudentNo(user.user_id);
    var weakSubjects = loadWeakSubjects(uid);
    var commonReasons = loadCommonReasons(uid);
    var recentTopics = loadRecentTopics(uid);

    // 什么都没有的新生不注入：空画像只会白白占 token
    if (!parsed && !weakSubjects.length && !recentTopics.length) {
      cache[uid] = { at: now, profile: null };
      return null;
    }

    profile = {
      // 班级号优先用 users.class_no（注册时记录的），学号解析结果作兜底
      enrollYear: parsed ? parsed.enrollYear : 0,
      classNo: Number(user.class_no) || (parsed ? parsed.classNo : 0),
      gender: String(user.gender || '') === '男' || String(user.gender || '') === '女'
        ? user.gender : '',
      weakSubjects: weakSubjects,
      commonReasons: commonReasons,
      recentTopics: recentTopics
    };
  } catch (e) {
    // 画像拿不到是完全可接受的降级 —— 不该因为统计查询失败让整轮对话失败
    console.warn('[Profile] 画像构建失败（不影响对话）:', e.message);
    return null;
  }

  cache[uid] = { at: now, profile: profile };
  return profile;
}

// 学生数据变化后清掉缓存，下一轮立刻看到新画像
// 时机：错题入库后、会话标题更新后
function invalidate(userId) {
  if (!userId) return;
  delete cache[String(userId)];
}

module.exports = {
  buildProfile: buildProfile,
  invalidate: invalidate,
  parseStudentNo: parseStudentNo
};
