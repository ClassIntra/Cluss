// 学习模式路由：拍题解答 + 作业批改
//
// 与对话链路的唯一差别是 task 参数（决定提示词与是否要求图片），
// 其余流程（闸门、上下文、流式、记账）完全复用 turn-runner —— 这正是
// 批次 1 抽出编排层的意义。

var express = require('express');
var router = express.Router();
var auth = require('../middleware/auth');
var conv = require('../services/conversation-core');
var turnRunner = require('../services/turn-runner');

// 题量模式：只允许这三种
var PAPER_MODES = ['single', 'multi', 'cross_page'];

// ============================================================
// POST /api/study/solve/stream —— 拍题解答
// body: { conversation_id?, model_id, paper_mode, image_hashes[], content? }
// ============================================================
router.post('/solve/stream', auth.requireAuth, function(req, res) {
  var paperMode = String(req.body.paper_mode || 'single').trim();
  if (PAPER_MODES.indexOf(paperMode) < 0) {
    return res.status(400).json({ code: 400, message: '题量模式只能是单题、多题或跨页题' });
  }

  var imageHashes = Array.isArray(req.body.image_hashes) ? req.body.image_hashes : [];
  if (!imageHashes.length) {
    return res.status(400).json({ code: 400, message: '请先选择题目图片' });
  }

  // 跨页题至少两张才有意义；只有一张时直接降级为单题，避免模型做无意义的「拼接自检」
  if (paperMode === 'cross_page' && imageHashes.length < 2) {
    paperMode = 'single';
  }

  turnRunner.runStreamTurn({
    req: req,
    res: res,
    userId: req.user.user_id,
    content: String(req.body.content || '').trim(),
    modelId: String(req.body.model_id || ''),
    conversation: {
      id: String(req.body.conversation_id || ''),
      mode: 'study',
      study_style: String(req.body.study_style || 'guided')
    },
    attachmentHashes: imageHashes,
    task: { kind: 'solve', paperMode: paperMode, requiresImage: true },
    source: 'solve'
  });
});

// ============================================================
// POST /api/study/grade/stream —— 作业批改
// body: { conversation_id?, model_id, answer_hashes[], content? }
// ============================================================
router.post('/grade/stream', auth.requireAuth, function(req, res) {
  var answerHashes = Array.isArray(req.body.answer_hashes) ? req.body.answer_hashes : [];
  if (!answerHashes.length) {
    return res.status(400).json({ code: 400, message: '请先选择作答图片' });
  }

  turnRunner.runStreamTurn({
    req: req,
    res: res,
    userId: req.user.user_id,
    content: String(req.body.content || '').trim(),
    modelId: String(req.body.model_id || ''),
    conversation: {
      id: String(req.body.conversation_id || ''),
      mode: 'study',
      study_style: 'guided'   // 批改固定用引导基调（批改本身已是直答）
    },
    attachmentHashes: answerHashes,
    task: { kind: 'grade', requiresImage: true },
    source: 'grade'
  });
});

