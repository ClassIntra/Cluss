// 作文路由：生成范文 / 批改润色 / 列提纲
//
// 三种用途共用一套参数（语言 / 文体 / 风格 / 字数 / 题目），
// 也共用 turn-runner 的编排（闸门、上下文、流式、记账）。
// 与解题链路的关键差异：
//   - task.kind 为 writing_*，提示词走 prompt-registry 的作文分支
//   - **图片可选**（看图作文 / 手写稿批改），所以 task.requiresImage 为 false
//   - 会话 mode 记为 'writing'，不会混进学习页的会话列表

var express = require('express');
var router = express.Router();
var auth = require('../middleware/auth');
var db = require('../utils/db');
var time = require('../utils/time');
var turnRunner = require('../services/turn-runner');

var LANGUAGES = ['zh', 'en'];
var MODES = ['generate', 'grade', 'outline'];

// 字数上限：防止有人填 100000 字把一次调用成本拉爆
var MAX_WORD_LIMIT = 5000;

function parseWritingParams(body) {
  var b = body || {};

  var language = String(b.language || 'zh').toLowerCase();
  if (LANGUAGES.indexOf(language) < 0) language = 'zh';

  var genre = String(b.genre || '').trim().slice(0, 30);
  var style = String(b.style || '').trim().slice(0, 30);
  var topic = String(b.topic || '').trim().slice(0, 2000);

  var limit = parseInt(b.word_limit, 10);
  if (!isFinite(limit) || limit < 0) limit = 0;
  if (limit > MAX_WORD_LIMIT) limit = MAX_WORD_LIMIT;

  return { language: language, genre: genre, style: style, wordLimit: limit, topic: topic };
}

function normalizeHashes(input) {
  if (!Array.isArray(input)) return [];
  return input.map(function(h) { return String(h || '').trim(); }).filter(Boolean).slice(0, 4);
}

// 把作文参数拼成用户正文（模型既要看 system 里的要求，也要在正文里看到完整任务）
function composeContent(params, mode, extraContent) {
  var p = params;
  var lines = [];

  if (p.topic) lines.push('题目要求：' + p.topic);
  if (p.genre) lines.push('文体：' + p.genre);
  if (p.style) lines.push('风格：' + p.style);
  if (p.wordLimit > 0) lines.push('字数：约 ' + p.wordLimit + ' 字');
  if (p.language === 'en') lines.push('语言：英文');

  var extra = String(extraContent || '').trim();
  if (extra) {
    lines.push('');
    lines.push(mode === 'grade' ? '我的作文：' : '补充说明：');
    lines.push(extra);
  }

  return lines.join('\n').trim();
}

// ============================================================
// POST /api/writing/generate/stream —— 生成范文
// ============================================================
router.post('/generate/stream', auth.requireAuth, function(req, res) {
  var params = parseWritingParams(req.body);
  if (!params.topic) {
    return res.status(400).json({ code: 400, message: '请先填写作文题目或要求' });
  }

  turnRunner.runStreamTurn({
    req: req,
    res: res,
    userId: req.user.user_id,
    content: composeContent(params, 'generate', req.body.content),
    modelId: String(req.body.model_id || ''),
    conversation: {
      id: String(req.body.conversation_id || ''),
      mode: 'writing',
      study_style: 'guided'
    },
    attachmentHashes: normalizeHashes(req.body.image_hashes),
    task: { kind: 'writing_generate', requiresImage: false, writing: params },
    source: 'writing'
  });
});

// ============================================================
// POST /api/writing/grade/stream —— 批改润色
// body: { language, topic?, content?, image_hashes[] }
// 原稿可以粘贴文本，也可以拍手写稿照片，两者至少要有一个
// ============================================================
router.post('/grade/stream', auth.requireAuth, function(req, res) {
  var params = parseWritingParams(req.body);
  var hashes = normalizeHashes(req.body.image_hashes);
  var draft = String(req.body.content || '').trim();

  if (!draft && !hashes.length) {
    return res.status(400).json({ code: 400, message: '请粘贴作文内容，或上传手写稿照片' });
  }

  turnRunner.runStreamTurn({
    req: req,
    res: res,
    userId: req.user.user_id,
    // 批改模式把学生原稿作为正文，模型要评的就是它
    content: composeContent(params, 'grade', draft),
    modelId: String(req.body.model_id || ''),
    conversation: {
      id: String(req.body.conversation_id || ''),
      mode: 'writing',
      study_style: 'guided'
    },
    attachmentHashes: hashes,
    task: { kind: 'writing_grade', requiresImage: false, writing: params },
    source: 'writing'
  });
});

// ============================================================
// POST /api/writing/outline/stream —— 列提纲
// ============================================================
router.post('/outline/stream', auth.requireAuth, function(req, res) {
  var params = parseWritingParams(req.body);
  if (!params.topic) {
    return res.status(400).json({ code: 400, message: '请先填写作文题目或要求' });
  }

  turnRunner.runStreamTurn({
    req: req,
    res: res,
    userId: req.user.user_id,
    content: composeContent(params, 'outline', req.body.content),
    modelId: String(req.body.model_id || ''),
    conversation: {
      id: String(req.body.conversation_id || ''),
      mode: 'writing',
      study_style: 'guided'
    },
    attachmentHashes: normalizeHashes(req.body.image_hashes),
    task: { kind: 'writing_outline', requiresImage: false, writing: params },
    source: 'writing'
  });
});

