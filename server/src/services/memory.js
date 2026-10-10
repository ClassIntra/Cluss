// 跨会话记忆：关键笔记事实与学生偏好的持久化、检索与增量更新
//
// 定位（与 cloud_notes 的分工，见 migrations/013 的说明）：
//   笔记 = 学生自己写的文档（长文，给人看，正文在云盘 .md）
//   记忆 = 系统沉淀的碎片事实（一两句话，给模型看，存在这里）
//
// 三条设计约束：
//   1. **增量更新**：同 key 再写一次是覆盖，不是追加。一条事实永远只有一份最新表述。
//   2. **检索是关键词级别的**：不做向量、不引依赖。学生规模是一个班，
//      LIKE 检索几百条绰绰有余，引入向量库是为一个不存在的规模提前背复杂度。
//   3. **注入要克制**：记忆只在与当前提问相关时才进上下文，
//      全量塞进去既费 token 又会让模型把陈年旧事当成当前语境。

var db = require('../utils/db');
var time = require('../utils/time');

var MAX_KEY = 80;
var MAX_CONTENT = 2000;
var MAX_TAGS = 200;
// 单次注入的条数上限：记忆是"提示"不是"资料"，多了会喧宾夺主
var MAX_INJECT = 8;

// ------------------------------------------------------------
// 记忆分类（决定"什么时候该被带上"）
// ------------------------------------------------------------
// 类别由 key 的前缀识别（memory-extractor 写记忆时约定用「类别_主题」作 key）。
// 为什么需要分类：不同类别的记忆**生效范围**完全不同 ——
//
//   · 偏好与习惯：对**每一轮回答**都该生效。学生问「解这个方程」时一句话里
//     不会出现"讲解风格"三个字，纯关键词检索**永远命中不了**它 ——
//     于是"依据偏好动态调整"这件事在实现上其实是失效的。所以这一类改为**常驻注入**。
//   · 学业/情绪/个人情况：只在相关话题出现时才有用，靠检索命中即可。
//
// ⚠️ 前缀是约定不是约束：学生自己记的、或早期写的记忆可能没有标准前缀，
//    categoryOf 会退化为"整串里找关键词"，再不行归到 other（照常参与检索，只是不常驻）。
//
// 这份词表必须与**写入端**对齐 —— memory-extractor 的 EXTRACT_SYSTEM 里
// 明确规定了模型只能从「偏好 / 学习 / 情绪 / 事实」里选类别词。
// 两侧一起改，否则新出现的类别词会静默掉进 other、丢掉常驻资格。
var CATEGORIES = [
  {
    id: 'preference', label: '偏好与习惯',
    prefixes: ['偏好', '习惯', '交流', '风格', '口味', '喜欢', '爱好', '性格', '作息']
  },
  {
    id: 'emotion', label: '情绪与状态',
    prefixes: ['情绪', '心情', '状态', '压力', '心态']
  },
  {
    id: 'academic', label: '学业情况',
    prefixes: ['学业', '学习', '科目', '目标', '错题', '薄弱', '考试', '成绩']
  },
  {
    id: 'fact', label: '个人情况',
    prefixes: ['事实', '生活', '家庭', '兴趣', '健康', '人际', '朋友', '社交', '特长', '经历']
  }
];
var CATEGORY_OTHER = { id: 'other', label: '其它记录', prefixes: [] };

// 常驻类别：不管这一轮问什么，都带上（上限 ALWAYS_MAX 条）
var ALWAYS_CATEGORIES = ['preference'];
var ALWAYS_MAX = 3;

// 把 key 归到某个类别 id
function categoryOf(key) {
  var k = String(key == null ? '' : key);
  if (!k) return CATEGORY_OTHER.id;

  // ① 先看前缀段（`偏好_讲解风格` → `偏好`）
  var head = k.split(/[_-]/)[0] || '';
  for (var i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i].prefixes.indexOf(head) >= 0) return CATEGORIES[i].id;
  }
  // ② 再退化到"整串里含关键词"（兼容没有规范前缀的旧记忆）
  for (var j = 0; j < CATEGORIES.length; j++) {
    for (var p = 0; p < CATEGORIES[j].prefixes.length; p++) {
      if (k.indexOf(CATEGORIES[j].prefixes[p]) >= 0) return CATEGORIES[j].id;
    }
  }
  return CATEGORY_OTHER.id;
}