// ============================================================
// GET /api/study/records —— 解题与批改记录
//
// 一条 JOIN 查询即可：类型看该会话里有没有 grade 来源的消息，
// 缩略图取该会话用户消息附件里的第一张图。
// 不复用 /study/conversations 是因为那个接口不带类型、图与摘要。
// ============================================================
router.get('/records', auth.requireAuth, function(req, res) {
  var db = require('../utils/db');
  var time = require('../utils/time');
  var type = String(req.query.type || 'all');
  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 20), 100);
  var offset = (page - 1) * limit;

  // 类型筛选用 HAVING：需要先聚合出 indeed_grade 才能判断
  var having = '';
  if (type === 'grade') having = 'HAVING grade_count > 0';
  else if (type === 'solve') having = 'HAVING grade_count = 0';

  var baseSql = [
    'SELECT c.id AS conversation_id, c.title, c.model_id, c.created_at, c.updated_at,',
    '       COUNT(m.id) AS image_count,',
    '       SUM(CASE WHEN m.source = \'grade\' THEN 1 ELSE 0 END) AS grade_count',
    'FROM ai_conversations c',
    'JOIN ai_messages m ON m.conversation_id = c.id',
    '  AND m.role = \'user\' AND m.source IN (\'solve\', \'grade\')',
    'WHERE c.user_id = ?',
    'GROUP BY c.id',
    having
  ].join('\n');

  var countSql = 'SELECT COUNT(*) AS c FROM (' + baseSql + ')';
  var countStmt = db.prepare(countSql);
  var total = (countStmt.get(req.user.user_id) || {}).c || 0;

  var listSql = baseSql + '\nORDER BY c.updated_at DESC LIMIT ? OFFSET ?';
  var listStmt = db.prepare(listSql);
  var rows = listStmt.all(req.user.user_id, limit, offset);

  // 逐会话补齐「缩略图」与「摘要」
  // 为什么不在主查询里 JOIN：这两个字段分别来自 attachments(JSON) 与
  // content 的前若干字符，在 SQL 里解析 JSON 既不可移植也没必要——
  // 一页最多 20 条，逐条查完全够快。
  var items = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];

    var thumbHash = '';
    var attRow = db.prepare([
      'SELECT attachments FROM ai_messages',
      'WHERE conversation_id = ? AND role = \'user\' AND attachments != \'[]\'',
      'ORDER BY id ASC LIMIT 1'
    ].join('\n')).get(r.conversation_id);

    if (attRow) {
      try {
        var atts = JSON.parse(attRow.attachments || '[]');
        for (var a = 0; a < atts.length; a++) {
          if (atts[a].kind === 'image' && atts[a].hash) { thumbHash = atts[a].hash; break; }
        }
      } catch (e) { /* 脏数据忽略 */ }
    }

    var sumRow = db.prepare([
      'SELECT content FROM ai_messages',
      'WHERE conversation_id = ? AND role = \'assistant\'',
      'ORDER BY id DESC LIMIT 1'
    ].join('\n')).get(r.conversation_id);

    var summary = '';
    if (sumRow && sumRow.content) {
      summary = String(sumRow.content)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\$\$[\s\S]*?\$\$/g, ' ')
        .replace(/\$[^\n$]*?\$/g, ' ')
        .replace(/[#*`>_~|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
    }

    items.push({
      conversation_id: r.conversation_id,
      type: r.grade_count > 0 ? 'grade' : 'solve',
      title: r.title,
      model_id: r.model_id,
      image_count: r.image_count || 0,
      thumb_hash: thumbHash,
      thumb_url: thumbHash ? ('/api/cloud/files/' + thumbHash + '?thumb=1') : '',
      summary: summary,
      created_at: time.toISO(r.created_at),
      updated_at: time.toISO(r.updated_at)
    });
  }

  res.json({
    code: 200,
    message: 'ok',
    data: { items: items, total: total, page: page, total_pages: Math.ceil(total / limit) }
  });
});

// ============================================================
// GET /api/study/conversations —— 学习类会话列表
// ============================================================
router.get('/conversations', auth.requireAuth, function(req, res) {
  var rows = conv.listConversations(req.user.user_id, 'study', req.query.limit);
  res.json({
    code: 200,
    message: 'ok',
    data: { conversations: rows.map(conv.serializeConversation) }
  });
});

// ============================================================
// GET /api/study/capabilities —— 拍题能力探测
// 前端据此决定「拍题入口」是否可用、最多能选几张图
// ============================================================
router.get('/capabilities', auth.requireAuth, function(req, res) {
  var ai = require('../services/ai');
  var vision = require('../services/vision');

  var cfg = vision.getVisionConfig();
  var models = ai.listModelsForClient();

  var visionModels = [];
  for (var i = 0; i < models.length; i++) {
    if (models[i].vision_available) {
      visionModels.push({
        id: models[i].id,
        label: models[i].label,
        supports_vision: models[i].supports_vision,
        via_relay: models[i].vision_via_relay
      });
    }
  }

  res.json({
    code: 200,
    message: 'ok',
    data: {
      enabled: cfg.enabled,
      available: cfg.enabled && visionModels.length > 0,
      max_images: cfg.maxImages,
      paper_modes: [
        { id: 'single', label: '单题', hint: '图片中是一道完整的题' },
        { id: 'multi', label: '多题', hint: '图片中包含多道题，将逐题解答' },
        { id: 'cross_page', label: '跨页题', hint: '多张图是同一道题的连续部分，请按顺序选择' }
      ],
      vision_models: visionModels,
      sharp_available: vision.sharpAvailable,
      reason: !cfg.enabled
        ? '管理员已关闭看图功能'
        : (visionModels.length === 0 ? '当前没有可看图的模型，请联系管理员配置' : '')
    }
  });
});

module.exports = router;