// 对话路由（薄层）
//
// 只负责：参数校验、会话 CRUD、把请求交给 turn-runner。
// 所有编排逻辑（闸门、上下文、流式、记账）都在 services/turn-runner.js ——
// 这样学习链路（routes/study.js）能复用同一套流程，不会出现两份逐渐漂移的实现。

var express = require('express');
var router = express.Router();
var db = require('../utils/db');
var time = require('../utils/time');
var auth = require('../middleware/auth');
var ai = require('../services/ai');
var credit = require('../services/credit');
var config = require('../config');
var constants = require('../utils/constants');
var conv = require('../services/conversation-core');
var turnRunner = require('../services/turn-runner');

// ============================================================
// 模型列表
// ============================================================
router.get('/models', auth.requireAuth, function(req, res) {
  res.json({
    code: 200,
    message: 'ok',
    data: { models: ai.listModelsForClient(), default_model: ai.getDefaultModelId() }
  });
});

// ============================================================
// 会话管理
// ============================================================
router.get('/conversations', auth.requireAuth, function(req, res) {
  var mode = String(req.query.mode || '').trim();
  var rows = conv.listConversations(req.user.user_id, mode, req.query.limit);
  res.json({
    code: 200,
    message: 'ok',
    data: { conversations: rows.map(conv.serializeConversation) }
  });
});

router.post('/conversations', auth.requireAuth, function(req, res) {
  var mode = String(req.body.mode || 'study');
  var studyStyle = String(req.body.study_style || 'guided');
  var modelId = String(req.body.model_id || ai.getDefaultModelId());

  var row = conv.ensureConversation(req.user.user_id, {
    modelId: modelId,
    mode: mode,
    studyStyle: studyStyle,
    titleFrom: ''
  });
  res.json({ code: 200, message: 'ok', data: conv.serializeConversation(row) });
});

router.get('/conversations/:id', auth.requireAuth, function(req, res) {
  var row = conv.getConversation(req.params.id, req.user.user_id);
  if (!row) return res.status(404).json({ code: 404, message: '会话不存在' });

  var msgs = db.prepare(
    'SELECT id, role, content, model_id, attachments, source, created_at FROM ai_messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(row.id);

  res.json({
    code: 200,
    message: 'ok',
    data: {
      conversation: conv.serializeConversation(row),
      messages: msgs.map(conv.serializeMessage)
    }
  });
});

router.patch('/conversations/:id', auth.requireAuth, function(req, res) {
  var row = conv.getConversation(req.params.id, req.user.user_id);
  if (!row) return res.status(404).json({ code: 404, message: '会话不存在' });

  var title = String(req.body.title || '').trim();
  var modelId = String(req.body.model_id || '').trim();

  if (title) {
    db.prepare('UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.slice(0, 40), time.nowUtc(), row.id);
  }
  if (modelId) {
    db.prepare('UPDATE ai_conversations SET model_id = ?, updated_at = ? WHERE id = ?')
      .run(modelId, time.nowUtc(), row.id);
  }
  res.json({ code: 200, message: 'ok', data: null });
});

// 切换会话模式（学习大类与子模式）
// 单独一个端点而非并入 PATCH：模式切换是高频操作，且语义比「改个字段」重
router.put('/conversations/:id/mode', auth.requireAuth, function(req, res) {
  var mode = String(req.body.mode || '').trim();
  var studyStyle = String(req.body.study_style || '').trim();

  if (mode && mode !== 'study' && mode !== 'daily') {
    return res.status(400).json({ code: 400, message: '模式只能是 study 或 daily' });
  }
  if (studyStyle && studyStyle !== 'guided' && studyStyle !== 'direct') {
    return res.status(400).json({ code: 400, message: '学习模式只能是 guided 或 direct' });
  }

  var row = conv.updateConversationMode(req.params.id, req.user.user_id, mode, studyStyle);
  if (!row) return res.status(404).json({ code: 404, message: '会话不存在' });

  res.json({ code: 200, message: 'ok', data: conv.serializeConversation(row) });
});

router.delete('/conversations/:id', auth.requireAuth, function(req, res) {
  if (!conv.deleteConversation(req.params.id, req.user.user_id)) {
    return res.status(404).json({ code: 404, message: '会话不存在' });
  }
  res.json({ code: 200, message: '已删除', data: null });
});

// ============================================================
// POST /chat/stream —— 流式对话（委托 turn-runner）
// ============================================================
router.post('/chat/stream', auth.requireAuth, function(req, res) {
  var content = String(req.body.content || '').trim();
  var mode = String(req.body.mode || '').trim();
  var studyStyle = String(req.body.study_style || '').trim();

  // 模式只在显式传入时生效，避免前端忘记带参数时把已有会话的模式重置
  var conversation = { id: String(req.body.conversation_id || '') };
  if (mode) conversation.mode = mode;
  if (studyStyle) conversation.study_style = studyStyle;

  turnRunner.runStreamTurn({
    req: req,
    res: res,
    userId: req.user.user_id,
    content: content,
    modelId: String(req.body.model_id || ''),
    conversation: conversation,
    attachmentHashes: req.body.attachment_hashes || [],
    task: { kind: '' },
    source: 'chat'
  });
});

// ============================================================
// GET /wallet —— 用户额度视图
// ============================================================
router.get('/wallet', auth.requireAuth, function(req, res) {
  var state = credit.getState(req.user.user_id);
  res.json({
    code: 200,
    message: 'ok',
    data: {
      unlimited: false,
      allocated_yuan: config.microToYuan(state.allocated_micro).toFixed(2),
      used_yuan: config.microToYuan(state.used_micro).toFixed(2),
      available_yuan: config.microToYuan(state.available_micro).toFixed(2),
      available_micro: state.available_micro,
      is_allocated: state.is_allocated,
      used_percent: state.used_percent,
      weekly_unlimited: state.weekly_unlimited,
      weekly_quota_yuan: config.microToYuan(state.weekly_quota_micro).toFixed(2),
      weekly_used_yuan: config.microToYuan(state.weekly_used_micro).toFixed(2),
      weekly_remaining_yuan: config.microToYuan(state.weekly_remaining_micro).toFixed(2),
      weekly_percent: state.weekly_percent,
      window_days: state.window_days,
      topup_hint: '联系管理员充值'
    }
  });
});

module.exports = router;