function categoryLabel(id) {
  for (var i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i].id === id) return CATEGORIES[i].label;
  }
  return CATEGORY_OTHER.label;
}

// 去掉 key 里已经表达过的类别前缀（`偏好_讲解风格` → `讲解风格`），
// 避免注入时出现「偏好与习惯：偏好_讲解风格：……」这种重复。
function stripCategoryPrefix(key) {
  var k = String(key == null ? '' : key);
  var idx = k.search(/[_-]/);
  if (idx > 0 && idx < k.length - 1) {
    var head = k.slice(0, idx);
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].prefixes.indexOf(head) >= 0) return k.slice(idx + 1);
    }
  }
  return k;
}

function normText(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// 记忆键归一化：只保留中英文数字与下划线，空格转下划线
// 为什么归一：前端可能传「数学 薄弱」也可能传「数学_薄弱」，
// 不归一就会存成两条互相打架的记忆
function normKey(v) {
  return String(v == null ? '' : v)
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .slice(0, MAX_KEY);
}

// ------------------------------------------------------------
// 写入（增量更新）
// ------------------------------------------------------------
// 返回 { ok, id, updated } 或 { ok:false, message }
// updated=true 表示覆盖了同 key 的旧内容（即真正的"增量更新"）
function upsert(userId, opts) {
  var o = opts || {};
  var uid = String(userId || '');
  var key = normKey(o.key);
  var content = normText(o.content, MAX_CONTENT);

  if (!uid) return { ok: false, message: '缺少用户' };
  if (!key) return { ok: false, message: '记忆键不能为空' };
  if (!content) return { ok: false, message: '记忆内容不能为空' };

  var source = ['auto', 'user', 'note'].indexOf(String(o.source || '')) >= 0
    ? String(o.source) : 'auto';
  var tags = normText(o.tags, MAX_TAGS);
  var now = time.nowUtc();

  try {
    // 先探一次是否存在：SQLite 的 ON CONFLICT 拿不到"这次是新增还是覆盖"，
    // 而这个信息对前端反馈与审计都有用（"已更新"和"已记住"是两种预期）
    var existing = db.prepare('SELECT id FROM memories WHERE user_id = ? AND key = ?').get(uid, key);

    db.prepare([
      'INSERT INTO memories (user_id, key, content, source, tags, created_at, updated_at)',
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
      'ON CONFLICT(user_id, key) DO UPDATE SET',
      '  content = excluded.content,',
      '  source = excluded.source,',
      '  tags = excluded.tags,',
      '  updated_at = excluded.updated_at'
    ].join('\n')).run(uid, key, content, source, tags, now, now);

    var row = db.prepare('SELECT id FROM memories WHERE user_id = ? AND key = ?').get(uid, key);
    return { ok: true, id: row ? row.id : 0, updated: !!existing, key: key };
  } catch (e) {
    console.error('[Memory] 写入失败:', e.message);
    return { ok: false, message: '记忆保存失败' };
  }
}

function remove(userId, key) {
  var info = db.prepare('DELETE FROM memories WHERE user_id = ? AND key = ?')
    .run(String(userId || ''), normKey(key));
  return { ok: info.changes > 0 };
}

// ------------------------------------------------------------
// 读取与检索
// ------------------------------------------------------------
function rowToMemory(r) {
  return {
    id: r.id,
    key: r.key,
    content: r.content,
    source: r.source || 'auto',
    tags: r.tags || '',
    created_at: time.toISO(r.created_at),
    updated_at: time.toISO(r.updated_at)
  };
}

function listMemories(userId, opts) {
  var o = opts || {};
  var limit = Math.min(Math.max(Number(o.limit) || 50, 1), 200);
  var rows = db.prepare([
    'SELECT id, user_id, key, content, source, tags, created_at, updated_at',
    'FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?'
  ].join('\n')).all(String(userId || ''), limit);
  return rows.map(rowToMemory);
}

// 关键词检索：命中 key / content / tags 任一即算命中
//
// 分词策略刻意简单：中文按 2 字滑窗切（"三角函数" → "三角""角函""函数"），
// 英文与数字按空白/标点切。取命中数的排序，命中越多越靠前。
// 这不是一个好检索系统，但对"几十到几百条记忆、关键词短"的场景足够，
// 且零依赖、行为可预测（出问题时能一眼看出为什么没命中）。
function searchMemories(userId, query, opts) {
  var o = opts || {};
  var limit = Math.min(Math.max(Number(o.limit) || MAX_INJECT, 1), 50);
  var q = String(query || '').trim();
  if (!q) return [];

  var terms = buildTerms(q);
  if (!terms.length) return [];

  var rows = listMemories(userId, { limit: 200 });
  var scored = [];
  for (var i = 0; i < rows.length; i++) {
    var hay = (rows[i].key + ' ' + rows[i].content + ' ' + rows[i].tags).toLowerCase();
    var hit = 0;
    for (var t = 0; t < terms.length; t++) {
      if (hay.indexOf(terms[t]) >= 0) hit++;
    }
    if (hit > 0) scored.push({ memory: rows[i], hit: hit });
  }

  scored.sort(function(a, b) {
    if (b.hit !== a.hit) return b.hit - a.hit;
    return String(b.memory.updated_at).localeCompare(String(a.memory.updated_at));
  });

  return scored.slice(0, limit).map(function(s) { return s.memory; });
}

function buildTerms(q) {
  var out = [];
  var seen = {};
  var lower = String(q).toLowerCase();

  // 英文/数字：按非字母数字切
  var latin = lower.match(/[a-z0-9]{2,}/g) || [];
  for (var i = 0; i < latin.length; i++) {
    if (!seen[latin[i]]) { seen[latin[i]] = true; out.push(latin[i]); }
  }

  // 中文：连续汉字段内做 2 字滑窗
  var cjk = lower.match(/[\u4e00-\u9fa5]+/g) || [];
  for (var c = 0; c < cjk.length; c++) {
    var seg = cjk[c];
    if (seg.length <= 2) {
      if (!seen[seg]) { seen[seg] = true; out.push(seg); }
      continue;
    }
    for (var j = 0; j + 2 <= seg.length; j++) {
      var w = seg.substr(j, 2);
      if (!seen[w]) { seen[w] = true; out.push(w); }
    }
  }
  return out;
}

// ------------------------------------------------------------
// 注入上下文
// ------------------------------------------------------------
// 选出这一轮要交给模型的记忆。三路合并：
//   ① **常驻**：偏好/习惯类。它们对每一轮回答都生效，且**不可能被关键词命中**
//      （学生问「解这个方程」时不会提到"讲解风格"）—— 靠检索等于永远不生效。
//   ② **相关**：按关键词命中的具体事实（学业/情绪/个人情况）。
//   ③ **兜底**：开场（没有 query）或两条路都没结果时，给最近更新的几条，
//      宁可给一点背景，也不要完全无记忆；但必须是**少量**，否则开场白会被旧事污染。
//
// 顺序刻意是"常驻在前"：它们的语义更底层，且相对稳定，
// 放在前面能让这一段的开头更固定（对上游前缀缓存友好）。
function selectForContext(userId, query, limit) {
  var max = Math.min(Math.max(Number(limit) || MAX_INJECT, 1), MAX_INJECT);
  var rows = listMemories(userId, { limit: 200 });   // 已按 updated_at DESC
  if (!rows.length) return [];

  var always = [];
  for (var i = 0; i < rows.length && always.length < ALWAYS_MAX; i++) {
    if (ALWAYS_CATEGORIES.indexOf(categoryOf(rows[i].key)) >= 0) always.push(rows[i]);
  }

  var q = String(query || '').trim();
  var picked = q ? searchMemories(userId, q, { limit: max }) : [];

  if (!picked.length && !always.length) {
    picked = rows.slice(0, Math.min(max, 3));
  }

  var out = [];
  var seen = {};
  function add(m) {
    if (!m || seen[m.key]) return;
    seen[m.key] = 1;
    out.push(m);
  }
  for (var a = 0; a < always.length; a++) add(always[a]);
  for (var b = 0; b < picked.length; b++) add(picked[b]);
  return out.slice(0, max);
}

// 拼成注入文本。三件事必须同时说清，少一件就会翻车：
//   ① **可以用** —— 只写"当背景"时模型会把它束之高阁，"你记得他"这件事
//      就永远体现不到对话里（这正是旧版本的问题）；
//   ② **别硬用** —— 但放开之后模型容易为了显得记得而生搬硬套，
//      学生问数学题却扯出他的作息，那是跑题不是关心；
//   ③ **可能过时** —— 不说明的话模型会把三个月前的偏好当成当下事实。
//
// 按类别分组：让模型一眼看清"哪些是长期偏好（每一轮都生效）、
// 哪些是具体事实（只在相关话题下才用）"。分组标签只在超过一类时出现，
// 单类记忆平白多一层缩进没有意义。
function buildMemorySection(memories) {
  if (!memories || !memories.length) return '';

  var order = [];
  var groups = {};
  for (var i = 0; i < memories.length; i++) {
    var cid = categoryOf(memories[i].key);
    if (!groups[cid]) { groups[cid] = []; order.push(cid); }
    groups[cid].push(memories[i]);
  }
  // 常驻类别（偏好）排最前：与 selectForContext 的顺序保持一致
  order.sort(function (a, b) {
    var ia = ALWAYS_CATEGORIES.indexOf(a);
    var ib = ALWAYS_CATEGORIES.indexOf(b);
    if (ia >= 0 && ib < 0) return -1;
    if (ib >= 0 && ia < 0) return 1;
    return 0;
  });

  var grouped = order.length > 1;
  var lines = [];
  for (var g = 0; g < order.length; g++) {
    if (grouped) lines.push('- ' + categoryLabel(order[g]) + '：');
    for (var j = 0; j < groups[order[g]].length; j++) {
      var m = groups[order[g]][j];
      lines.push((grouped ? '  · ' : '- ') + stripCategoryPrefix(m.key) + '：' + m.content);
    }
  }

  return [
    '',
    '【关于这个学生的长期记忆】（跨会话保留，来自他过去的对话与笔记）',
    lines.join('\n'),
    '用法：',
    '1. **他聊到相关的事时自然用上**：他问物理，你已经知道他对受力分析发怵，就从那里切进去；',
    '   他状态不好，你知道他最近压力大，语气就跟着调。这正是"你记得他"的意义。',
    '2. 但**别为了显得记得而生搬硬套**：「我记得你说过……」只在真相关时用，不要每次都用；',
    '   他问一道数学题你扯出他的作息，那是跑题不是关心。',
    // 实测缺口（glm53f 真实采样）：学生说「随便聊聊」，回的是
    // 「刚考完试的人这会儿是放松了还是有点闲得发慌？」—— 把记忆里的考试压力
    // 硬套到一句闲聊上。它看起来像关心，实际是**把他没说的事端了出来**，
    // 学生没提考试，却被告知"我知道你在考试"，感受更接近被盯着。
    // 所以这里不止要禁"用错"，还要禁"主动用"：记忆是调整语气用的，不是用来展示的。
    '   **他闲聊、打招呼、只是随口说说时，不要主动提起记忆里的任何事** ——',
    '   记忆是用来调整你**怎么说话**的（用词、举例、语气的分寸），不是用来向他证明你记得什么。',
    '   反面例子：「随便聊聊吧」→「刚考完试的人这会儿是放松了还是有点闲得发慌？」',
    '   那句把他没提的考试端了出来，读起来像关心，实际是"我知道你在考试"的压迫感。',
    '3. 可能已经过时：他若说了相反的话，以**他现在的说法**为准，不要拿旧记忆反驳他。',
    '4. 不要把这些记忆原样念给他听。'
  ].join('\n');
}

module.exports = {
  MAX_INJECT: MAX_INJECT,
  upsert: upsert,
  remove: remove,
  listMemories: listMemories,
  searchMemories: searchMemories,
  selectForContext: selectForContext,
  buildMemorySection: buildMemorySection,
  normKey: normKey,
  // 分类相关的内部件对外暴露，仅供验证脚本断言（业务代码不用）
  categoryOf: categoryOf,
  categoryLabel: categoryLabel,
  stripCategoryPrefix: stripCategoryPrefix,
  CATEGORIES: CATEGORIES,
  ALWAYS_CATEGORIES: ALWAYS_CATEGORIES,
  _internal: { buildTerms: buildTerms }
};
