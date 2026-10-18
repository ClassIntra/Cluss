// 错题本服务
//
// 两个职责：
//   1. 从批改回复里提取结构化错题（extractAndStrip）
//   2. 错题本的增删改查
//
// ---- 提取的设计要点 ----
// 模型被要求在批改结果末尾额外输出一段 <wrong-items>JSON</wrong-items>。
// 我们要做两件事：把 JSON 存下来、把这段从正文里去掉。
//
// 为什么不直接解析 Markdown 表格：模型表格格式一变就抓不到，
// 而且流式过程中表格是半截的（最后一行还没到）。

var db = require('../utils/db');
var time = require('../utils/time');
var prompts = require('./prompt-registry');

// ------------------------------------------------------------
// 复习排期（间隔重复）
//
// 用固定阶梯，不上 SM-2 那类自适应算法：在中学错题场景里，
// **可解释比最优更重要**。学生能看懂「3 天后再练」并预期它；
// 算法复杂到说不清来由，学生只会觉得这系统在乱排，进而不信任整个功能。
//
// stage 语义 = 已连续答对的次数，同时就是查表下标：
//   stage 0 → 明天再练（刚入库，或刚答错被打回重来）
//   stage 1 → 3 天后     stage 2 → 7 天后
//   stage 3 → 15 天后    stage 4 → 30 天后
//   stage 5 → 走完阶梯，不再排期（等学生自己确认掌握）
var LADDER = [1, 3, 7, 15, 30];

// 从「今天」往后排下一次复习
function nextOnFromToday(stage) {
  if (stage >= LADDER.length) return '';
  return time.localDay(LADDER[stage]);
}

// 这道题现在是否到复习的时候
//
// 除「日期已到」之外还认一种情况：**从没排过期、也没复习过的未掌握题**。
// 这是给自己留的安全网——万一哪条写入路径忘了排期（新增来源、脚本导入），
// 那些题会永远不进复习队列，静默丢失。把它们视为「现在就该看」，
// 系统就能自我修复，而不是等学生发现"这题怎么从来不出现在复习里"。
function isDue(row, today) {
  if (row.mastered === 1) return false;
  var on = String(row.next_review_on || '');
  if (!on) return !(Number(row.review_stage) > 0);
  return on <= today;
}

// 给前端一句人话，避免各页各写一套日期文案
function reviewHint(row, today) {
  if (row.mastered === 1) return '';
  var on = String(row.next_review_on || '');
  if (!on) {
    return Number(row.review_stage) >= LADDER.length ? '已走完复习阶梯' : '待安排';
  }
  var diff = time.localDayDiff(today, on);
  if (diff <= 0) return '今天';
  if (diff === 1) return '明天';
  return diff + ' 天后';
}

// 转义正则元字符（标记里没有特殊字符，但保持通用写法更稳）
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

var BLOCK_RE = new RegExp(
  escapeRe(prompts.WRONG_ITEMS_OPEN) + '([\\s\\S]*?)' + escapeRe(prompts.WRONG_ITEMS_CLOSE)
);

// 容错解析 JSON
// 模型偶尔会给出不够规范的 JSON（末尾多逗号、用单引号、外面包一层说明文字）。
// 错题本拿不到内容是可以接受的降级，但绝不能因此让批改失败。
function parseLoose(jsonText) {
  var t = String(jsonText || '').trim();
  if (!t) return [];

  // 去掉可能存在的代码块围栏
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    var parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // 退一步：截取第一个 [ 到最后一个 ] 之间的内容再试
    var start = t.indexOf('[');
    var end = t.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try {
        var arr = JSON.parse(t.slice(start, end + 1));
        return Array.isArray(arr) ? arr : [];
      } catch (e2) {
        console.warn('[WrongBook] 错题 JSON 解析失败，已跳过:', e2.message);
        return [];
      }
    }
    console.warn('[WrongBook] 未找到错题数组，已跳过');
    return [];
  }
}

