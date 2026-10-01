// 会话与对话路由
//
// 主链路：/chat/stream
//   闸门校验 → 存档用户消息 → 组装上下文 → 流式返回 → 落助手消息 → 记账扣费
//
// 扣费时机：**回答完成后**按上游实际 usage 计费。
// 若事前就扣，回答失败就要回滚；事后扣则余额可能出现短暂透支（末次成本略超余额），
// 这是可接受的：宁可少收一次，也不打断正在生成的回答。

var express = require('express');
var router = express.Router();
var db = require('../utils/db');
var time = require('../utils/time');
var auth = require('../middleware/auth');
var ai = require('../services/ai');
var credit = require('../services/credit');
var pricing = require('../services/pricing');
var config = require('../config');
var constants = require('../utils/constants');

// 引导式解题的系统提示词：Cluss 的产品内核，改动它等于改动产品行为
var SYSTEM_PROMPT = [
  '你是「Cluss」的引导式解题助手，面向学生，目标是让他真正学会，而不是替他交作业。',
  '',
  '核心原则：',
  '1. 默认不直接给最终答案。先用一两个问题确认他已掌握的条件与卡点，再逐步给提示。',
  '2. 引导要分层：先给方向（考点/思路），不够再给关键步骤，最后才给完整过程。每一层都停下来等他回应。',
  '3. 学生说「直接给答案」「我赶时间」时，用一句话说明引导的理由，然后给出**完整推理过程**（含每一步依据），而不是只丢一个结果。',
  '4. 学生给出自己的解法时，逐步骤检查，明确指出哪一步对、哪一步错、错在哪个概念上。',
  '5. 数学式用 LaTeX（行内 $...$，独立公式 $$...$$）；代码标语言且保证可运行。',
  '6. 不确定就说不确定，绝不编造定理、公式、数据或来源。',
  '7. 用中文回答，语气平实、不客套，不复述问题，不说「作为一个 AI」。'
].join('\n');

var MAX_CONTEXT_MESSAGES = 20;

function getConversation(convId, userId) {
  var row = db.prepare('SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?').get(String(convId), String(userId));
  return row || null;
}

function loadHistory(convId) {
  var rows = db.prepare(
    'SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?'
  ).all(String(convId), MAX_CONTEXT_MESSAGES);
  rows.reverse();
  return rows;
}

function insertMessage(convId, role, content, modelId) {
  db.prepare([
    'INSERT INTO ai_messages (conversation_id, role, content, model_id, created_at)',
    'VALUES (?, ?, ?, ?, ?)'
  ].join('\n')).run(String(convId), String(role), String(content || ''), String(modelId || ''), time.nowUtc());
  db.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(time.nowUtc(), String(convId));
}

// 从上游 usage 中提取令牌数（兼容 OpenAI 与 DeepSeek 的两种缓存字段）
function extractUsage(usage, fallbackPromptText, fallbackCompletionText) {
  if (!usage) {
    var p = pricing.estimateTokens(fallbackPromptText);
    var c = pricing.estimateTokens(fallbackCompletionText);
    return {
      prompt_tokens: p, completion_tokens: c, cache_hit_tokens: 0, cache_miss_tokens: p,
      total_tokens: p + c, estimated: 1
    };
  }
  var promptTokens = Number(usage.prompt_tokens || 0);
  var completionTokens = Number(usage.completion_tokens || 0);
  var cacheHit = Number(usage.prompt_cache_hit_tokens ||
    (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0);
  cacheHit = Math.min(cacheHit, promptTokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cache_hit_tokens: cacheHit,
    cache_miss_tokens: promptTokens - cacheHit,
    total_tokens: Number(usage.total_tokens || (promptTokens + completionTokens)),
    estimated: 0
  };
}

// 标题自动取首条消息前 20 字
function autoTitle(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '新对话';
  return t.length > 20 ? t.slice(0, 20) + '…' : t;
}

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
  var rows = db.prepare(
    'SELECT id, title, model_id, created_at, updated_at FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100'
  ).all(req.user.user_id);

  res.json({
    code: 200,
    message: 'ok',
    data: {
      conversations: rows.map(function(r) {
        return {
          id: r.id,
          title: r.title,
          model_id: r.model_id,
          created_at: time.toISO(r.created_at),
          updated_at: time.toISO(r.updated_at)
        };
      })
    }
  });
});

