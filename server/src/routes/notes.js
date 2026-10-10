// 云笔记路由：列表 / 保存 / 读取 / 删除 / AI 辅助（整理·续写·提炼）
//
// 存储模型（与云盘一致的内容寻址思想，参考 ClassIntra 的云笔记）：
//   正文（markdown）—— 存为云盘里的 .md 文本文件（cloud_files + cloud_user_files）
//   元数据          —— 存 cloud_notes（标题 / 标签 / 置顶 / 归属）
//
// 为什么正文走云盘而不是塞进数据库字段：
//   用户要求"编写文档并保存在云盘"。走 cloud-store 后笔记与云盘是同一份存储，
//   在云盘页能看到、能下载，配额与去重（同一内容只存一份）也直接复用。
//
// ⚠️ 内容寻址带来的一个反直觉后果（必须理解，否则会写出 bug）：
//   笔记正文改一个字 → hash 变 → 是一份**新的**物理文件；
//   旧的那份若没有别处引用，就在云盘里"沉"了（cloud_files 行被软删）。
//   所以保存笔记时会先写新文件、再把元数据指向新 hash，
//   并顺手把上一版文件的用户引用摘掉（见 saveNote）。
//
// ⚠️ 本项目 foreign_keys=ON：
//   - 插 cloud_notes 前，对应 cloud_files 行必须已存在（先写云盘，再写元数据）
//   - 删除时先删元数据，再交 cloud-store.deleteFile 处理引用与软删

var express = require('express');
var router = express.Router();
var auth = require('../middleware/auth');
var db = require('../utils/db');
var time = require('../utils/time');
var cloudStore = require('../services/cloud-store');
var noteAssist = require('../services/note-assist');
var turnRunner = require('../services/turn-runner');

// 辅助动作的合法取值与交给模型的任务指令
var ASSIST_ACTIONS = {
  organize: '请帮我把下面这篇笔记整理得更清晰（保留我原本的意思与结论，只调整结构与表达）。',
  continue: '请接着下面这篇笔记往下写（沿用它的语气与思路，不要重复已有内容）。',
  summarize: '请从下面这篇笔记里提炼出关键结论（简短几条，便于以后复习）。'
};

// 单篇笔记正文上限：2MB。
// 比云盘单文件上限（10MB）小一个量级 —— 笔记是手写的，正常远不到；
// 卡小一点是为了让"读全文"这条路径无论如何都在可控内存里。
var MAX_NOTE_BYTES = 2 * 1024 * 1024;

var MAX_TITLE = 200;
var MAX_TAGS = 20;

function parseTags(input) {
  if (!Array.isArray(input)) return [];
  var out = [];
  for (var i = 0; i < input.length && out.length < MAX_TAGS; i++) {
    var t = String(input[i] || '').trim();
    // 去重 + 去空，避免标签栏出现一堆空格标签
    if (t && out.indexOf(t) < 0) out.push(t.slice(0, 30));
  }
  return out;
}

function tagsToJson(tags) {
  try {
    return JSON.stringify(tags || []);
  } catch (e) {
    return '[]';
  }
}

// 文件名：用标题做云盘里的显示名（不含路径分隔符，杜绝穿越）
// 标题为空时给一个稳定的默认名，免得云盘里出现一堆无名 .md
function fileNameFor(title, noteId) {
  var t = String(title || '').trim();
  if (!t) t = '未命名笔记';
  // 去掉文件名里不允许的字符（Windows 上 \ / : * ? " < > | 都不行）
  t = t.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  return t + (noteId ? '(' + noteId + ')' : '') + '.md';
}

function rowToNote(row, content) {
  var tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch (e) { tags = []; }
  return {
    id: String(row.id),
    title: row.title || '',
    tags: tags,
    is_pinned: row.is_pinned ? 1 : 0,
    file_hash: row.file_hash,
    type: row.type || 'note',
    // 文件夹 / 画板数据 / 可见性（迁移 018 起）
    folder: row.folder || '默认',
    // canvas_data 只在读取单篇时带上（列表里回会让几十篇笔记一次搬很大 JSON）
    canvas_data: row.canvas_data === undefined ? undefined : (row.canvas_data || ''),
    visibility: row.visibility || 'private',
    // content 只在读取单篇时带上（列表里回全文会让几十篇笔记一次搬几十 KB）
    content: content === undefined ? undefined : content,
    created_at: time.toISO(row.created_at),
    updated_at: time.toISO(row.updated_at)
  };
}

