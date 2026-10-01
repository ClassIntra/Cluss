// 会话与消息存取 + SSE 写入器
//
// 从原 chat.js 抽出的公共部分：会话的兜底创建、消息的读写、SSE 的安全写入。
// 抽出的动机：对话页与学习页都要用，复制一份必然漂移。

var db = require('../utils/db');
var time = require('../utils/time');
var constants = require('../utils/constants');

// 上下文默认条数：过大会让每轮成本快速上升，且低端设备渲染历史也更慢
var DEFAULT_CONTEXT_MESSAGES = 20;

// 取会话（限定归属人，防越权读别人的会话）
function getConversation(convId, userId) {
  return db.prepare(
    'SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?'
  ).get(String(convId), String(userId)) || null;
}

// 标题自动取首条消息前 20 字
function autoTitle(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '新对话';
  return t.length > 20 ? t.slice(0, 20) + '…' : t;
}

// 依据会话的 mode 字段推断自动标题（拍题时用任务名更清楚）
function deriveTitle(opts) {
  var o = opts || {};
  if (o.titleFrom) return autoTitle(o.titleFrom);
  if (o.taskKind === 'grade') return '作业批改';
  if (o.taskKind === 'solve') return '拍题解答';
  return '新对话';
}

// 确保会话存在：传入的 id 有效则复用，否则新建
// opts: { id, modelId, mode, studyStyle, titleFrom, taskKind }
function ensureConversation(userId, opts) {
  var o = opts || {};
  var uid = String(userId);

  if (o.id) {
    var existing = getConversation(o.id, uid);
    if (existing) {
      // 允许在已存在的会话上更新模型与模式（前端切换后立即生效）
      var patch = [];
      var params = [];
      if (o.modelId && o.modelId !== existing.model_id) {
        patch.push('model_id = ?');
        params.push(String(o.modelId));
      }
      if (o.mode && o.mode !== existing.mode) {
        patch.push('mode = ?');
        params.push(String(o.mode));
      }
      if (o.studyStyle && o.studyStyle !== existing.study_style) {
        patch.push('study_style = ?');
        params.push(String(o.studyStyle));
      }
      if (patch.length) {
        patch.push('updated_at = ?');
        params.push(time.nowUtc());
        params.push(existing.id);
        var stmt = db.prepare('UPDATE ai_conversations SET ' + patch.join(', ') + ' WHERE id = ?');
        stmt.run.apply(stmt, params);
        existing = getConversation(existing.id, uid);
      }
      return existing;
    }
  }

  var id = constants.randomId('c_');
  var now = time.nowUtc();
  db.prepare([
    'INSERT INTO ai_conversations (id, user_id, title, model_id, mode, study_style, created_at, updated_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(
    id, uid,
    deriveTitle(o),
    String(o.modelId || ''),
    String(o.mode || 'study'),
    String(o.studyStyle || 'guided'),
    now, now
  );
  return getConversation(id, uid);
}

// 更新会话的模式设置
function updateConversationMode(convId, userId, mode, studyStyle) {
  var conv = getConversation(convId, userId);
  if (!conv) return null;

  var sets = ['updated_at = ?'];
  var params = [time.nowUtc()];
  if (mode) { sets.push('mode = ?'); params.push(String(mode)); }
  if (studyStyle) { sets.push('study_style = ?'); params.push(String(studyStyle)); }
  params.push(conv.id);

  var stmt = db.prepare('UPDATE ai_conversations SET ' + sets.join(', ') + ' WHERE id = ?');
  stmt.run.apply(stmt, params);
  return getConversation(conv.id, userId);
}

// 追加一条消息
// opts: { attachments: [{hash,name,mime,size,kind}], source: 'chat'|'study'|'solve'|'grade' }
function appendMessage(convId, role, content, modelId, opts) {
  var o = opts || {};
  var attachmentsJson = '[]';
  if (o.attachments && o.attachments.length) {
    try { attachmentsJson = JSON.stringify(o.attachments); } catch (e) { attachmentsJson = '[]'; }
  }

  var info = db.prepare([
    'INSERT INTO ai_messages (conversation_id, role, content, model_id, attachments, source, created_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(
    String(convId), String(role), String(content || ''),
    String(modelId || ''), attachmentsJson, String(o.source || 'chat'), time.nowUtc()
  );

  db.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?')
    .run(time.nowUtc(), String(convId));

  return info.lastInsertRowid;
}

// 读取用于组装上下文的历史消息（取最近 N 条，按时间正序返回）
// 只返回 role 与 content —— 历史消息的附件不回填图片（见 context-builder）
function loadContextMessages(convId, limit) {
  var n = Number(limit || DEFAULT_CONTEXT_MESSAGES);
  var rows = db.prepare([
    'SELECT role, content, attachments FROM ai_messages',
    'WHERE conversation_id = ? ORDER BY id DESC LIMIT ?'
  ].join('\n')).all(String(convId), n);
  rows.reverse();
  return rows;
}

// 列出会话（可按模式过滤：'study' | 'daily' | '' 全部）
function listConversations(userId, mode, limit) {
  var n = Math.min(Number(limit || 100), 300);
  if (mode) {
    return db.prepare([
      'SELECT id, title, model_id, mode, study_style, created_at, updated_at FROM ai_conversations',
      'WHERE user_id = ? AND mode = ? ORDER BY updated_at DESC LIMIT ?'
    ].join('\n')).all(String(userId), String(mode), n);
  }
  return db.prepare([
    'SELECT id, title, model_id, mode, study_style, created_at, updated_at FROM ai_conversations',
    'WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?'
  ].join('\n')).all(String(userId), n);
}

// 序列化会话为前端格式
function serializeConversation(r) {
  return {
    id: r.id,
    title: r.title,
    model_id: r.model_id,
    mode: r.mode || 'study',
    study_style: r.study_style || 'guided',
    created_at: time.toISO(r.created_at),
    updated_at: time.toISO(r.updated_at)
  };
}

// 序列化消息为前端格式（attachments 反序列化）
function serializeMessage(m) {
  var attachments = [];
  try { attachments = JSON.parse(m.attachments || '[]'); } catch (e) { attachments = []; }
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model_id: m.model_id,
    attachments: attachments,
    source: m.source || 'chat',
    created_at: time.toISO(m.created_at)
  };
}

// 删除会话及其消息
function deleteConversation(convId, userId) {
  var conv = getConversation(convId, userId);
  if (!conv) return false;
  db.prepare('DELETE FROM ai_messages WHERE conversation_id = ?').run(conv.id);
  db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(conv.id);
  return true;
}

// ------------------------------------------------------------
// SSE 写入器
//
// 封装三件容易写错的事：
//   1. close 必须挂 res 不挂 req
//      —— Node 在「请求体读完」时就触发 req 的 close，与「客户端真的断开」不是一回事。
//         挂错地方会把每个流式请求都判成客户端离线，从而跳过 res.end()，
//         前端表现为「一直转圈直到超时」。（v0.1 踩过这个坑）
//   2. writableEnded 判重，避免重复 end 抛错
//   3. 写入失败不抛异常（客户端已断开是正常情况）
// ------------------------------------------------------------
function createSseWriter(req, res) {
  var clientGone = false;

  res.on('close', function() {
    if (!res.writableEnded) clientGone = true;
  });

  function send(event, data) {
    if (clientGone || res.writableEnded) return false;
    try {
      res.write('event: ' + event + '\n');
      res.write('data: ' + JSON.stringify(data) + '\n\n');
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    send: send,
    isClientGone: function() { return clientGone || res.writableEnded; },
    headers: function() {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // 关掉 Nginx 一类反向代理的缓冲，否则流式会被攒成一坨再下发
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.flushHeaders) res.flushHeaders();
    },
    close: function() {
      if (!res.writableEnded) {
        try { res.end(); } catch (e) { /* 已断开，忽略 */ }
      }
    }
  };
}

module.exports = {
  DEFAULT_CONTEXT_MESSAGES: DEFAULT_CONTEXT_MESSAGES,
  getConversation: getConversation,
  ensureConversation: ensureConversation,
  updateConversationMode: updateConversationMode,
  appendMessage: appendMessage,
  loadContextMessages: loadContextMessages,
  listConversations: listConversations,
  serializeConversation: serializeConversation,
  serializeMessage: serializeMessage,
  deleteConversation: deleteConversation,
  autoTitle: autoTitle,
  createSseWriter: createSseWriter
};