// 从模型完整回复里提取错题，并返回剥离后的正文
// 返回 { text, items }
function extractAndStrip(rawText) {
  var text = String(rawText || '');
  var m = text.match(BLOCK_RE);

  if (!m) {
    return { text: text, items: [], found: false };
  }

  var items = parseLoose(m[1]);

  // 剥离：整块连同前面多余的空行一起去掉，避免正文末尾留一片空白
  var stripped = (text.slice(0, m.index) + text.slice(m.index + m[0].length))
    .replace(/\n{3,}$/g, '\n')
    .trimEnd();

  return { text: stripped, items: items, found: true };
}

// 归一化一条错题（模型输出不可全信，逐字段兜底）
function normalizeItem(raw) {
  var r = raw || {};
  function s(v) {
    return String(v === undefined || v === null ? '' : v).trim();
  }
  var tag = s(r.tag);
  if (tag !== '✗' && tag !== '△') tag = '✗';

  return {
    subject: s(r.subject).slice(0, 20),
    question: s(r.question).slice(0, 2000),
    student_answer: s(r.student_answer).slice(0, 1000),
    correct_answer: s(r.correct_answer).slice(0, 2000),
    reason: s(r.reason).slice(0, 1000),
    tag: tag
  };
}

// 批量写入（批改提取用）
// ctx: { userId, conversationId, imageHash }
function saveExtracted(items, ctx) {
  var list = [];
  for (var i = 0; i < items.length; i++) {
    var n = normalizeItem(items[i]);
    // 题干为空说明这条数据没有价值，丢掉
    if (!n.question) continue;
    list.push(n);
  }
  if (!list.length) return 0;

  var now = time.nowUtc();
  // 新收进来的错题按 stage 0 排期（明天再练）：
  // 批改刚结束，学生已经看过正确答案，此刻"复习"只是重复阅读；
  // 隔一天再回忆一次才是有效的第一次练习。
  var firstReviewOn = nextOnFromToday(0);
  var stmt = db.prepare([
    'INSERT INTO wrong_questions (user_id, conversation_id, image_hash, source, subject,',
    '  question, student_answer, correct_answer, reason, tag, mastered, note, created_at, updated_at,',
    '  review_stage, next_review_on, last_reviewed_on, review_count)',
    'VALUES (?, ?, ?, \'ai\', ?, ?, ?, ?, ?, ?, 0, \'\', ?, ?, 0, ?, \'\', 0)'
  ].join('\n'));

  var tx = db.transaction(function() {
    for (var j = 0; j < list.length; j++) {
      var it = list[j];
      stmt.run(
        String(ctx.userId),
        String(ctx.conversationId || ''),
        String(ctx.imageHash || ''),
        it.subject, it.question, it.student_answer,
        it.correct_answer, it.reason, it.tag,
        now, now, firstReviewOn
      );
    }
  });
  tx();

  return list.length;
}

// ---- 查询 ----

// examMap：临考科目表（subject → { days_left, exam_title }），来自 CI 的学业倒计时。
// 只是给前端一个"为什么这道题排前面"的交代，不参与任何判定。
function serialize(row, examMap) {
  var boost = (examMap && row.subject) ? examMap[row.subject] : null;
  return {
    id: row.id,
    subject: row.subject || '',
    // 这道题所属的科目快要考试了（null = 没有 / 该生关掉了这个功能）
    exam_boost: boost ? { days_left: boost.days_left, exam_title: boost.exam_title } : null,
    question: row.question,
    student_answer: row.student_answer || '',
    correct_answer: row.correct_answer || '',
    reason: row.reason || '',
    tag: row.tag || '✗',
    mastered: row.mastered === 1,
    note: row.note || '',
    source: row.source || 'ai',
    conversation_id: row.conversation_id || '',
    image_hash: row.image_hash || '',
    image_url: row.image_hash ? ('/api/cloud/files/' + row.image_hash + '?thumb=1') : '',
    // ---- 复习排期 ----
    review_stage: Number(row.review_stage) || 0,
    review_count: Number(row.review_count) || 0,
    next_review_on: row.next_review_on || '',
    last_reviewed_on: row.last_reviewed_on || '',
    // due 与 review_hint 都在服务端算好：列表、角标、复习卡片三处若各写一套
    // 日期判断与文案，迟早会互相矛盾（"这里说今天到期、那里说 3 天后"）
    due: isDue(row, time.localDay()),
    review_hint: reviewHint(row, time.localDay()),
    created_at: time.toISO(row.created_at),
    updated_at: time.toISO(row.updated_at)
  };
}

