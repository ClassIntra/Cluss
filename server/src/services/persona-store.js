// 自定义 AI 人格的存储
//
// 定位：学生在「日常模式」里除了内置的 4 种语气（伙伴 / 幽默 / 元气 / 冷静），
// 还能自己写人格 —— 一个名字 + 一段"希望 AI 用什么口吻"的描述。
//
// 三条设计约束：
//   1. **只描述语气，不改身份**：学生填的文本最终会进 system prompt，
//      所以真正落地时会被 prompt-registry 的 CUSTOM_PERSONA_GUARD 明确降级为"风格描述"，
//      不具备覆盖规则的能力。这里只负责存，不负责放权。
//   2. **按学生隔离**：所有读写都带 user_id，越权拿到别人的 id 也读不到、改不了。
//   3. **有界**：名字与正文都截断，条数也设上限 —— 人格是"常用几套"，
//      不是内容仓库；无上限会让学生的选择器变成一个几百项的列表。
//
// 与 prompt-registry 的分工：
//   prompt-registry 管「内置人格的定义 + 人格段的渲染」（纯函数，不碰库）；
//   这里管「学生自建人格的持久化」。
//   两边通过 id 约定衔接：内置是 'buddy' 这样的字符串，自定义是 'p:<数字>'。

var db = require('../utils/db');
var time = require('../utils/time');
var prompts = require('./prompt-registry');

var MAX_NAME = 20;
// 600 字对一段"人设描述"足够，也能防止有人把整篇文章塞进来当人格
var MAX_PROMPT = 600;
// 单个学生最多建这么多自定义人格
var MAX_COUNT = 20;

