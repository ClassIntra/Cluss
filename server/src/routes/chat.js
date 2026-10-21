// 对话路由（薄层）
//
// 只负责：参数校验、会话 CRUD、人格 CRUD、把请求交给 turn-runner。
// 所有编排逻辑（闸门、上下文、流式、记账）都在 services/turn-runner.js ——
// 这样学习链路（routes/study.js）能复用同一套流程，不会出现两份逐渐漂移的实现。

var express = require('express');
var router = express.Router();
var db = require('../utils/db');
var time = require('../utils/time');
var auth = require('../middleware/auth');
var ai = require('../services/ai');
var credit = require('../services/credit');
var prompts = require('../services/prompt-registry');
var personaStore = require('../services/persona-store');
var constants = require('../utils/constants');
var conv = require('../services/conversation-core');
var privateLock = require('../services/private-lock');
var turnRunner = require('../services/turn-runner');

// ============================================================
// 模型列表
//
// 学生端只列出**可用**的模型。
// 「DeepSeek Chat（未配置 Key）」这种选项对学生毫无意义 —— 他没配过、也配不了，
// 看到只会以为软件坏了。那是管理员要处理的事，不该出现在学生的界面上。
// 管理员仍然能看到全部（含不可用的），便于排查。
// ============================================================
router.get('/models', auth.requireAuth, function(req, res) {
  var isAdmin = req.user.is_admin === 1;
  var bundle = ai.listModelsForClient();
  var all = bundle.models;
  var list = isAdmin ? all : all.filter(function(m) { return m.available; });

  var def = ai.getDefaultModelId();
  if (!isAdmin) {
    // 默认模型恰好不可用时自动落到第一个可用的，
    // 否则学生会遇到"一进来选中的就是个不能用的"
    var hit = list.filter(function(m) { return m.id === def; });
    if (!hit.length) def = (list[0] && list[0].id) || '';
  }

  res.json({
    code: 200,
    message: 'ok',
    // offpeak：当前处于谷时段时下发折扣信息（null = 平价），
    // 学生界面据此显示"现在时段更划算"，不出现任何金额
    data: { models: list, default_model: def, offpeak: bundle.offpeak }
  });
});

// ============================================================
// 会话管理
// ============================================================
// 会话列表：游标分页 + 搜索
//
// 返回 { conversations, next_cursor, has_more }。
// 分页用**游标**而不是 page/offset：列表按 updated_at 动态排序，
// 用 OFFSET 在学生一边翻页一边发消息时会漏条或重复（详见 conversation-core 的注释）。
// 前端拿到 has_more=false 就停止请求 —— 之前这里没有分页，服务端硬砍到 300 条，
// 第 301 个会话永远看不见且前端无从察觉。
router.get('/conversations', auth.requireAuth, function(req, res) {
  // 隐藏会话只在"已解锁"时才带出：没解锁时列表里根本不出现，
  // 与"从来没有过这条会话"无法区分——不透露存在性。
  var unlocked = false;
  try { unlocked = privateLock.isUnlocked(req.user.user_id); } catch (e) {}
  var out = conv.listConversations(req.user.user_id, {
    mode: String(req.query.mode || '').trim(),
    q: String(req.query.q || '').trim(),
    limit: req.query.limit,
    cursor: req.query.cursor,
    includeHidden: unlocked && String(req.query.include_hidden || '') === '1'
  });
  res.json({
    code: 200,
    message: 'ok',
    data: {
      conversations: out.rows.map(conv.serializeConversation),
      next_cursor: out.next_cursor,
      has_more: out.has_more
    }
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
    // 归一化后再落库；非日常模式会被 ensureConversation 忽略
    dailyStyle: req.body.daily_style !== undefined
      ? prompts.normalizeDailyStyle(req.body.daily_style) : undefined,
    titleFrom: ''
  });
  res.json({ code: 200, message: 'ok', data: conv.serializeConversation(row) });
});