// 笔记 id 自迁移 018 起为客户端生成的字符串（如 'note_xxx'）。
// 旧路由全部按 Number 校验，这里统一换成字符串口径。
function noteIdFromParam(raw) {
  var id = String(raw || '').trim();
  return id ? id.slice(0, 64) : '';
}

// 读某篇笔记的正文（从云盘 .md 文件读回字符串）
function readNoteContent(row, userId) {
  var res = cloudStore.readUserFile(row.file_hash, userId, MAX_NOTE_BYTES);
  if (res.error) return { error: res.error };
  return { content: res.buffer.toString('utf8') };
}

// ============================================================
// GET /api/notes —— 列表（只回元数据，不回正文）
// ============================================================
router.get('/', auth.requireAuth, function(req, res) {
  try {
    var rows = db.prepare([
      'SELECT id, user_id, title, tags, is_pinned, file_hash, type, folder, canvas_data, visibility, created_at, updated_at',
      'FROM cloud_notes WHERE user_id = ?',
      'ORDER BY is_pinned DESC, updated_at DESC'
    ].join('\n')).all(String(req.user.user_id));

    res.json({
      code: 200,
      message: 'ok',
      data: {
        items: rows.map(function(r) {
          var n = rowToNote(r);
          // 列表不回 content，删掉这个字段，免得前端误以为有值
          delete n.content;
          return n;
        })
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: '获取笔记失败' });
  }
});

// ============================================================
// GET /api/notes/search?q= —— 全字段搜索（标题 / 标签 / 正文）
//
// 为什么需要它（而不是继续只让前端过滤）：
//   列表接口刻意不回正文（省流量），前端只能搜标题与标签。
//   但学生最常记住的是"正文里的某句话"——只搜标题标签等于搜不到。
//   正文在云盘里逐篇读回再匹配：单篇上限 2MB、个人笔记规模，
//   这个开销远小于把全量正文推给前端。
//
// ⚠️ 路由顺序：必须定义在 GET /:id 之前，否则 "search" 会被当成 id 匹配。
// ============================================================
router.get('/search', auth.requireAuth, function(req, res) {
  var q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ code: 200, message: 'ok', data: { hits: [] } });

  var userId = String(req.user.user_id);
  try {
    var rows = db.prepare('SELECT id, title, tags, file_hash FROM cloud_notes WHERE user_id = ?').all(userId);
    var hits = [];

    rows.forEach(function(row) {
      var meta = (String(row.title || '') + ' ' + String(row.tags || '')).toLowerCase();
      if (meta.indexOf(q) >= 0) { hits.push({ id: row.id, snippet: '' }); return; }

      var read = cloudStore.readUserFile(row.file_hash, userId, MAX_NOTE_BYTES);
      if (read.error) return; // 正文丢了就不参与搜索（打开时会有明确提示）
      var text = read.buffer.toString('utf8');
      var idx = text.toLowerCase().indexOf(q);
      if (idx < 0) return;

      // 给一小段上下文：列表里直接让"哪句话命中了"可见，
      // 学生扫一眼就能确认是不是要找的笔记（不显示片段等于又要点开试）。
      var start = Math.max(0, idx - 18);
      var end = Math.min(text.length, idx + q.length + 30);
      var snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
      hits.push({ id: row.id, snippet: (start > 0 ? '…' : '') + snippet + (end < text.length ? '…' : '') });
    });

    res.json({ code: 200, message: 'ok', data: { hits: hits } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '搜索失败' });
  }
});