router.post('/conversations', auth.requireAuth, function(req, res) {
  var id = constants.randomId('c_');
  var modelId = String(req.body.model_id || ai.getDefaultModelId());
  db.prepare([
    'INSERT INTO ai_conversations (id, user_id, title, model_id, created_at, updated_at)',
    'VALUES (?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(id, req.user.user_id, '新对话', modelId, time.nowUtc(), time.nowUtc());

  res.json({ code: 200, message: 'ok', data: { id: id, title: '新对话', model_id: modelId } });
});

router.get('/conversations/:id', auth.requireAuth, function(req, res) {
  var conv = getConversation(req.params.id, req.user.user_id);
  if (!conv) return res.status(404).json({ code: 404, message: '会话不存在' });

  var msgs = db.prepare(
    'SELECT id, role, content, model_id, created_at FROM ai_messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(conv.id);

  res.json({
    code: 200,
    message: 'ok',
    data: {
      conversation: { id: conv.id, title: conv.title, model_id: conv.model_id, updated_at: time.toISO(conv.updated_at) },
      messages: msgs.map(function(m) {
        return { id: m.id, role: m.role, content: m.content, model_id: m.model_id, created_at: time.toISO(m.created_at) };
      })
    }
  });
});

router.patch('/conversations/:id', auth.requireAuth, function(req, res) {
  var conv = getConversation(req.params.id, req.user.user_id);
  if (!conv) return res.status(404).json({ code: 404, message: '会话不存在' });

  var title = String(req.body.title || '').trim();
  var modelId = String(req.body.model_id || '').trim();

  if (title) {
    db.prepare('UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.slice(0, 40), time.nowUtc(), conv.id);
  }
  if (modelId) {
    db.prepare('UPDATE ai_conversations SET model_id = ?, updated_at = ? WHERE id = ?')
      .run(modelId, time.nowUtc(), conv.id);
  }
  res.json({ code: 200, message: 'ok', data: null });
});

router.delete('/conversations/:id', auth.requireAuth, function(req, res) {
  var conv = getConversation(req.params.id, req.user.user_id);
  if (!conv) return res.status(404).json({ code: 404, message: '会话不存在' });

  db.prepare('DELETE FROM ai_messages WHERE conversation_id = ?').run(conv.id);
  db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(conv.id);
  res.json({ code: 200, message: '已删除', data: null });
});

// ============================================================
// POST /chat/stream —— 流式对话（主链路）
// ============================================================
router.post('/chat/stream', auth.requireAuth, function(req, res) {
  var userId = req.user.user_id;
  var convId = String(req.body.conversation_id || '');
  var content = String(req.body.content || '').trim();
  var modelId = String(req.body.model_id || '').trim();

  if (!content) {
    return res.status(400).json({ code: 400, message: '消息内容不能为空' });
  }
  if (content.length > 8000) {
    return res.status(400).json({ code: 400, message: '单条消息最多 8000 字' });
  }

  // 1) 会话：不存在则新建（前端可以不预先建会话）
  var conv = convId ? getConversation(convId, userId) : null;
  if (!conv) {
    convId = constants.randomId('c_');
    modelId = modelId || ai.getDefaultModelId();
    db.prepare([
      'INSERT INTO ai_conversations (id, user_id, title, model_id, created_at, updated_at)',
      'VALUES (?, ?, ?, ?, ?, ?)'
    ].join('\n')).run(convId, userId, autoTitle(content), modelId, time.nowUtc(), time.nowUtc());
    conv = getConversation(convId, userId);
  }

  // 2) 模型解析
  var effectiveModelId = modelId || conv.model_id || ai.getDefaultModelId();
  var model = ai.resolveModel(effectiveModelId);
  if (!model) {
    return res.status(404).json({ code: 404, message: '模型不存在，请在设置中选择其他模型' });
  }

  // 3) 额度闸门
  //    顺序刻意放在「模型可用性」之前：额度是学生最常撞到的门，
  //    先判它才能给出「去充值」这种可操作的提示；否则会被配置类错误盖住。
  var gateMsg = credit.checkGate(userId, model);
  if (gateMsg) {
    return res.status(402).json({ code: 402, message: gateMsg });
  }

  if (!model.ready) {
    return res.status(503).json({ code: 503, message: 'AI 服务未配置完成（' + model.unavailableReason + '），请联系管理员' });
  }

  // 4) 存档用户消息并组装上下文
  insertMessage(convId, 'user', content, effectiveModelId);

  var messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  var history = loadHistory(convId);
  for (var i = 0; i < history.length; i++) {
    messages.push({ role: history[i].role, content: history[i].content });
  }

  // 5) SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  function send(event, data) {
    try {
      res.write('event: ' + event + '\n');
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    } catch (e) { /* 客户端已断开，忽略写入异常 */ }
  }

  send('meta', { conversation_id: convId, model_id: effectiveModelId });

  // 客户端断开检测必须挂在 **res** 上，不能挂 req。
  // 原因：Node 在「请求体读取完毕」时就会触发 req 的 close 事件（IncomingMessage 结束），
  // 与「客户端真的断开」完全不是一回事。挂错地方会导致每个流式请求都被判定为
  // 客户端已离线，从而跳过 res.end()，前端表现为「一直转圈直到超时」。
  var clientGone = false;
  res.on('close', function() {
    if (!res.writableEnded) {
      clientGone = true;
    }
  });

  // 6) 流式生成
  var promptTextForEstimate = messages.map(function(m) { return m.content; }).join('\n');
  var handle = ai.chatStream(model, messages, {
    onDelta: function(text) {
      if (clientGone) return;
      send('delta', { text: text });
    }
  });

  handle.promise.then(function(result) {
    // 7) 存档助手回复
    if (result.text) {
      insertMessage(convId, 'assistant', result.text, effectiveModelId);
    }

    // 8) 记账扣费（余额由流水聚合推导，这里只落明细）
    var usage = extractUsage(result.usage, promptTextForEstimate, result.text);
    var costMicro = pricing.calcCostMicro(model, usage);
    credit.recordUsage({
      user_id: userId,
      conversation_id: convId,
      model_id: effectiveModelId,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cache_hit_tokens: usage.cache_hit_tokens,
      cache_miss_tokens: usage.cache_miss_tokens,
      total_tokens: usage.total_tokens,
      cost_micro: costMicro,
      estimated: usage.estimated
    });

    var state = credit.getState(userId);
    if (!clientGone) {
      send('done', {
        conversation_id: convId,
        cost_micro: costMicro,
        cost_yuan: config.microToYuan(costMicro).toFixed(4),
        balance: {
          available_micro: state.available_micro,
          available_yuan: config.microToYuan(state.available_micro).toFixed(2),
          weekly_remaining_yuan: state.weekly_unlimited ? null : config.microToYuan(state.weekly_remaining_micro).toFixed(2)
        },
        estimated: usage.estimated === 1
      });
    }
    // 无论客户端是否还在，都要收尾：写已结束则跳过，避免重复 end 抛错
    if (!res.writableEnded) res.end();
  }).catch(function(err) {
    console.error('[Chat] 流式调用失败:', err.message, err.detail || '');
    if (!clientGone) {
      send('error', { message: err.message || 'AI 服务暂时不可用，请稍后重试' });
    }
    if (!res.writableEnded) res.end();
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
      // 充值方式提示（线下转账场景，由管理员在后台开通）
      topup_hint: '联系管理员充值'
    }
  });
});

module.exports = router;