router.get('/conversations/:id', auth.requireAuth, function(req, res) {
  // 未解锁时打开隐藏会话返回与"会话不存在"完全相同的 404：
  // 不告诉别人"这条是存在的，只是锁着"。
  var unlocked = false;
  try { unlocked = privateLock.isUnlocked(req.user.user_id); } catch (e) {}
  var row = conv.getConversationForRead(req.params.id, req.user.user_id, unlocked);
  if (!row) return res.status(404).json({ code: 404, message: '会话不存在' });

  var msgs = db.prepare(
    'SELECT id, role, content, model_id, attachments, source, streaming, sources, created_at FROM ai_messages WHERE conversation_id = ? ORDER BY id ASC'
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
  var unlocked0 = false;
  try { unlocked0 = privateLock.isUnlocked(req.user.user_id); } catch (e) {}
  var row = conv.getConversationForRead(req.params.id, req.user.user_id, unlocked0);
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

// 切换会话模式（学习大类与子模式）+ 日常模式的无限制风格
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

  // daily_style：显式切换时**严格校验**，不像流式链路那样宽容。
  // 理由：这是一次明确的用户操作（点了开关），传了非法值说明前端有 bug，
  // 此时静默降级成"受限"会表现为"点了没反应"，很难查；直接报错更快暴露。
  var dailyStyle;
  if (req.body.daily_style !== undefined) {
    var raw = String(req.body.daily_style).trim().toLowerCase();
    if (raw !== 'free' && raw !== 'limited' && raw !== '') {
      return res.status(400).json({ code: 400, message: 'daily_style 只能是 free 或 limited' });
    }
    dailyStyle = prompts.normalizeDailyStyle(raw);
  }

  var unlocked1 = false;
  try { unlocked1 = privateLock.isUnlocked(req.user.user_id); } catch (e) {}
  var cur = conv.getConversationForRead(req.params.id, req.user.user_id, unlocked1);
  if (!cur) return res.status(404).json({ code: 404, message: '会话不存在' });

  var row = conv.updateConversationMode(req.params.id, req.user.user_id, mode, studyStyle, dailyStyle);
  if (!row) return res.status(404).json({ code: 404, message: '会话不存在' });

  res.json({ code: 200, message: 'ok', data: conv.serializeConversation(row) });
});

router.delete('/conversations/:id', auth.requireAuth, function(req, res) {
  // 删除同样要先过 hidden 门：没解锁时连"删得掉"都不该发生，
  // 否则可以靠"试删"来探测某条会话是否存在。
  var unlocked2 = false;
  try { unlocked2 = privateLock.isUnlocked(req.user.user_id); } catch (e) {}
  if (!conv.getConversationForRead(req.params.id, req.user.user_id, unlocked2)) {
    return res.status(404).json({ code: 404, message: '会话不存在' });
  }
  if (!conv.deleteConversation(req.params.id, req.user.user_id)) {
    return res.status(404).json({ code: 404, message: '会话不存在' });
  }
  res.json({ code: 200, message: '已删除', data: null });
});

// 隐藏 / 取消隐藏一条会话。
// 设计取舍：**隐藏不需要密码，取消隐藏必须已解锁**。
// 理由与笔记一致——"不想让人看见"是即兴动作（旁边有人、临时借设备），
// 要求先输密码会让这个动作慢到不可用；而"重新放出"是有意的主动行为，
// 此时要密码正合适。改成两边都要密码的方案看起来更严，实际会把主功能废掉。
router.post('/conversations/:id/hide', auth.requireAuth, function(req, res) {
  var wantHidden = !!req.body.hidden;
  var unlocked = false;
  try { unlocked = privateLock.isUnlocked(req.user.user_id); } catch (e) {}

  if (!wantHidden && !unlocked) {
    // 不透露"存在但锁着"，与真 404 同形
    return res.status(404).json({ code: 404, message: '会话不存在' });
  }

  var out = conv.setHidden(req.params.id, req.user.user_id, wantHidden);
  if (!out.ok) return res.status(404).json({ code: 404, message: '会话不存在' });
  res.json({ code: 200, message: out.message, data: { hidden: out.hidden } });
});

// ============================================================
// POST /chat/stream —— 流式对话（委托 turn-runner）
// ============================================================
router.post('/chat/stream', auth.requireAuth, function(req, res) {
  var content = String(req.body.content || '').trim();
  var mode = String(req.body.mode || '').trim();
  var studyStyle = String(req.body.study_style || '').trim();
  var persona = String(req.body.persona || '').trim();
  var dailyStyle = String(req.body.daily_style || '').trim();

  // 模式只在显式传入时生效，避免前端忘记带参数时把已有会话的模式重置
  var conversation = { id: String(req.body.conversation_id || '') };
  if (mode) conversation.mode = mode;
  if (studyStyle) conversation.study_style = studyStyle;
  // persona 与 daily_style 同规则：**只在客户端确实传了才写**（不传 = 别动）。
  // persona 传 'buddy' 表示回到默认语气；daily_style 传 'limited' 表示回到受限——
  // 两者都是有效值，所以判据是"非空"而不是"不等于默认值"。
  if (persona) conversation.persona = persona;
  if (dailyStyle) conversation.daily_style = dailyStyle;

  if (conversation.id) {
    // 隐藏会话未解锁时**不能继续往里发消息**。
    // 少了这道门的话：列表看不见 → 但知道 id 的人仍然能对话，
    // "隐藏"就退化成了"列表里不显示"，锁毫无意义。
    var streamUnlocked = false;
    try { streamUnlocked = privateLock.isUnlocked(req.user.user_id); } catch (e) {}
    if (!conv.getConversationForRead(conversation.id, req.user.user_id, streamUnlocked)) {
      return res.status(404).json({ code: 404, message: '会话不存在' });
    }
  }

  turnRunner.runStreamTurn({
    req: req,
    res: res,
    userId: req.user.user_id,
    content: content,
    modelId: String(req.body.model_id || ''),
    // 深度思考：用户在对话页的开关（前端 localStorage 记住偏好，逐轮随请求带上）。
    // 只认严格 true —— 早期版本前端可能传 '1'/'on' 之类的历史值，
    // 与其猜语义，不如按「没开」处理，行为最可预期。
    thinking: req.body.thinking === true,
    conversation: conversation,
    attachmentHashes: req.body.attachment_hashes || [],
    noteIds: req.body.note_ids || [],
    task: { kind: '' },
    source: 'chat'
  });
});

// ============================================================
// 日常模式人格
//
// 两套来源合成一个列表给前端：
//   内置（prompt-registry 里写死，builtin=1）—— 所有学生都有、不可改删；
//   自定义（库里按学生存，builtin=0）—— 可增删改。
// 合成放在服务端而不是前端：前端只认一个列表，将来加"学校预置人格"
// 之类的来源时，前端一个字都不用改。
// ============================================================
router.get('/personas', auth.requireAuth, function(req, res) {
  var custom = [];
  try {
    custom = personaStore.list(req.user.user_id);
  } catch (e) {
    // 人格表异常不该让整页打不开：内置那 4 个照常返回
    console.warn('[Persona] 自定义人格读取失败:', e.message);
  }
  res.json({
    code: 200,
    message: 'ok',
    data: {
      personas: prompts.listPersonas().concat(custom),
      // 上限一并下发：前端据此在够多时把「新建」按钮置灰，不必等提交才报错
      limits: { max_count: personaStore.MAX_COUNT, max_name: personaStore.MAX_NAME, max_prompt: personaStore.MAX_PROMPT }
    }
  });
});

// 新建自定义人格
router.post('/personas', auth.requireAuth, function(req, res) {
  var r = personaStore.create(req.user.user_id, {
    name: req.body.name,
    prompt: req.body.prompt
  });
  if (!r.ok) return res.status(400).json({ code: 400, message: r.message });
  res.json({ code: 200, message: '已创建', data: { persona: r.persona } });
});

// 修改自定义人格（内置人格不可改，personaStore 只认 'p:数字'，天然拦住）
router.put('/personas/:id', auth.requireAuth, function(req, res) {
  var r = personaStore.update(req.user.user_id, req.params.id, {
    name: req.body.name,
    prompt: req.body.prompt
  });
  if (!r.ok) {
    var status = r.message === '人格不存在' ? 404 : 400;
    return res.status(status).json({ code: status, message: r.message });
  }
  res.json({ code: 200, message: '已保存', data: { persona: r.persona } });
});

// 删除自定义人格
//
// 刻意**不**回头清理会话里引用的这个 id（见 persona-store.remove 的说明）：
// 那些会话会优雅回落成默认语气，而不是被连锁改动。
router.delete('/personas/:id', auth.requireAuth, function(req, res) {
  var r = personaStore.remove(req.user.user_id, req.params.id);
  if (!r.ok) return res.status(404).json({ code: 404, message: r.message });
  res.json({ code: 200, message: '已删除', data: null });
});

// ============================================================
// GET /wallet —— 学生端额度视图（积分口径）
// 管理端有自己的接口（/api/admin/*），那边继续用元对账
// ============================================================
router.get('/wallet', auth.requireAuth, function(req, res) {
  var state = credit.getState(req.user.user_id);
  var view = credit.toPointsView(state);
  view.unlimited = false;
  view.topup_hint = '联系管理员充值';
  res.json({ code: 200, message: 'ok', data: view });
});

module.exports = router;