// ============================================================
// ClassIntra 笔记契约的兼容路由（/api/notes/notes、/api/notes/folders...）
//
// 笔记前端整体照搬自 ClassIntra（画板 / 批注 / 文件夹 / 分栏），
// 它调的是 ClassIntra 应用壳的路由形状。为免改动照搬来的前端，
// 这里按同一形状再包一层，落到 Cluss 自己的存储模型上：
//   元数据 → cloud_notes（id 为客户端生成的字符串）
//   正文   → 云盘 .md（内容寻址，配额与去重复用）
// ⚠️ 这些路由与上面的 GET /search 一样，必须定义在 GET /:id 之前。
// ============================================================

// GET /api/notes/notes —— 云端列表（含 folder / canvas_data / visibility）
router.get('/notes', auth.requireAuth, function(req, res) {
  try {
    var notes = db.prepare([
      'SELECT id, user_id, title, tags, is_pinned, file_hash, type, folder, canvas_data, visibility, created_at, updated_at',
      'FROM cloud_notes WHERE user_id = ?',
      'ORDER BY is_pinned DESC, updated_at DESC'
    ].join('\n')).all(String(req.user.user_id));
    for (var i = 0; i < notes.length; i++) {
      try { notes[i].tags = JSON.parse(notes[i].tags || '[]'); } catch (e) { notes[i].tags = []; }
      notes[i].id = String(notes[i].id);
      notes[i].folder = notes[i].folder || '默认';
      notes[i].visibility = notes[i].visibility || 'private';
      notes[i].created_at = time.toISO(notes[i].created_at);
      notes[i].updated_at = time.toISO(notes[i].updated_at);
    }
    res.json({ code: 200, message: 'ok', data: notes });
  } catch (e) {
    res.status(500).json({ code: 500, message: '获取笔记失败' });
  }
});

// GET /api/notes/notes/public —— 公开笔记（全班可见）
router.get('/notes/public', auth.requireAuth, function(req, res) {
  try {
    var notes = db.prepare([
      'SELECT n.*, u.net_name FROM cloud_notes n',
      'LEFT JOIN users u ON n.user_id = u.user_id',
      "WHERE n.visibility = 'public'",
      'ORDER BY n.updated_at DESC LIMIT 100'
    ].join('\n')).all();
    for (var i = 0; i < notes.length; i++) {
      try { notes[i].tags = JSON.parse(notes[i].tags || '[]'); } catch (e) { notes[i].tags = []; }
      notes[i].id = String(notes[i].id);
      notes[i].folder = notes[i].folder || '默认';
      notes[i].visibility = notes[i].visibility || 'private';
      notes[i].created_at = time.toISO(notes[i].created_at);
      notes[i].updated_at = time.toISO(notes[i].updated_at);
    }
    res.json({ code: 200, message: 'ok', data: notes });
  } catch (e) {
    res.status(500).json({ code: 500, message: '获取公开笔记失败' });
  }
});

