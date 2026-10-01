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
    task: { kind: 'solve', paperMode: paperMode },
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
    task: { kind: 'grade' },
    source: 'grade'
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