// 错题本的四类计数（收口成一处）
//
// 为什么要收口：角标、筛选标签、页面复习卡片、列表本身都依赖这几个数。
// 之前每处各写一条 SQL 的写法，迟早出现「角标说 3 道、点进去只有 2 道」——
// 这种偏差最伤信任，因为学生无法判断该信哪个。
function countsOf(userId) {
  var today = time.localDay();
  var row = db.prepare([
    'SELECT SUM(CASE WHEN mastered = 0 THEN 1 ELSE 0 END) AS pending,',
    '       SUM(CASE WHEN mastered = 1 THEN 1 ELSE 0 END) AS done,',
    '       SUM(CASE WHEN mastered = 0 AND ((next_review_on != \'\' AND next_review_on <= ?)',
    '                 OR (next_review_on = \'\' AND review_stage = 0)) THEN 1 ELSE 0 END) AS due,',
    '       SUM(CASE WHEN mastered = 0 AND next_review_on = \'\' AND review_stage >= ?',
    '                THEN 1 ELSE 0 END) AS graduated,',
    '       COUNT(*) AS total',
    'FROM wrong_questions WHERE user_id = ?'
  ].join('\n')).get(today, LADDER.length, String(userId));

  return {
    pending: (row && row.pending) || 0,
    mastered: (row && row.done) || 0,
    // due       = 今天该复习的
    // graduated = 已走完复习阶梯、等他确认掌握的（不催，只提示）
    due: (row && row.due) || 0,
    graduated: (row && row.graduated) || 0,
    total: (row && row.total) || 0
  };
}

// 轻量概览：导航角标只想知道「今天有几道」，
// 不该为了一个数字去拉整页列表（错题多的时候那是几十条 JOIN 与 Markdown 文本）
function overview(userId) {
  var c = countsOf(userId);
  return {
    due: c.due,
    graduated: c.graduated,
    pending: c.pending,
    mastered: c.mastered,
    total: c.total,
    today: time.localDay()
  };
}

// 临考科目 → 排序权重表。返回 { map, pairs }：
//   map   : subject → { days_left, exam_title }（给前端标注用）
//   pairs : [[subject, weight], ...]（给 SQL CASE 用，已按天数升序）
//
// 拿不到就返回 null，调用方保持原有排序 —— CI 不可用 / 没考试 / 对不上科目
// 都必须**静默回退**，绝不能让"复习队列打不开"。
function examWeights(userId) {
  try {
    var campusContext = require('./campus-context');
    var list = campusContext.urgentSubjects(userId);
    if (!list || !list.length) return null;

    var map = {};
    var pairs = [];
    list.forEach(function(x, i) {
      if (!x || !x.subject || map[x.subject]) return;
      map[x.subject] = { days_left: x.days_left, exam_title: x.exam_title };
      pairs.push([String(x.subject), i]);
    });
    return pairs.length ? { map: map, pairs: pairs } : null;
  } catch (e) {
    // 校园情境不可用（表未迁移 / CI 未联动 / 缓存空）都不该影响错题本
    return null;
  }
}