// GET /api/notes/notes/:id —— 读取单篇（本人或公开可见）
router.get('/notes/:id', auth.requireAuth, function(req, res) {
  var id = noteIdFromParam(req.params.id);
  if (!id) return res.status(400).json({ code: 400, message: '笔记 ID 无效' });
  try {
    var row = db.prepare('SELECT * FROM cloud_notes WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ code: 404, message: '笔记不存在' });
    var isOwner = String(row.user_id) === String(req.user.user_id);
    if (!isOwner && row.visibility !== 'public') {
      return res.status(403).json({ code: 403, message: '无权限查看此笔记' });
    }
    // 本人：走自己的云盘引用读正文；公开笔记的他人访问：
    // 作者已主动共享，正文按 hash 直读（调用方已确认 visibility='public'）
    var read = isOwner
      ? readNoteContent(row, req.user.user_id)
      : cloudStore.readFileByHash(row.file_hash, MAX_NOTE_BYTES);
    if (read.error) {
      return res.status(410).json({ code: 410, message: '笔记正文已丢失（云盘文件不存在）：' + read.error });
    }
    res.json({ code: 200, message: 'ok', data: rowToNote(row, read.content || read.buffer.toString('utf8')) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '获取笔记失败' });
  }
});

// POST /api/notes/notes —— 上传 / 更新云端笔记（客户端 id 为主键）
router.post('/notes', auth.requireAuth, function(req, res) {
  var b = req.body || {};
  var userId = String(req.user.user_id);
  var id = noteIdFromParam(b.id);
  if (!id) return res.status(400).json({ code: 400, message: '缺少笔记ID' });

  var title = String(b.title || '').trim().slice(0, MAX_TITLE);
  var content = String(b.content || '');
  var tags = parseTags(b.tags);
  var folder = String(b.folder || '默认').trim().slice(0, 30) || '默认';
  var visibility = b.visibility === 'public' ? 'public' : 'private';
  var isPinned = b.is_pinned ? 1 : 0;
  var canvasData = String(b.canvas_data || '').slice(0, 4 * 1024 * 1024); // 画板 JSON 上限 4MB
  var noteType = b.type === 'draw' ? 'draw' : 'note';

  var bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_NOTE_BYTES) {
    return res.status(413).json({ code: 413, message: '笔记内容过大（上限 ' + Math.round(MAX_NOTE_BYTES / 1024 / 1024) + 'MB）' });
  }

  try {
    var existing = db.prepare('SELECT * FROM cloud_notes WHERE id = ?').get(id);
    if (existing && String(existing.user_id) !== userId) {
      return res.status(403).json({ code: 403, message: '该ID已被占用' });
    }

    // 正文走云盘（内容寻址）：与旧保存路径同一套去重 / 配额 / 沉文件清理
    var buf = Buffer.from(content.length ? content : ' ', 'utf8');
    var saved = cloudStore.saveFile(userId, {
      name: fileNameFor(title, id),
      mime: 'text/markdown',
      buffer: buf
    });
    if (!saved.ok) {
      var status = saved.quota_exceeded ? 413 : 400;
      return res.status(status).json({ code: status, message: saved.message });
    }
    var newHash = saved.file.hash;
    var now = time.nowUtc();

    var tx = db.transaction(function() {
      if (existing) {
        db.prepare([
          'UPDATE cloud_notes SET title = ?, tags = ?, is_pinned = ?, file_hash = ?, type = ?,',
          'folder = ?, canvas_data = ?, visibility = ?, updated_at = ? WHERE id = ? AND user_id = ?'
        ].join('\n')).run(title, tagsToJson(tags), isPinned, newHash, noteType, folder, canvasData, visibility, now, id, userId);
      } else {
        db.prepare([
          'INSERT INTO cloud_notes (id, user_id, title, tags, is_pinned, file_hash, type,',
          ' folder, canvas_data, visibility, created_at, updated_at)',
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ].join('\n')).run(id, userId, title, tagsToJson(tags), isPinned, newHash, noteType, folder, canvasData, visibility, now, now);
      }
    });
    tx();

    // 元数据已指向新 hash，摘掉上一版文件的引用（失败只留孤儿，不报错）
    if (existing && existing.file_hash && existing.file_hash !== newHash) {
      try { cloudStore.deleteFile(existing.file_hash, userId); } catch (e) { /* 留待孤儿清理 */ }
    }

    res.json({ code: 200, message: '保存成功' });
  } catch (e) {
    console.error('[Notes] 上传云端失败:', e.message);
    res.status(500).json({ code: 500, message: '保存失败' });
  }
});