// ============================================================
// GET /api/writing/pieces —— 作文记录列表
// ============================================================
router.get('/pieces', auth.requireAuth, function(req, res) {
  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 20), 100);
  var mode = String(req.query.mode || '');
  var userId = req.user.user_id;

  var where = ['user_id = ?'];
  var params = [userId];
  if (MODES.indexOf(mode) >= 0) {
    where.push('mode = ?');
    params.push(mode);
  }
  var whereSql = where.join(' AND ');

  var countStmt = db.prepare('SELECT COUNT(*) AS c FROM writing_pieces WHERE ' + whereSql);
  var total = (countStmt.get.apply(countStmt, params) || {}).c || 0;

  var listStmt = db.prepare([
    'SELECT id, mode, language, genre, style, word_limit, topic, created_at,',
    // 列表只回摘要，不把整篇作文搬过来（一篇几千字，20 条就是几十 KB）
    '       substr(content, 1, 120) AS excerpt,',
    '       length(content) AS content_len',
    'FROM writing_pieces WHERE ' + whereSql,
    'ORDER BY id DESC LIMIT ? OFFSET ?'
  ].join('\n'));
  var rows = listStmt.all.apply(listStmt, params.concat([limit, (page - 1) * limit]));

  res.json({
    code: 200,
    message: 'ok',
    data: {
      page: page,
      limit: limit,
      total: total,
      total_pages: Math.ceil(total / limit),
      items: rows.map(function(r) {
        return {
          id: r.id,
          mode: r.mode,
          language: r.language,
          genre: r.genre,
          style: r.style,
          word_limit: r.word_limit,
          topic: r.topic,
          excerpt: r.excerpt || '',
          content_len: r.content_len || 0,
          created_at: time.toISO(r.created_at)
        };
      })
    }
  });
});

// ============================================================
// POST /api/writing/pieces —— 保存一次作文
// ============================================================
router.post('/pieces', auth.requireAuth, function(req, res) {
  var b = req.body || {};
  var mode = String(b.mode || '');
  if (MODES.indexOf(mode) < 0) {
    return res.status(400).json({ code: 400, message: '未知的作文类型' });
  }

  var content = String(b.content || '');
  if (!content.trim()) {
    return res.status(400).json({ code: 400, message: '内容为空，无法保存' });
  }

  var language = LANGUAGES.indexOf(String(b.language)) >= 0 ? String(b.language) : 'zh';
  var limit = parseInt(b.word_limit, 10);
  if (!isFinite(limit) || limit < 0) limit = 0;

  var now = time.nowUtc();
  var info = db.prepare([
    'INSERT INTO writing_pieces (user_id, conversation_id, mode, language, genre, style,',
    '  word_limit, topic, outline, content, feedback, image_hashes, created_at, updated_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(
    req.user.user_id,
    String(b.conversation_id || ''),
    mode, language,
    String(b.genre || '').slice(0, 30),
    String(b.style || '').slice(0, 30),
    limit,
    String(b.topic || '').slice(0, 2000),
    String(b.outline || ''),
    content,
    String(b.feedback || ''),
    JSON.stringify(normalizeHashes(b.image_hashes)),
    now, now
  );

  res.json({ code: 200, message: '已保存', data: { id: info.lastInsertRowid } });
});

// ============================================================
// GET /api/writing/pieces/:id —— 查看单篇（含全文）
// ============================================================
router.get('/pieces/:id', auth.requireAuth, function(req, res) {
  var row = db.prepare('SELECT * FROM writing_pieces WHERE id = ? AND user_id = ?')
    .get(Number(req.params.id), req.user.user_id);
  if (!row) return res.status(404).json({ code: 404, message: '作文不存在' });

  var hashes = [];
  try { hashes = JSON.parse(row.image_hashes || '[]'); } catch (e) { hashes = []; }

  res.json({
    code: 200,
    message: 'ok',
    data: {
      piece: {
        id: row.id,
        mode: row.mode,
        language: row.language,
        genre: row.genre,
        style: row.style,
        word_limit: row.word_limit,
        topic: row.topic,
        outline: row.outline,
        content: row.content,
        feedback: row.feedback,
        image_hashes: hashes,
        created_at: time.toISO(row.created_at)
      }
    }
  });
});

// ============================================================
// DELETE /api/writing/pieces/:id
// ============================================================
router.delete('/pieces/:id', auth.requireAuth, function(req, res) {
  var info = db.prepare('DELETE FROM writing_pieces WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.user_id);
  if (!info.changes) return res.status(404).json({ code: 404, message: '作文不存在' });
  res.json({ code: 200, message: '已删除', data: null });
});

module.exports = router;