// opts: { userId, mastered: ''|'0'|'1', subject, due: '1', page, limit, examFirst? }
function list(opts) {
  var o = opts || {};
  var page = Math.max(1, parseInt(o.page, 10) || 1);
  var limit = Math.min(Math.max(1, parseInt(o.limit, 10) || 20), 100);
  var today = time.localDay();

  var where = ['user_id = ?'];
  var params = [String(o.userId)];

  if (o.mastered === '0' || o.mastered === '1') {
    where.push('mastered = ?');
    params.push(Number(o.mastered));
  }
  if (o.subject) {
    where.push('subject = ?');
    params.push(String(o.subject));
  }

  // 只看今天该复习的。第二项「从没排过期」是安全网（见 isDue 的说明），
  // 两条 SQL 与两条 JS 判定必须完全一致，否则会出现
  // 「角标说有 3 道、点进去只有 2 道」这种最伤信任的偏差。
  var dueCondition = [
    'mastered = 0',
    "AND ((next_review_on != '' AND next_review_on <= ?)",
    "     OR (next_review_on = '' AND review_stage = 0))"
  ].join('\n');
  if (o.due === '1') {
    where.push('(' + dueCondition + ')');
    params.push(today);
  }

  var whereSql = where.join(' AND ');

  var countStmt = db.prepare('SELECT COUNT(*) AS c FROM wrong_questions WHERE ' + whereSql);
  var total = (countStmt.get.apply(countStmt, params) || {}).c || 0;

  // ---- 排序 ----
  //
  // 复习队列默认按「该复习的先后」排：日期早的（拖得久的）排前面。
  // 其余场景保持「最新收录在前」——那时学生找的是"我刚做错的那道"。
  //
  // ---- 临考优先（2026-10-12 加；两个系统真正的协同点）----
  // 只在复习队列（due=1）里生效：明天考数学，队列却按排期日期机械推进、
  // 把一堆英语错题排在数学前面 —— 这正是学生最需要它靠谱的时刻。
  //
  // 刻意做成**排序权重**而不是改判定：
  //   · 不改 due：间隔重复阶梯照走，不会因为临考就把还没到期的题硬塞进来
  //     （那是把"复习节奏"和"复习顺序"两件事混为一谈）；
  //   · 不改数据：不写库、不排期，CI 一断就自动恢复原有顺序。
  //
  // 权重进 SQL 而不是拉回来再排：分页必须全表一致，
  // 否则第 2 页会重复出现第 1 页的题（"我明明刚看过"）。
  //
  // 临考信息**两种模式都算**：学生一进错题本就该看到"数学快考试了"，
  // 而不是等他点进复习才知道 —— 那时他已经做完了决策。
  // 排序权重只在复习队列里生效（见下）。
  var weights = o.examFirst !== false ? examWeights(o.userId) : null;

  var caseSql = '';
  var orderParams = [];
  if (weights && o.due === '1') {
    // 科目值一律走参数绑定（即便它来自本库，也不手拼字符串）
    caseSql = '(CASE subject ' +
      weights.pairs.map(function() { return 'WHEN ? THEN ?'; }).join(' ') +
      ' ELSE 999 END), ';
    weights.pairs.forEach(function(p) {
      orderParams.push(p[0]);   // 科目
      orderParams.push(p[1]);   // 权重（剩余天数升序 → 越近越靠前）
    });
  }

  var orderSql = o.due === '1'
    ? ('ORDER BY ' + caseSql + 'next_review_on ASC, id ASC')
    : 'ORDER BY id DESC';

  var listStmt = db.prepare(
    'SELECT * FROM wrong_questions WHERE ' + whereSql + ' ' + orderSql + ' LIMIT ? OFFSET ?'
  );
  var rows = listStmt.all.apply(
    listStmt, params.concat(orderParams, [limit, (page - 1) * limit])
  );

  // 计数统一从 countsOf 取，保证与角标、复习卡片完全同源
  return {
    page: page,
    limit: limit,
    total: total,
    total_pages: Math.ceil(total / limit),
    counts: countsOf(o.userId),
    // 前端要解释"为什么这道题排在最前面"，所以把临考信息一并给出去
    exam_first: weights
      ? weights.pairs.map(function(p) {
          return { subject: p[0], days_left: weights.map[p[0]].days_left, exam_title: weights.map[p[0]].exam_title };
        })
      : [],
    items: rows.map(function(r) { return serialize(r, weights ? weights.map : null); })
  };
}

