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

// 读取单个会话（含隐藏判定）。
// 返回 null = 对调用方表现为"不存在"（未解锁时故意与真 404 同形）。
function getConversationForRead(convId, userId, unlocked) {
  var row = getConversation(convId, userId);
  if (!row) return null;
  if (Number(row.hidden) === 1 && !unlocked) return null;
  return row;
}

// 隐藏 / 取消隐藏。返回 { ok, hidden, message }
function setHidden(convId, userId, hidden) {
  var row = getConversation(convId, userId);
  if (!row) return { ok: false, message: '会话不存在' };
  var next = hidden ? 1 : 0;
  if (Number(row.hidden) === next) {
    return { ok: true, hidden: !!next, message: next ? '已经是隐藏状态' : '本来就没隐藏' };
  }
  db.prepare('UPDATE ai_conversations SET hidden = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(next, time.nowUtc(), String(convId), String(userId));
  return { ok: true, hidden: !!next, message: next ? '已隐藏' : '已取消隐藏' };
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
// opts: { id, modelId, mode, studyStyle, persona, dailyStyle, titleFrom, taskKind }
function ensureConversation(userId, opts) {
  var o = opts || {};
  var uid = String(userId);

  if (o.id) {
    var existing = getConversation(o.id, uid);
    if (existing) {
      // 本次会话**最终生效的模式**：客户端传了 mode 就用它，没传就沿用已存的。
      //
      // 人格与无限制风格都只在日常模式下有意义，判据取这个"最终模式"、
      // 而不是"本次是否传了 mode" —— 否则前端只切风格却没带 mode 时，
      // 会被误判成非日常而把学生的改动丢掉。判定放在这一层，
      // 是因为只有这里同时看得到"客户端想设什么"和"会话本来是什么"。
      var resultingMode = o.mode ? String(o.mode) : String(existing.mode || 'study');

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
      // persona / daily_style 的写入规则（三条不能少）：
      //   1. undefined 表示"别动这一列" —— 学习链路不传，避免把日常设定清掉；
      //   2. '' 是**有效值**，表示"明确回到默认人格 / 回到受限"，必须落库
      //      （所以判空用 !== undefined，与 mode/studyStyle 的"非空才写"不同）；
      //   3. 值由调用方归一化（prompt-registry.normalizePersona / normalizeDailyStyle）。
      // 且只在日常模式写入：非日常时不覆盖，学生从日常切到学习再切回来，设定还在。
      if (o.persona !== undefined && resultingMode === 'daily' && o.persona !== existing.persona) {
        patch.push('persona = ?');
        params.push(String(o.persona));
      }
      if (o.dailyStyle !== undefined && resultingMode === 'daily'
          && o.dailyStyle !== (existing.daily_style || '')) {
        patch.push('daily_style = ?');
        params.push(String(o.dailyStyle));
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
  var modeStr = String(o.mode || 'study');
  // 新建时也只在日常模式写入 persona / daily_style，与 patch 分支保持一致：
  // 两条路径的判据必须一样，否则"新建的日常会话带着人格、改成学习再改回来"这类
  // 跨路径操作会出现前后不一致的存储结果，而表现成"人格时有时无"。
  db.prepare([
    'INSERT INTO ai_conversations (id, user_id, title, model_id, mode, study_style, persona, daily_style, created_at, updated_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(
    id, uid,
    deriveTitle(o),
    String(o.modelId || ''),
    modeStr,
    String(o.studyStyle || 'guided'),
    modeStr === 'daily' ? String(o.persona || '') : '',
    modeStr === 'daily' ? String(o.dailyStyle || '') : '',
    now, now
  );
  return getConversation(id, uid);
}

// 更新会话的模式设置
// dailyStyle 只在显式传入时生效（同 persona 的三条规则）
function updateConversationMode(convId, userId, mode, studyStyle, dailyStyle) {
  var conv = getConversation(convId, userId);
  if (!conv) return null;

  var sets = ['updated_at = ?'];
  var params = [time.nowUtc()];
  if (mode) { sets.push('mode = ?'); params.push(String(mode)); }
  if (studyStyle) { sets.push('study_style = ?'); params.push(String(studyStyle)); }
  if (dailyStyle !== undefined) { sets.push('daily_style = ?'); params.push(String(dailyStyle)); }
  params.push(conv.id);

  var stmt = db.prepare('UPDATE ai_conversations SET ' + sets.join(', ') + ' WHERE id = ?');
  stmt.run.apply(stmt, params);
  return getConversation(conv.id, userId);
}

// 来源清单的落库形态：没有就存空串（绝大多数消息都没有来源，别用 '[]' 撑大库）
function sourcesJson(v) {
  if (!v || !v.length) return '';
  try { return JSON.stringify(v); } catch (e) { return ''; }
}

// 追加一条消息
// opts: { attachments: [{hash,name,mime,size,kind}], source: 'chat'|'study'|'solve'|'grade',
//         streaming: 1 表示"正在生成"（占位行，随后会被增量更新）,
//         sources: 联网搜索的来源清单（见 027 迁移） }
function appendMessage(convId, role, content, modelId, opts) {
  var o = opts || {};
  var attachmentsJson = '[]';
  if (o.attachments && o.attachments.length) {
    try { attachmentsJson = JSON.stringify(o.attachments); } catch (e) { attachmentsJson = '[]'; }
  }

  var info = db.prepare([
    'INSERT INTO ai_messages (conversation_id, role, content, model_id, attachments, source, streaming, sources, created_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(
    String(convId), String(role), String(content || ''),
    String(modelId || ''), attachmentsJson, String(o.source || 'chat'),
    o.streaming ? 1 : 0, sourcesJson(o.sources), time.nowUtc()
  );

  db.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?')
    .run(time.nowUtc(), String(convId));

  return info.lastInsertRowid;
}

// 更新一条消息的正文（流式增量落库 / 收尾定稿都用它）
//
// 为什么单独一个函数而不是就地 UPDATE：正文的**唯一写入口**在 turn-runner，
// 但"最后一笔"和"中途每一笔"必须是同一条 SQL，否则迟早出现两者写法漂移
// （比如一处忘了清 streaming，那条消息就永远显示成"生成中"）。
//
// opts: { streaming: 0|1, sources: [...] } —— 不传表示不动这一列
function updateMessageContent(msgId, content, opts) {
  var o = opts || {};
  var sets = ['content = ?'];
  var params = [String(content || '')];
  if (o.streaming !== undefined) {
    sets.push('streaming = ?');
    params.push(o.streaming ? 1 : 0);
  }
  if (o.sources !== undefined) {
    sets.push('sources = ?');
    params.push(sourcesJson(o.sources));
  }
  params.push(Number(msgId));

  var stmt = db.prepare('UPDATE ai_messages SET ' + sets.join(', ') + ' WHERE id = ?');
  stmt.run.apply(stmt, params);
}

// 删除一条消息。用于「一个字都没生成」的占位收摊：
// 直接留着会变成一条空白的 AI 气泡，比"什么都没发生"更像坏了。
function deleteMessage(msgId) {
  db.prepare('DELETE FROM ai_messages WHERE id = ?').run(Number(msgId));
}

// 会话里已落库的消息总数（含流式占位行之外的全部历史）
//
// 用途：给前端的「上下文状态」算分母 —— 学生想知道的不是"这一轮送了多少 token"，
// 而是"AI 还记得我们前面聊的多少条"。只有拿到会话总条数才回答得了这个问题。
// 只数 streaming=0 的行：正在生成的那半条不算"已聊过的历史"。
function countMessages(convId) {
  var row = db.prepare([
    'SELECT COUNT(*) AS n FROM ai_messages',
    'WHERE conversation_id = ? AND streaming = 0'
  ].join('\n')).get(String(convId));
  return Number(row && row.n || 0);
}

// 读取用于组装上下文的历史消息（取最近 N 条，按时间正序返回）
// 只返回 role 与 content —— 历史消息的附件不回填图片（见 context-builder）
function loadContextMessages(convId, limit) {
  var n = Number(limit || DEFAULT_CONTEXT_MESSAGES);
  var rows = db.prepare([
    'SELECT role, content, attachments FROM ai_messages',
    // 排除 streaming=1 的占位行：那是**这一轮正在写**的半成品，
    // 把它当历史喂回去，模型会以为"自己上一句还没说完"
    'WHERE conversation_id = ? AND streaming = 0 ORDER BY id DESC LIMIT ?'
  ].join('\n')).all(String(convId), n);
  rows.reverse();
  return rows;
}

// ---- 会话列表：游标分页 + 搜索 + 预览 ----
//
// 为什么必须分页：原实现是 `LIMIT min(limit || 100, 300)` —— 硬上限 300。
// 第 301 个会话**永久不可见**，而且前端察觉不到（它只看到"列表到头了"）。
// 一个天天用的学生，几个月就会撞上这个天花板。
//
// 为什么游标是 (updated_at, id) 而不是 offset：
//   updated_at 只精确到秒，同一秒建/改的多个会话用它排序不稳定；
//   而列表按 updated_at 动态排序，用 OFFSET 还会在翻页期间"漏条/重复"。
//   带上 id 做次级键，既稳定又能用上 idx_conv_user(user_id, updated_at DESC)。
//
// 预览与条数用**相关子查询**一条 SQL 带出，不做 N+1（列表 30 条就是 30 次额外查询）。

var LIST_COLS = [
  'c.id, c.title, c.model_id, c.mode, c.study_style, c.persona, c.daily_style,',
  'c.created_at, c.updated_at, COALESCE(c.hidden, 0) AS hidden,',
  // 最后一条**有内容**的助手消息作为预览：比取最后一条消息更有信息量
  //（最后一条往往就是学生刚问的那句话，等于没预览）
  '(SELECT substr(m.content, 1, 200) FROM ai_messages m',
  '   WHERE m.conversation_id = c.id AND m.role = ? AND m.content <> ?',
  '   ORDER BY m.id DESC LIMIT 1) AS preview,',
  '(SELECT COUNT(*) FROM ai_messages mc WHERE mc.conversation_id = c.id) AS msg_count'
].join('\n');

function encodeCursor(row) {
  if (!row) return '';
  return String(row.updated_at || '') + '|' + String(row.id || '');
}

function parseCursor(raw) {
  var s = String(raw || '');
  var i = s.lastIndexOf('|');
  if (i <= 0) return null;
  var at = s.slice(0, i);
  var id = s.slice(i + 1);
  if (!at || !id) return null;
  return { at: at, id: id };
}

/**
 * 列出会话。
 * @param {string} userId
 * @param {{mode?:string, q?:string, limit?:number, cursor?:string}} opts
 * @returns {{rows:Array, next_cursor:string, has_more:boolean}}
 */
function listConversations(userId, opts) {
  var o = opts || {};
  var mode = String(o.mode || '');
  var q = String(o.q || '').trim();
  var limit = Math.min(Math.max(Number(o.limit || 30), 1), 100);
  var cur = parseCursor(o.cursor);

  // 隐藏会话：默认**不带出**。includeHidden 只有"已解锁"的调用方才会传 true
  // （chat 路由按 private-lock 的解锁态决定），隐藏内容对没解锁的人
  // 表现为"这条会话不存在"——而不是"有一条但你看不了"。
  var includeHidden = !!o.includeHidden;

  // ⚠️ params 必须**严格按 SQL 里占位符出现的顺序**推进来：
  //    LIST_COLS 的两个（role / content<>）在最前，然后是 WHERE 的各条件，
  //    最后是 LIMIT。之前把顺序写乱过一次，症状是列表莫名其妙少了几条 ——
  //    这种错不会报 SQL 异常，只会静默返回错的结果集。
  var params = ['assistant', ''];
  var where = [];

  where.push('c.user_id = ?');
  params.push(String(userId));

  if (!includeHidden) {
    // COALESCE 兜底：迁移 029 之前建的会话没有 hidden 列值时当作未隐藏
    where.push('COALESCE(c.hidden, 0) = 0');
  }

  if (mode) {
    where.push('c.mode = ?');
    params.push(String(mode));
  }

  if (q) {
    // 标题命中，或**任意一条消息**命中。
    // ⚠️ LIKE '%x%' 用不上索引，这里是有意接受的权衡：单用户会话量级是几百，
    //    真到几万条该上 FTS5。写成注释是为了让后来者知道这不是疏忽。
    var like = '%' + q.replace(/[%_\\]/g, function (m) { return '\\' + m; }) + '%';
    where.push([
      "(c.title LIKE ? ESCAPE '\\'",
      ' OR EXISTS (SELECT 1 FROM ai_messages ms WHERE ms.conversation_id = c.id',
      "            AND ms.content LIKE ? ESCAPE '\\'))"
    ].join('\n'));
    params.push(like, like);
  }

  if (cur) {
    // 严格小于游标；updated_at 只到秒，相同时用 id 兜底，否则同秒创建的会话会翻页漏条
    where.push('(c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))');
    params.push(cur.at, cur.at, cur.id);
  }

  // 多取一条用于判断 has_more，省掉一次 COUNT
  params.push(limit + 1);

  var sql = 'SELECT ' + LIST_COLS + '\nFROM ai_conversations c\nWHERE ' + where.join(' AND ') +
    '\nORDER BY c.updated_at DESC, c.id DESC\nLIMIT ?';

  var stmt = db.prepare(sql);
  var rows = stmt.all.apply(stmt, params);
  var hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);

  return {
    rows: rows,
    has_more: hasMore,
    next_cursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : ''
  };
}

// 序列化会话为前端格式
//
// preview / msg_count 只有列表查询（LIST_COLS）才会带出来；
// 单条会话的查询是 `SELECT *`，没有这两列，所以必须给默认值 ——
// 否则前端拿到 undefined 会把侧栏预览渲染成字符串 "undefined"。
function serializeConversation(r) {
  return {
    id: r.id,
    title: r.title,
    model_id: r.model_id,
    mode: r.mode || 'study',
    study_style: r.study_style || 'guided',
    persona: r.persona || '',
    // daily_style：'' = 受限（默认）| 'free' = 无限制。仅日常模式有意义。
    daily_style: r.daily_style || '',
    // 列表预览：最后一条**有内容**的助手消息前 200 字（原始 markdown）。
    // 前端按纯文本展示，不要再走 markdown 渲染 —— 侧栏是一行窄文本，
    // 渲染出公式/代码块只会把布局撑坏，而且 30 条同时渲染公式会明显掉帧。
    preview: String(r.preview || '').replace(/\s+/g, ' ').trim(),
    msg_count: Number(r.msg_count || 0),
    // 隐藏标记：只有 includeHidden 拉回来的列表才可能有 hidden=1 的项，
    // 前端据此给隐藏会话打标识。默认列表永远不带它（服务端已过滤），
    // 所以这个字段对没解锁的调用方恒为 0，不额外透露信息。
    hidden: Number(r.hidden || 0) === 1 ? 1 : 0,
    created_at: time.toISO(r.created_at),
    updated_at: time.toISO(r.updated_at)
  };
}

// 序列化消息为前端格式（attachments 反序列化）
function serializeMessage(m) {
  var attachments = [];
  try { attachments = JSON.parse(m.attachments || '[]'); } catch (e) { attachments = []; }
  var sources = [];
  try { sources = JSON.parse(m.sources || '[]'); } catch (e) { sources = []; }
  if (!Array.isArray(sources)) sources = [];
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model_id: m.model_id,
    attachments: attachments,
    // 联网搜索的来源（[n] 对应回答里的引用编号），没有就是空数组
    sources: sources,
    source: m.source || 'chat',
    // 1 = 这一轮还在生成（前端据此轮询，见 019 迁移的说明）
    streaming: m.streaming ? 1 : 0,
    created_at: time.toISO(m.created_at)
  };
}

// ---- "生成中"占位行的收敛 ----
//
// 什么时候会留下 streaming=1 的行：
//   1. 进程在生成途中被杀（PM2 reload / 崩溃 / 断电）—— 再也不会有人把它改回 0。
//      前端 Chat.vue 的 pollServerStream 正是靠 streaming 判断"是否还在写"，
//      于是它会**永远**每 1.5 秒轮询一次；学生每次打开这个会话都看到"正在生成中…"。
//      这种最讨厌：界面不报错，内容却永远不会出现。
//   2. 同一会话并发跑了两轮（正常已被 turn-runner 的在途锁拦住，这里是兜底）。
//
// 处置规则与单条收尾**完全一致**（这是重点，两处规则漂移就会出现
// "手动停止留正文、重启却把正文删了"这类莫名其妙的不一致）：
//   有正文 → 只清 streaming（学生看到多少就留多少）
//   没正文 → 删掉（留一条空气泡比"什么都没发生"更像坏了）
//
// settleStreamingMessages  收敛某一个会话（开新一轮之前调用）
// settleAllStreamingMessages  收敛全库（进程启动时调用，此时确定没有活的生成者）
function settleRows(rows) {
  if (!rows.length) return { total: rows.length, kept: 0, dropped: 0 };
  var clear = db.prepare('UPDATE ai_messages SET streaming = 0 WHERE id = ?');
  var drop = db.prepare('DELETE FROM ai_messages WHERE id = ?');
  var kept = 0;
  var dropped = 0;
  var run = db.transaction(function() {
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].content || '').trim()) { clear.run(rows[i].id); kept++; }
      else { drop.run(rows[i].id); dropped++; }
    }
  });
  run();
  return { total: rows.length, kept: kept, dropped: dropped };
}

function settleStreamingMessages(convId) {
  var rows = db.prepare(
    'SELECT id, content FROM ai_messages WHERE conversation_id = ? AND streaming = 1'
  ).all(String(convId));
  return settleRows(rows);
}

function settleAllStreamingMessages() {
  var rows = db.prepare('SELECT id, content FROM ai_messages WHERE streaming = 1').all();
  return settleRows(rows);
}

// 删除会话及其消息
//
// 两条 DELETE 必须同事务。原实现是两条独立语句：要是第二条（删会话本身）失败，
// 消息已经被删掉了 —— 留下一个**空壳会话**（标题在、点进去一条消息都没有），
// 学生只会看到"历史全没了"而不知道发生了什么。有了事务，要么都成功要么都回滚。
//
// 顺带校验 affected 行数：better-sqlite3 的 run() 返回 { changes }。
// 拿它当"真的删到了"的证据，而不是只凭 getConversation 事先查到了就宣布成功 ——
// 两次查询之间会话可能已被另一路请求删掉（同一账号多标签页很常见）。
//
// 刻意**不**动的两处（是决定，不是疏漏）：
//   1. cluss_usage_log：计费流水，属于审计记录。学生删会话不该抹掉"这轮花了多少"，
//      否则管理员对不上账。它本来就是软引用（conversation_id DEFAULT ''）。
//   2. wrong_questions / writing_pieces：错题与作文是学生自己的资产，
//      会话只是它们的**来源**。删来源不等于要毁掉资产，留着比连坐删除更不容易伤到人。
function deleteConversation(convId, userId) {
  var conv = getConversation(convId, userId);
  if (!conv) return false;

  var delMsgs = db.prepare('DELETE FROM ai_messages WHERE conversation_id = ?');
  var delConv = db.prepare('DELETE FROM ai_conversations WHERE id = ? AND user_id = ?');

  var run = db.transaction(function(id, uid) {
    var m = delMsgs.run(id);
    var c = delConv.run(id, uid);
    return { messages: m.changes, conversation: c.changes };
  });

  var out = run(conv.id, String(userId));
  return out.conversation > 0;
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
  updateMessageContent: updateMessageContent,
  deleteMessage: deleteMessage,
  loadContextMessages: loadContextMessages,
  countMessages: countMessages,
  listConversations: listConversations,
  getConversationForRead: getConversationForRead,
  setHidden: setHidden,
  serializeConversation: serializeConversation,
  serializeMessage: serializeMessage,
  settleStreamingMessages: settleStreamingMessages,
  settleAllStreamingMessages: settleAllStreamingMessages,
  deleteConversation: deleteConversation,
  autoTitle: autoTitle,
  createSseWriter: createSseWriter
};