// DELETE /api/notes/notes/:id —— 从云端删除（仅本人）
router.delete('/notes/:id', auth.requireAuth, function(req, res) {
  var id = noteIdFromParam(req.params.id);
  if (!id) return res.status(400).json({ code: 400, message: '笔记 ID 无效' });
  var userId = String(req.user.user_id);
  try {
    var row = db.prepare('SELECT * FROM cloud_notes WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) return res.status(404).json({ code: 404, message: '笔记不存在' });

    db.prepare('DELETE FROM cloud_notes WHERE id = ? AND user_id = ?').run(id, userId);
    try { cloudStore.deleteFile(row.file_hash, userId); } catch (e) {
      console.warn('[Notes] 删除正文文件失败:', e.message);
    }
    res.json({ code: 200, message: '删除成功' });
  } catch (e) {
    res.status(500).json({ code: 500, message: '删除失败' });
  }
});

// PATCH /api/notes/notes/:id/visibility —— 公开 / 私密
router.patch('/notes/:id/visibility', auth.requireAuth, function(req, res) {
  var id = noteIdFromParam(req.params.id);
  if (!id) return res.status(400).json({ code: 400, message: '笔记 ID 无效' });
  var visibility = req.body && req.body.visibility === 'public' ? 'public' : 'private';
  var userId = String(req.user.user_id);
  try {
    var info = db.prepare(
      "UPDATE cloud_notes SET visibility = ?, updated_at = ? WHERE id = ? AND user_id = ?"
    ).run(visibility, time.nowUtc(), id, userId);
    if (!info.changes) return res.status(404).json({ code: 404, message: '笔记不存在' });
    res.json({ code: 200, message: '可见性已更新' });
  } catch (e) {
    res.status(500).json({ code: 500, message: '更新失败' });
  }
});

// PATCH /api/notes/notes/:id/folder —— 移动到文件夹
router.patch('/notes/:id/folder', auth.requireAuth, function(req, res) {
  var id = noteIdFromParam(req.params.id);
  if (!id) return res.status(400).json({ code: 400, message: '笔记 ID 无效' });
  var folder = String((req.body && req.body.folder) || '默认').trim().slice(0, 30) || '默认';
  var userId = String(req.user.user_id);
  try {
    var info = db.prepare(
      'UPDATE cloud_notes SET folder = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).run(folder, time.nowUtc(), id, userId);
    if (!info.changes) return res.status(404).json({ code: 404, message: '笔记不存在' });
    res.json({ code: 200, message: '文件夹已更新' });
  } catch (e) {
    res.status(500).json({ code: 500, message: '更新失败' });
  }
});

// GET /api/notes/folders —— 文件夹清单
router.get('/folders', auth.requireAuth, function(req, res) {
  try {
    var folders = db.prepare('SELECT * FROM cloud_note_folders WHERE user_id = ? ORDER BY name').all(String(req.user.user_id));
    for (var i = 0; i < folders.length; i++) {
      folders[i].id = String(folders[i].id);
      folders[i].created_at = time.toISO(folders[i].created_at);
    }
    res.json({ code: 200, message: 'ok', data: folders });
  } catch (e) {
    res.status(500).json({ code: 500, message: '获取文件夹失败' });
  }
});

// POST /api/notes/folders —— 新建文件夹
router.post('/folders', auth.requireAuth, function(req, res) {
  var name = String((req.body && req.body.name) || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ code: 400, message: '文件夹名称不能为空' });
  try {
    db.prepare('INSERT OR IGNORE INTO cloud_note_folders (user_id, name) VALUES (?, ?)').run(String(req.user.user_id), name);
    res.json({ code: 200, message: '创建成功' });
  } catch (e) {
    res.status(500).json({ code: 500, message: '创建失败' });
  }
});

// DELETE /api/notes/folders/:id —— 删除文件夹（其中笔记回到「默认」）
router.delete('/folders/:id', auth.requireAuth, function(req, res) {
  var fid = noteIdFromParam(req.params.id);
  var userId = String(req.user.user_id);
  try {
    var folder = db.prepare('SELECT * FROM cloud_note_folders WHERE id = ?').get(fid);
    if (!folder) return res.status(404).json({ code: 404, message: '文件夹不存在' });
    if (String(folder.user_id) !== userId) return res.status(403).json({ code: 403, message: '无权限删除' });
    db.prepare("UPDATE cloud_notes SET folder = '默认' WHERE user_id = ? AND folder = ?").run(userId, folder.name);
    db.prepare('DELETE FROM cloud_note_folders WHERE id = ?').run(fid);
    res.json({ code: 200, message: '删除成功' });
  } catch (e) {
    res.status(500).json({ code: 500, message: '删除失败' });
  }
});

// ============================================================
// GET /api/notes/:id —— 读取单篇（含正文）
// ============================================================
router.get('/:id', auth.requireAuth, function(req, res) {
  var id = noteIdFromParam(req.params.id);
  if (!id) return res.status(400).json({ code: 400, message: '笔记 ID 无效' });

  try {
    var row = db.prepare('SELECT * FROM cloud_notes WHERE id = ? AND user_id = ?')
      .get(id, String(req.user.user_id));
    if (!row) return res.status(404).json({ code: 404, message: '笔记不存在' });

    var read = readNoteContent(row, req.user.user_id);
    if (read.error) {
      // 正文所指向的云盘文件没了：笔记记录还在，但内容取不回来。
      // 给学生一句能行动的话，而不是"读取失败"这种没信息的错误。
      return res.status(410).json({ code: 410, message: '笔记正文已丢失（云盘文件不存在）：' + read.error });
    }

    res.json({ code: 200, message: 'ok', data: { note: rowToNote(row, read.content) } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '获取笔记失败' });
  }
});

// ============================================================
// POST /api/notes —— 新建或保存
//
// body: { id?, title, content, tags[], is_pinned }
// 有 id 视为更新已有笔记；无 id 则新建。
// ============================================================
router.post('/', auth.requireAuth, function(req, res) {
  var b = req.body || {};
  var userId = String(req.user.user_id);

  var title = String(b.title || '').trim().slice(0, MAX_TITLE);
  var content = String(b.content || '');
  var tags = parseTags(b.tags);
  var isPinned = b.is_pinned ? 1 : 0;

  // 内容字节数按 UTF-8 算：中文一个字 3 字节，用 length 会低估三倍
  var bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_NOTE_BYTES) {
    return res.status(413).json({
      code: 413,
      message: '笔记内容过大（上限 ' + Math.round(MAX_NOTE_BYTES / 1024 / 1024) + 'MB）'
    });
  }

  var id = noteIdFromParam(b.id); // 迁移 018 起为字符串 id
  var existing = null;
  if (id) {
    existing = db.prepare('SELECT * FROM cloud_notes WHERE id = ? AND user_id = ?').get(id, userId);
    if (!existing) return res.status(404).json({ code: 404, message: '笔记不存在' });
  }

  // 1) 先把正文写进云盘（拿到 hash 才能写元数据）
  //    空笔记也允许保存（新建时常见），但要保证文件不为空 —— 云盘拒绝空文件，
  //    所以给个占位空格，避免"新建后立刻保存"失败这种莫名其妙的报错。
  var buf = Buffer.from(content.length ? content : ' ', 'utf8');
  var saved = cloudStore.saveFile(userId, {
    name: fileNameFor(title, existing ? existing.id : 0),
    mime: 'text/markdown',
    buffer: buf
  });

  if (!saved.ok) {
    // 配额不足要原样透出（cloud-store 已给出含已用/共用的文案）
    var status = saved.quota_exceeded ? 413 : 400;
    return res.status(status).json({ code: status, message: saved.message });
  }

  var newHash = saved.file.hash;
  var now = time.nowUtc();

  try {
    var tx = db.transaction(function() {
      if (existing) {
        db.prepare([
          'UPDATE cloud_notes SET title = ?, tags = ?, is_pinned = ?, file_hash = ?, updated_at = ?',
          'WHERE id = ? AND user_id = ?'
        ].join('\n')).run(title, tagsToJson(tags), isPinned, newHash, now, existing.id, userId);
      } else {
        var info = db.prepare([
          'INSERT INTO cloud_notes (user_id, title, tags, is_pinned, file_hash, type, created_at, updated_at)',
          'VALUES (?, ?, ?, ?, ?, \'note\', ?, ?)'
        ].join('\n')).run(userId, title, tagsToJson(tags), isPinned, newHash, now, now);
        id = info.lastInsertRowid;
      }
    });
    tx();
  } catch (e) {
    console.error('[Notes] 写数据库失败:', e.message);
    return res.status(500).json({ code: 500, message: '笔记保存失败' });
  }

  // 2) 元数据已指向新 hash，把上一版正文文件的引用摘掉。
  //    这一步必须在事务提交后做：元数据的 file_hash 已经不再指向旧文件，
  //    此时解引用不会让笔记"指向不存在的文件"。
  //    失败只记日志 —— 云盘里多留一份旧文件不影响使用，不该让保存失败。
  if (existing && existing.file_hash && existing.file_hash !== newHash) {
    try {
      cloudStore.deleteFile(existing.file_hash, userId);
    } catch (e) {
      console.warn('[Notes] 清理上一版正文失败:', e.message);
    }
  }

  res.json({
    code: 200,
    message: '已保存',
    data: {
      id: id,
      title: title,
      tags: tags,
      is_pinned: isPinned,
      file_hash: newHash,
      // 云盘里这份 .md 的访问地址，前端可据此跳到云盘
      url: '/api/cloud/files/' + newHash,
      updated_at: time.toISO(now)
    }
  });
});