// 取单条（限本人）
function getOne(id, userId) {
  var row = db.prepare('SELECT * FROM wrong_questions WHERE id = ? AND user_id = ?')
    .get(Number(id), String(userId));
  return row ? serialize(row) : null;
}

// 手动新增
function create(userId, body) {
  var b = body || {};
  var question = String(b.question || '').trim();
  if (!question) return { ok: false, message: '题干不能为空' };

  var n = normalizeItem(b);
  var now = time.nowUtc();

  // 手动录入的题同样进入复习队列；已掌握的直接不排期
  var masteredFlag = b.mastered ? 1 : 0;
  var firstReviewOn = masteredFlag ? '' : nextOnFromToday(0);

  var info = db.prepare([
    'INSERT INTO wrong_questions (user_id, conversation_id, image_hash, source, subject,',
    '  question, student_answer, correct_answer, reason, tag, mastered, note, created_at, updated_at,',
    '  review_stage, next_review_on, last_reviewed_on, review_count)',
    'VALUES (?, \'\', ?, \'manual\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, \'\', 0)'
  ].join('\n')).run(
    String(userId),
    String(b.image_hash || ''),
    n.subject, question, n.student_answer, n.correct_answer, n.reason, n.tag,
    masteredFlag,
    String(b.note || '').slice(0, 2000),
    now, now, firstReviewOn
  );

  return { ok: true, item: getOne(info.lastInsertRowid, userId) };
}

// 编辑（部分字段）
function update(id, userId, body) {
  var existing = db.prepare('SELECT * FROM wrong_questions WHERE id = ? AND user_id = ?')
    .get(Number(id), String(userId));
  if (!existing) return { ok: false, notFound: true, message: '错题不存在' };

  var b = body || {};
  var sets = [];
  var params = [];

  var textFields = [
    ['question', 2000], ['student_answer', 1000],
    ['correct_answer', 2000], ['reason', 1000], ['note', 2000], ['subject', 20]
  ];
  for (var i = 0; i < textFields.length; i++) {
    var key = textFields[i][0];
    if (b[key] !== undefined) {
      var v = String(b[key] || '').trim().slice(0, textFields[i][1]);
      if (key === 'question' && !v) {
        return { ok: false, message: '题干不能为空' };
      }
      sets.push(key + ' = ?');
      params.push(v);
    }
  }

  if (b.tag !== undefined) {
    var tag = String(b.tag);
    if (tag !== '✗' && tag !== '△') tag = '✗';
    sets.push('tag = ?');
    params.push(tag);
  }
  if (b.mastered !== undefined) {
    var wantMastered = b.mastered ? 1 : 0;
    sets.push('mastered = ?');
    params.push(wantMastered);
    // 掌握状态变了，排期必须跟着变，否则两边自相矛盾：
    //   标为已掌握却还留着到期日 → 复习队列里又冒出来
    //   标回待复习却没有排期     → 它永远不进复习队列（靠 isDue 的安全网兜底，但那是兜底）
    if (wantMastered === 1) {
      sets.push('next_review_on = ?');
      params.push('');
    } else {
      sets.push('review_stage = ?', 'next_review_on = ?');
      params.push(0, nextOnFromToday(0));
    }
  }

  if (!sets.length) return { ok: false, message: '没有要修改的内容' };

  sets.push('updated_at = ?');
  params.push(time.nowUtc());
  params.push(Number(id));
  params.push(String(userId));

  var stmt = db.prepare('UPDATE wrong_questions SET ' + sets.join(', ') + ' WHERE id = ? AND user_id = ?');
  stmt.run.apply(stmt, params);

  return { ok: true, item: getOne(id, userId) };
}