function norm(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// 对外 id（'p:12'）→ 数据库主键（12）；非法返回 0
function parseDbId(personaId) {
  var s = String(personaId || '');
  if (!prompts.isCustomPersonaId(s)) return 0;
  return Number(s.slice(s.indexOf(':') + 1)) || 0;
}

function rowToPersona(r) {
  var name = r.name || '';
  var promptText = r.prompt || '';
  // label / desc 是给内置人格用的字段名，这里给自定义人格补上**同名的别名**：
  //   合成列表（内置 + 自定义）在前端只该是一种形状 ——
  //   否则前端每处渲染都要写 `p.label || p.name` 这种按来源分支的兜底，
  //   加第三种来源（比如学校预置人格）时又要再改一遍前端。
  // desc 取人格描述的首行并截断，正好用作选择器里的提示语。
  var firstLine = promptText.split('\n')[0].trim();
  var desc = firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;

  return {
    id: prompts.customPersonaId(r.id),
    name: name,
    label: name,
    prompt: promptText,
    desc: desc,
    builtin: 0,
    created_at: time.toISO(r.created_at),
    updated_at: time.toISO(r.updated_at)
  };
}

// 列出某学生的自定义人格（最近更新的在前）
// 这个结果同时用作 resolvePersona 的 customRecords，所以不带多余字段。
function list(userId) {
  var rows = db.prepare([
    'SELECT id, name, prompt, created_at, updated_at FROM ai_personas',
    'WHERE user_id = ? ORDER BY updated_at DESC, id DESC'
  ].join('\n')).all(String(userId || ''));
  return rows.map(rowToPersona);
}

function getRaw(userId, personaId) {
  var dbId = parseDbId(personaId);
  if (!dbId) return null;
  return db.prepare('SELECT * FROM ai_personas WHERE id = ? AND user_id = ?')
    .get(dbId, String(userId || '')) || null;
}

function count(userId) {
  var row = db.prepare('SELECT COUNT(*) AS n FROM ai_personas WHERE user_id = ?')
    .get(String(userId || ''));
  return row ? Number(row.n) : 0;
}

// 新增
// 返回 { ok:true, persona } 或 { ok:false, message }
function create(userId, input) {
  var uid = String(userId || '');
  if (!uid) return { ok: false, message: '缺少用户' };

  var o = input || {};
  var name = norm(o.name, MAX_NAME);
  var promptText = norm(o.prompt, MAX_PROMPT);

  if (!name) return { ok: false, message: '请给这个人格起个名字' };
  if (!promptText) return { ok: false, message: '请写一段语气描述' };
  if (count(uid) >= MAX_COUNT) {
    return { ok: false, message: '最多只能有 ' + MAX_COUNT + ' 个自定义人格，先删掉一个再建' };
  }
  // 名字不能撞内置人格：不然学生的列表里会出现两个"幽默"，他分不清哪个是哪个
  if (prompts.listPersonas().some(function(p) { return p.label === name; })) {
    return { ok: false, message: '「' + name + '」是内置人格的名字，换一个吧' };
  }

  var now = time.nowUtc();
  try {
    var info = db.prepare([
      'INSERT INTO ai_personas (user_id, name, prompt, builtin, created_at, updated_at)',
      'VALUES (?, ?, ?, 0, ?, ?)'
    ].join('\n')).run(uid, name, promptText, now, now);

    var row = db.prepare('SELECT * FROM ai_personas WHERE id = ?').get(info.lastInsertRowid);
    return { ok: true, persona: rowToPersona(row) };
  } catch (e) {
    // UNIQUE(user_id, name) 命中：这是学生最容易撞的一种，给明确的说法
    if (String(e.message || '').indexOf('UNIQUE') >= 0) {
      return { ok: false, message: '已经有一个叫「' + name + '」的人格了' };
    }
    console.error('[Persona] 新增失败:', e.message);
    return { ok: false, message: '人格保存失败' };
  }
}

// 修改（只允许改自己的；名字与描述都可选）
function update(userId, personaId, input) {
  var row = getRaw(userId, personaId);
  if (!row) return { ok: false, message: '人格不存在' };

  var o = input || {};
  var sets = [];
  var params = [];

  if (o.name !== undefined) {
    var name = norm(o.name, MAX_NAME);
    if (!name) return { ok: false, message: '人格名不能为空' };
    if (prompts.listPersonas().some(function(p) { return p.label === name; })) {
      return { ok: false, message: '「' + name + '」是内置人格的名字，换一个吧' };
    }
    sets.push('name = ?');
    params.push(name);
  }
  if (o.prompt !== undefined) {
    var promptText = norm(o.prompt, MAX_PROMPT);
    if (!promptText) return { ok: false, message: '语气描述不能为空' };
    sets.push('prompt = ?');
    params.push(promptText);
  }

  if (!sets.length) return { ok: false, message: '没有要修改的内容' };

  sets.push('updated_at = ?');
  params.push(time.nowUtc());
  params.push(row.id);

  try {
    var stmt = db.prepare('UPDATE ai_personas SET ' + sets.join(', ') + ' WHERE id = ?');
    stmt.run.apply(stmt, params);
    var fresh = db.prepare('SELECT * FROM ai_personas WHERE id = ?').get(row.id);
    return { ok: true, persona: rowToPersona(fresh) };
  } catch (e) {
    if (String(e.message || '').indexOf('UNIQUE') >= 0) {
      return { ok: false, message: '已经有一个同名的人格了' };
    }
    console.error('[Persona] 更新失败:', e.message);
    return { ok: false, message: '人格保存失败' };
  }
}

// 删除
//
// 注意：会话表 ai_conversations.persona 里可能还留着这个 id。
// 刻意**不**去清理那些会话 ——
//   resolvePersona 找不到记录时会回落成默认语气（'' 段），对话照常能开；
//   而如果这里把会话的 persona 一起改掉，学生只是删了个不想要的人格，
//   却连锁改动了历史会话的语气设定，那是越权替他做决定。
function remove(userId, personaId) {
  var row = getRaw(userId, personaId);
  if (!row) return { ok: false, message: '人格不存在' };
  db.prepare('DELETE FROM ai_personas WHERE id = ? AND user_id = ?').run(row.id, String(userId || ''));
  return { ok: true };
}

module.exports = {
  MAX_NAME: MAX_NAME,
  MAX_PROMPT: MAX_PROMPT,
  MAX_COUNT: MAX_COUNT,
  list: list,
  listForResolve: list,
  create: create,
  update: update,
  remove: remove
};