// ============================================================
// DELETE /api/notes/:id
// 顺序：先删元数据 → 再删云盘引用（引用归零时 cloud-store 会软删文件）
// ============================================================
router.delete('/:id', auth.requireAuth, function(req, res) {
  var id = noteIdFromParam(req.params.id);
  if (!id) return res.status(400).json({ code: 400, message: '笔记 ID 无效' });

  var userId = String(req.user.user_id);
  try {
    var row = db.prepare('SELECT * FROM cloud_notes WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) return res.status(404).json({ code: 404, message: '笔记不存在' });

    db.prepare('DELETE FROM cloud_notes WHERE id = ? AND user_id = ?').run(id, userId);

    // 正文文件：删掉用户在云盘里的这份引用。
    // 失败不影响"笔记已删除"这个事实，只记日志 —— 清理不干净最多是云盘里留个孤儿文件。
    try {
      cloudStore.deleteFile(row.file_hash, userId);
    } catch (e) {
      console.warn('[Notes] 删除正文文件失败:', e.message);
    }

    res.json({ code: 200, message: '已删除', data: null });
  } catch (e) {
    res.status(500).json({ code: 500, message: '删除失败' });
  }
});

// ============================================================
// PATCH /api/notes/:id/pin —— 置顶 / 取消置顶
// 单独立出来是因为置顶不该改正文：走 POST 保存会重写一份 .md（见内容寻址说明）
// ============================================================
router.patch('/:id/pin', auth.requireAuth, function(req, res) {
  var id = noteIdFromParam(req.params.id);
  if (!id) return res.status(400).json({ code: 400, message: '笔记 ID 无效' });

  var pinned = req.body && req.body.is_pinned ? 1 : 0;
  try {
    var info = db.prepare(
      'UPDATE cloud_notes SET is_pinned = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).run(pinned, time.nowUtc(), id, String(req.user.user_id));
    if (!info.changes) return res.status(404).json({ code: 404, message: '笔记不存在' });

    res.json({ code: 200, message: pinned ? '已置顶' : '已取消置顶', data: null });
  } catch (e) {
    res.status(500).json({ code: 500, message: '更新失败' });
  }
});

// ============================================================
// PATCH /api/notes/:id/tags —— 只改标签（不动正文）
//
// 为什么单独一条：正文保存走 POST 会重写一份 .md（内容寻址，见文件头说明），
// 而"加一个标签"是高频小动作，不该触发正文路径与"未保存修改"的整套拦截。
// 置顶（/pin）已是"元数据即时生效"的同一模式，标签保持一致：
// 改完立刻落库，列表、标签栏与搜索马上能看到 —— 而不是等学生再点一次保存。
// ============================================================
router.patch('/:id/tags', auth.requireAuth, function(req, res) {
  var id = noteIdFromParam(req.params.id);
  if (!id) return res.status(400).json({ code: 400, message: '笔记 ID 无效' });

  var tags = parseTags(req.body && req.body.tags);
  try {
    var info = db.prepare(
      'UPDATE cloud_notes SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).run(tagsToJson(tags), time.nowUtc(), id, String(req.user.user_id));
    if (!info.changes) return res.status(404).json({ code: 404, message: '笔记不存在' });

    res.json({ code: 200, message: '标签已更新', data: { tags: tags } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '更新失败' });
  }
});

// ============================================================
// POST /api/notes/assist —— 笔记 AI 辅助（整理 / 续写 / 提炼）
//
// body: { action, title, content, tags[], note_id? }
//
// 上下文与对话链路刻意不同（见 services/note-assist.js）：
//   对话 = 会话历史 + 附件
//   笔记 = 相关历史笔记 + 当前正在编辑的内容
// 这里把"相关历史内容"与"当前编辑内容"一起交给模型，它才能接着学生的思路写，
// 而不是另起一套说法。
//
// 走 turn-runner 而不是自己调 AI：闸门、流式、记账、会话存档那一套必须复用，
// 否则笔记辅助会变成一条不受额度约束的旁路。
// ============================================================
router.post('/assist', auth.requireAuth, function(req, res) {
  var b = req.body || {};
  var action = String(b.action || '').trim();
  if (!ASSIST_ACTIONS[action]) {
    return res.status(400).json({ code: 400, message: '未知的辅助动作' });
  }

  var content = String(b.content || '');
  if (!content.trim()) {
    return res.status(400).json({ code: 400, message: '笔记还是空的，先写点什么' });
  }

  var title = String(b.title || '').trim().slice(0, 200);
  var tags = parseTags(b.tags);
  var userId = req.user.user_id;

  // 相关历史笔记：按标签与关键词找，最多 3 篇（详见 note-assist）
  // excludeId 走字符串口径：迁移 018 起笔记 id 是客户端生成的字符串，
  // 经过 Number() 会变成 NaN，正在编辑的那篇就会被当成"相关笔记"读回来。
  var related = noteAssist.buildRelatedNotesText(userId, {
    excludeId: noteIdFromParam(b.note_id),
    tags: tags,
    title: title,
    content: content
  });

  // 正文组装：任务指令 → 当前笔记 → 相关历史笔记
  // 顺序有讲究：任务在前（模型先知道要做什么），当前内容紧随（主体），
  // 历史笔记垫后（参照物）。反过来会让模型把参照当主体。
  var parts = [ASSIST_ACTIONS[action]];
  parts.push('');
  parts.push('【我正在写的笔记】' + (title ? '（标题：' + title + '）' : ''));
  parts.push(content.slice(0, 6000));

  if (related.text) {
    parts.push('');
    parts.push('【我以前写过的相关笔记】（供参考，不要照搬，也不要把它们的内容混进结论）');
    parts.push(related.text);
  }

  // 笔记辅助复用一条固定会话，而不是每次新建一个：
  //   1) 不污染"我的对话"——列表按 mode 过滤（study / daily），这条的 mode 是 'note'
  //   2) 不累积垃圾——每次辅助都新建会话的话，整理十次就多十条永远看不到的记录
  //   3) 历史还能用——同一条会话内，上一轮整理的结果下一轮看得到
  var assistConvId = ensureAssistConversation(userId);

  turnRunner.runStreamTurn({
    req: req,
    res: res,
    userId: userId,
    content: parts.join('\n'),
    modelId: String(b.model_id || ''),
    conversation: { id: assistConvId, mode: 'note', study_style: 'direct' },
    attachmentHashes: [],
    noteIds: [],
    task: { kind: '' },
    source: 'note_assist'
  });
});

// 确保笔记辅助的专用会话存在（不存在则建一条）
//
// 为什么自己 INSERT 而不用 ensureConversation：
//   后者在 id 查不到时会**忽略传入的 id**、另生成一个随机 id，
//   那样就达不到"固定复用一条"的目的（见 conversation-core.js:78）。
function ensureAssistConversation(userId) {
  var id = 'note_assist_' + String(userId);
  try {
    var row = db.prepare('SELECT id FROM ai_conversations WHERE id = ? AND user_id = ?')
      .get(id, String(userId));
    if (row) return row.id;

    db.prepare([
      'INSERT INTO ai_conversations (id, user_id, title, model_id, mode, study_style, persona, created_at, updated_at)',
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ].join('\n')).run(
      id, String(userId), '笔记辅助', '', 'note', 'direct', '', time.nowUtc(), time.nowUtc()
    );
    return id;
  } catch (e) {
    // 建不出来就退回"新建会话"：辅助功能仍然可用，只是会多一条记录
    console.warn('[Notes] 辅助会话创建失败，退回临时会话:', e.message);
    return '';
  }
}

module.exports = router;