function remove(id, userId) {
  var info = db.prepare('DELETE FROM wrong_questions WHERE id = ? AND user_id = ?')
    .run(Number(id), String(userId));
  return info.changes > 0;
}

// 批量操作：master / unmaster / delete
// 逐条限定 user_id：绝不接受「按 id 列表批量改」，否则可以拿别人的 id 越权
function batch(userId, ids, action) {
  var list = (Array.isArray(ids) ? ids : []).map(function(x) { return Number(x); })
    .filter(function(x) { return isFinite(x) && x > 0; });
  if (!list.length) return { ok: false, message: '没有选中任何错题' };
  if (list.length > 200) return { ok: false, message: '单次最多处理 200 条' };

  var uid = String(userId);
  var affected = 0;
  var now = time.nowUtc();
  var reFirstOn = nextOnFromToday(0);
  var masterStmt = db.prepare([
    'UPDATE wrong_questions SET mastered = 1, next_review_on = \'\', updated_at = ?',
    'WHERE id = ? AND user_id = ?'
  ].join('\n'));
  var unmasterStmt = db.prepare([
    'UPDATE wrong_questions SET mastered = 0, review_stage = 0, next_review_on = ?, updated_at = ?',
    'WHERE id = ? AND user_id = ?'
  ].join('\n'));

  var tx = db.transaction(function() {
    for (var i = 0; i < list.length; i++) {
      var info;
      if (action === 'delete') {
        info = db.prepare('DELETE FROM wrong_questions WHERE id = ? AND user_id = ?').run(list[i], uid);
      } else if (action === 'master') {
        // 标为已掌握要同时清空排期：否则它仍是"未掌握时的到期题"，
        // 继续出现在「今日待复习」里，学生刚确认掌握又被催，会觉得系统没记住他的操作
        info = masterStmt.run(now, list[i], uid);
      } else {
        // 标回待复习 → 从第一级重新排期（他既然说不算掌握，就不该留在旧进度上）
        info = unmasterStmt.run(reFirstOn, now, list[i], uid);
      }
      affected += info.changes;
    }
  });
  tx();

  return { ok: true, affected: affected };
}

// ------------------------------------------------------------
// 复习动作
// ------------------------------------------------------------

// 记一次复习
//   result 'good'  —— 想起来了 / 这次做对了：阶梯往下走一级
//   result 'again' —— 忘了 / 又错了：**打回第一级重来**
//
// 为什么要打回而不是"原地不动"：答错说明这道题的真实记忆强度被高估了，
// 继续按原间隔往后退，等于把漏洞藏起来——下次再见到它时，学生已经忘了更久。
// 打回重来看着严厉，但它才是间隔重复真正起作用的那一半。
//
// 不自动标记"已掌握"：走完阶梯只给建议，最终由学生自己点。
// 机器替他判定"你会了"一旦判错，他会失去对整套复习安排的信任。
function review(id, userId, result) {
  var row = db.prepare('SELECT * FROM wrong_questions WHERE id = ? AND user_id = ?')
    .get(Number(id), String(userId));
  if (!row) return { ok: false, notFound: true, message: '错题不存在' };

  if (row.mastered === 1) {
    return { ok: false, message: '这道题已标记掌握，先「标回待复习」再来练' };
  }

  var kind = String(result || '') === 'again' ? 'again' : 'good';
  var stage = Number(row.review_stage) || 0;
  var today = time.localDay();

  stage = kind === 'again' ? 0 : stage + 1;

  var nextOn = nextOnFromToday(stage);
  var graduated = kind === 'good' && nextOn === '';

  db.prepare([
    'UPDATE wrong_questions',
    'SET review_stage = ?, next_review_on = ?, last_reviewed_on = ?,',
    '    review_count = COALESCE(review_count, 0) + 1, updated_at = ?',
    'WHERE id = ? AND user_id = ?'
  ].join('\n')).run(stage, nextOn, today, time.nowUtc(), Number(id), String(userId));

  return {
    ok: true,
    kind: kind,
    graduated: graduated,
    next_on: nextOn,
    // 服务端把话术也一并给出：「3 天后」这种说法不该让前端各自拼
    next_hint: nextOn ? (time.localDayDiff(today, nextOn) + ' 天后再练') : '',
    stage: stage,
    item: getOne(id, userId)
  };
}

