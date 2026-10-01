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
  var stmt = db.prepare([
    'INSERT INTO wrong_questions (user_id, conversation_id, image_hash, source, subject,',
    '  question, student_answer, correct_answer, reason, tag, mastered, note, created_at, updated_at)',
    'VALUES (?, ?, ?, \'ai\', ?, ?, ?, ?, ?, ?, 0, \'\', ?, ?)'
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
        now, now
      );
    }
  });
  tx();

  return list.length;
}

// ---- 查询 ----

function serialize(row) {
  return {
    id: row.id,
    subject: row.subject || '',
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
    created_at: time.toISO(row.created_at),
    updated_at: time.toISO(row.updated_at)
  };
}

// opts: { userId, mastered: ''|'0'|'1', subject, page, limit }
function list(opts) {
  var o = opts || {};
  var page = Math.max(1, parseInt(o.page, 10) || 1);
  var limit = Math.min(Math.max(1, parseInt(o.limit, 10) || 20), 100);

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
  var whereSql = where.join(' AND ');

  var countStmt = db.prepare('SELECT COUNT(*) AS c FROM wrong_questions WHERE ' + whereSql);
  var total = (countStmt.get.apply(countStmt, params) || {}).c || 0;

  var listStmt = db.prepare(
    'SELECT * FROM wrong_questions WHERE ' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?'
  );
  var rows = listStmt.all.apply(listStmt, params.concat([limit, (page - 1) * limit]));

  // 已掌握/未掌握计数用于筛选标签上的角标
  var stat = db.prepare([
    'SELECT SUM(CASE WHEN mastered = 0 THEN 1 ELSE 0 END) AS pending,',
    '       SUM(CASE WHEN mastered = 1 THEN 1 ELSE 0 END) AS done,',
    '       COUNT(*) AS total',
    'FROM wrong_questions WHERE user_id = ?'
  ].join('\n')).get(String(o.userId));

  return {
    page: page,
    limit: limit,
    total: total,
    total_pages: Math.ceil(total / limit),
    counts: {
      pending: (stat && stat.pending) || 0,
      mastered: (stat && stat.done) || 0,
      total: (stat && stat.total) || 0
    },
    items: rows.map(serialize)
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

  var info = db.prepare([
    'INSERT INTO wrong_questions (user_id, conversation_id, image_hash, source, subject,',
    '  question, student_answer, correct_answer, reason, tag, mastered, note, created_at, updated_at)',
    'VALUES (?, \'\', ?, \'manual\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(
    String(userId),
    String(b.image_hash || ''),
    n.subject, question, n.student_answer, n.correct_answer, n.reason, n.tag,
    b.mastered ? 1 : 0,
    String(b.note || '').slice(0, 2000),
    now, now
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
    sets.push('mastered = ?');
    params.push(b.mastered ? 1 : 0);
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

  var tx = db.transaction(function() {
    for (var i = 0; i < list.length; i++) {
      var info;
      if (action === 'delete') {
        info = db.prepare('DELETE FROM wrong_questions WHERE id = ? AND user_id = ?').run(list[i], uid);
      } else {
        var mastered = action === 'master' ? 1 : 0;
        info = db.prepare(
          'UPDATE wrong_questions SET mastered = ?, updated_at = ? WHERE id = ? AND user_id = ?'
        ).run(mastered, now, list[i], uid);
      }
      affected += info.changes;
    }
  });
  tx();

  return { ok: true, affected: affected };
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
  var lines = ['学科,题干,我的答案,正确答案,错因,状态,来源,记录时间'];

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    lines.push([
      '"' + q(r.subject) + '"',
      '"' + q(r.question) + '"',
      '"' + q(r.student_answer) + '"',
      '"' + q(r.correct_answer) + '"',
      '"' + q(r.reason) + '"',
      r.mastered === 1 ? '已掌握' : '待复习',
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
  getOne: getOne,
  create: create,
  update: update,
  remove: remove,
  batch: batch,
  subjects: subjects,
  exportCsv: exportCsv
};