// 笔记辅助服务：为"整理 / 续写 / 提炼"组装上下文
//
// 与对话链路的区别（这是本文件的核心）：
//   对话的上下文 = 会话历史 + 附件 + 记忆
//   笔记的上下文 = **相关历史笔记** + **当前正在编辑的内容** + 记忆
//
// "引用相关历史内容"怎么落地：
//   1. 同标签优先：学生自己打的标签是最可靠的主题分类（比从正文猜准得多）
//   2. 关键词补充：用当前笔记标题与正文抽出的词去匹配其它笔记的标题/标签/正文
//   3. 命中数排序，取前几条 —— 相关笔记是"参照"，全量塞进来会喧宾夺主

var db = require('../utils/db');
var cloudStore = require('./cloud-store');

var MAX_RELATED = 3;        // 注入的相关笔记条数
var PER_NOTE_CHARS = 1500;  // 单篇相关笔记截断长度

function parseTags(raw) {
  try {
    var arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(Boolean).map(String) : [];
  } catch (e) {
    return [];
  }
}

// 从标题与正文里抽检索词：中文 2 字滑窗 + 英文词
// 与 memory 的 buildTerms 同思路（简单、可预测、零依赖），
// 但对长正文要限量，否则一篇千字笔记能切出几千个词
function extractTerms(text, limit) {
  var lower = String(text || '').toLowerCase();
  var seen = {};
  var out = [];

  var latin = lower.match(/[a-z0-9]{3,}/g) || [];
  for (var i = 0; i < latin.length && out.length < limit; i++) {
    if (!seen[latin[i]]) { seen[latin[i]] = true; out.push(latin[i]); }
  }

  var cjk = lower.match(/[\u4e00-\u9fa5]+/g) || [];
  for (var c = 0; c < cjk.length && out.length < limit; c++) {
    var seg = cjk[c];
    for (var j = 0; j + 2 <= seg.length && out.length < limit; j++) {
      var w = seg.substr(j, 2);
      if (!seen[w]) { seen[w] = true; out.push(w); }
    }
  }
  return out;
}

// 找出与当前笔记相关的历史笔记
//
// opts: { excludeId } 排除自己（正在编辑的那篇不必再引用一次）
function findRelatedNotes(userId, opts) {
  var o = opts || {};
  var uid = String(userId);
  // 笔记 id 自迁移 018 起是字符串（'note_xxx'）。原来写 Number(o.excludeId) || 0，
  // 字符串 id 会变成 NaN → 0，于是 `id != 0` 对每行都成立：正在编辑的那篇
  // 反而被当成"相关历史笔记"塞回上下文，让模型照着自己的旧稿重写一遍。
  // 没有 excludeId 时用空串：id 是 TEXT 列，空串不会匹配任何一行。
  var excludeId = o.excludeId === null || o.excludeId === undefined
    ? ''
    : String(o.excludeId).trim().slice(0, 64);
  var tags = Array.isArray(o.tags) ? o.tags.filter(Boolean).map(String) : [];
  var title = String(o.title || '');
  var content = String(o.content || '');

  var rows = [];
  try {
    rows = db.prepare([
      'SELECT id, title, tags, file_hash, updated_at FROM cloud_notes',
      'WHERE user_id = ? AND id != ? ORDER BY updated_at DESC LIMIT 60'
    ].join('\n')).all(uid, excludeId);
  } catch (e) {
    return [];
  }
  if (!rows.length) return [];

  // 当前笔记的检索词：标题权重高于正文，所以标题词放进两次
  var terms = extractTerms(title + ' ' + title + ' ' + content.slice(0, 800), 30);

  var scored = [];
  for (var i = 0; i < rows.length; i++) {
    var rowTags = parseTags(rows[i].tags);
    var score = 0;

    // 同标签：每个共同标签记 3 分（标签是学生自己的分类，信号最强）
    for (var t = 0; t < rowTags.length; t++) {
      if (tags.indexOf(rowTags[t]) >= 0) score += 3;
    }

    // 标题命中：每个词 2 分
    var rowTitleLower = String(rows[i].title || '').toLowerCase();
    for (var k = 0; k < terms.length; k++) {
      if (rowTitleLower.indexOf(terms[k]) >= 0) score += 2;
    }

    // 标签命中检索词：每个 1 分
    var tagBlob = rowTags.join(' ').toLowerCase();
    for (var m = 0; m < terms.length; m++) {
      if (tagBlob.indexOf(terms[m]) >= 0) score += 1;
    }

    if (score > 0) scored.push({ row: rows[i], score: score });
  }

  scored.sort(function(a, b) { return b.score - a.score; });
  return scored.slice(0, MAX_RELATED).map(function(s) { return s.row; });
}

// 读一篇笔记的正文（截断）
function readNoteBody(userId, fileHash) {
  var res = cloudStore.readUserFile(fileHash, userId);
  if (res.error) return '';
  var text = res.buffer.toString('utf8');
  if (text.length > PER_NOTE_CHARS) {
    return text.slice(0, PER_NOTE_CHARS) + '\n（……）';
  }
  return text;
}

// 组装"相关历史笔记"文本
// 返回 { text, count }；没有任何相关笔记时 text 为空（调用方据此决定是否注入）
function buildRelatedNotesText(userId, opts) {
  var related = findRelatedNotes(userId, opts);
  if (!related.length) return { text: '', count: 0 };

  var chunks = [];
  for (var i = 0; i < related.length; i++) {
    var body = readNoteBody(userId, related[i].file_hash);
    if (!body) continue;
    chunks.push('### 相关笔记：' + (related[i].title || '未命名笔记') + '\n' + body);
  }
  if (!chunks.length) return { text: '', count: 0 };

  return {
    text: chunks.join('\n\n'),
    count: chunks.length
  };
}

module.exports = {
  MAX_RELATED: MAX_RELATED,
  findRelatedNotes: findRelatedNotes,
  buildRelatedNotesText: buildRelatedNotesText,
  extractTerms: extractTerms
};