// 「今天先不复习」：把当前到期的题整体往后推 N 天
//
// 为什么必须留这个出口：一个躲不掉的提醒会从"帮忙"变成"压力"。
// 给一个诚实、可逆、一键的推迟，比逼学生点开然后草草划完更尊重他，
// 也保住了复习本身的质量（被逼做的复习等于没做）。
function snooze(userId, days) {
  var uid = String(userId);
  var n = Math.min(Math.max(parseInt(days, 10) || 1, 1), 30);
  var today = time.localDay();
  var until = time.localDay(n);

  var info = db.prepare([
    'UPDATE wrong_questions SET next_review_on = ?',
    'WHERE user_id = ? AND mastered = 0',
    '  AND ((next_review_on != \'\' AND next_review_on <= ?)',
    '       OR (next_review_on = \'\' AND review_stage = 0))'
  ].join('\n')).run(until, uid, today);

  return { ok: true, affected: info.changes, until: until, days: n };
}

// 出现过的学科（筛选下拉）
function subjects(userId) {
  var rows = db.prepare([
    'SELECT subject, COUNT(*) AS c FROM wrong_questions',
    'WHERE user_id = ? AND subject != \'\' GROUP BY subject ORDER BY c DESC LIMIT 30'
  ].join('\n')).all(String(userId));
  return rows.map(function(r) { return { subject: r.subject, count: r.c }; });
}

// 导出 CSV
function exportCsv(userId) {
  var rows = db.prepare(
    'SELECT * FROM wrong_questions WHERE user_id = ? ORDER BY id DESC'
  ).all(String(userId));

  var q = function(s) { return String(s || '').replace(/"/g, '""').replace(/[\r\n]+/g, ' '); };
  var today = time.localDay();
  var lines = ['学科,题干,我的答案,正确答案,错因,状态,复习进度,下次复习,来源,记录时间'];

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var stage = Number(r.review_stage) || 0;
    lines.push([
      '"' + q(r.subject) + '"',
      '"' + q(r.question) + '"',
      '"' + q(r.student_answer) + '"',
      '"' + q(r.correct_answer) + '"',
      '"' + q(r.reason) + '"',
      r.mastered === 1 ? '已掌握' : '待复习',
      // 复习进度用「第 n 级 / 共 m 级」表述，导出的表格给家长或老师看时能直接读懂
      '"' + (r.mastered === 1 ? '—' : ('第 ' + Math.min(stage + 1, LADDER.length) + ' 级 / 共 ' + LADDER.length + ' 级')) + '"',
      '"' + q(reviewHint(r, today)) + '"',
      r.source === 'ai' ? 'AI 提取' : '手动录入',
      String(r.created_at || '').slice(0, 19)
    ].join(','));
  }

  return '\ufeff' + lines.join('\n');
}

module.exports = {
  extractAndStrip: extractAndStrip,
  parseLoose: parseLoose,
  saveExtracted: saveExtracted,
  list: list,
  countsOf: countsOf,
  overview: overview,
  review: review,
  snooze: snooze,
  getOne: getOne,
  create: create,
  update: update,
  remove: remove,
  batch: batch,
  subjects: subjects,
  exportCsv: exportCsv,
  LADDER: LADDER
};