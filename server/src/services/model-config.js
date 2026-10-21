// 模型配置统一下发（设计文档 cluss-cloud-design.md §5，v1 核心）
//
// 动机：多班之后各节点的 ai_models / ai_sources 各自为政，改一次模型要进
// 每个班的后台。统一下发后「中枢改一处，全网一分钟内生效」。
//
// 快照内容（§5.2）：ai_models 全表 + ai_sources 全表 + 视觉转述配置 + 全局峰谷。
//   - ai_sources 必须随行：模型行的 source_id 引用源表，漏了源就是
//     「节点上的模型悄悄解析不到地址」；
//   - 全局峰谷必须随行：模型级 has_offpeak=1 且峰窗留空时回退全局值，
//     而计费发生在节点本地——两边全局配置不同，账就静默漂移；
//   - cloud_quota_bytes 不随行：云盘占用是节点本地的，与计费口径无关。
//
// 同步哲学与「余额不落库」一致：配置就几条、几 KB，不做增量，**整表替换**
// 最不易漂移。幂等性由版本号保证（见 services/sync.js 的轮询对比）。
//
// 版本号存 cluss_meta（key = model_config_version），中继侧管理台每次
// 改动模型/源/视觉/峰谷后 bump（routes/admin.js 的 bumpModelVersion）。

var db = require('../utils/db');
var initDb = require('../utils/init-db');

// 随配置下发的 cluss_meta 键（§5.2：视觉转述配置必须随行）
var SYNC_META_KEYS = [
  'vision_enabled',
  'vision_relay_model_id',
  'vision_max_images',
  'image_max_edge',
  'image_quality',
  'image_shrink_enabled',
  // 全局峰谷（模型级峰窗留空时节点本地计费的回退值）
  'offpeak_enabled',
  'offpeak_peak_windows',
  'offpeak_discount_bp'
];

// ai_models 快照列（001 + 003 + 014 + 022 的全部业务列）。
// 显式列出而非 SELECT *：跨版本混跑时，节点比中继新/旧都不会被未知列噎住。
var MODEL_COLUMNS = [
  'id', 'label', 'api_url', 'api_key', 'model_name', 'api_style',
  'supports_thinking', 'supports_stream',
  'supports_vision', 'vision_max_images',
  'price_in', 'price_out', 'price_cache_hit',
  'is_free', 'enabled', 'is_default', 'sort_order', 'created_at',
  'price_multiplier_bp', 'free_until',
  'source_id', 'has_offpeak', 'offpeak_peak_windows', 'offpeak_discount_bp',
  // 迁移 032：这一条是否进入下发快照。它是**范围**而不是配置内容，
  // 但必须随行 —— 席位班上行时会带回来，否则中枢侧的勾选会在一次上行后被抹平。
  'sync_enabled'
];

var SOURCE_COLUMNS = [
  'id', 'label', 'api_url', 'api_key', 'api_style', 'enabled', 'sort_order', 'created_at',
  'sync_enabled'
];

function currentModelVersion() {
  return parseInt(initDb.getMeta('model_config_version', '0'), 10) || 0;
}

function bumpModelVersion() {
  var next = currentModelVersion() + 1;
  initDb.setMeta('model_config_version', next);
  return next;
}

// ---- 中继侧：取快照 ----

// 「哪些模型会下发」这个条件要用在三处（取快照、管理台统计、开关护栏），
// 写成一份常量。三处各写一遍迟早口径漂移，而漂移的表现是「管理台说有 3 个，
// 节点只拿到 2 个」—— 这种差值没人能一眼看出是哪边算错了。
//
// 级联规则：源没勾下发，它挂的模型一律不发。否则节点会收到一个
// source_id 指向不存在的源的模型，界面上写「源已失效」，管理员却在中枢上
// 明明看到那个源好好的 —— 提示与事实相反，比不提示更糟。
var SYNCED_MODEL_WHERE = [
  'sync_enabled = 1',
  "  AND (source_id IS NULL OR source_id = ''",
  '       OR source_id IN (SELECT id FROM ai_sources WHERE sync_enabled = 1))'
].join('\n');

// scope：
//   'all'    —— 全量。席位班自己、以及班管上行给中枢时用：本机是配置的编辑者，
//               「不下发」只约束别人，不该反过来把自己本机的模型删掉。
//   'synced' —— 只取勾了下发的（普通节点）。
function snapshot(opts) {
  var all = !opts || opts.scope !== 'synced';
  var models = all
    ? db.prepare('SELECT * FROM ai_models ORDER BY sort_order, id').all()
    : db.prepare('SELECT * FROM ai_models WHERE ' + SYNCED_MODEL_WHERE + ' ORDER BY sort_order, id').all();
  var sources = all
    ? db.prepare('SELECT * FROM ai_sources ORDER BY sort_order, id').all()
    : db.prepare('SELECT * FROM ai_sources WHERE sync_enabled = 1 ORDER BY sort_order, id').all();
  var meta = {};
  for (var i = 0; i < SYNC_META_KEYS.length; i++) {
    var k = SYNC_META_KEYS[i];
    var v = initDb.getMeta(k, null);
    meta[k] = v === null ? '' : String(v);
  }
  return {
    model_config_version: currentModelVersion(),
    models: models,
    sources: sources,
    meta: meta
  };
}

// 管理台顶部的「下发范围」汇总。刻意和快照用同一份条件 —— 这两个数字
// 一旦对不上，管理员就会开始怀疑同步坏了。
function syncScopeCounts() {
  return {
    models: db.prepare('SELECT COUNT(*) AS c FROM ai_models').get().c,
    synced_models: db.prepare('SELECT COUNT(*) AS c FROM ai_models WHERE ' + SYNCED_MODEL_WHERE).get().c,
    sources: db.prepare('SELECT COUNT(*) AS c FROM ai_sources').get().c,
    synced_sources: db.prepare('SELECT COUNT(*) AS c FROM ai_sources WHERE sync_enabled = 1').get().c
  };
}

function pickInt(v, dflt) {
  var n = parseInt(v, 10);
  return isFinite(n) ? n : dflt;
}

// 行 → 仅含已知列的对象（多余列丢弃、缺失列给默认值）
//
// defaults 只给「缺失时的缺省值不该是 0」的列用（如 sync_enabled 默认 1）：
// 老版本节点上行时整份配置里没有这一列，若按 0 落地，中枢侧所有勾选会在
// 一次上行之后被静默关掉 —— 表现为「怎么突然什么都不下发了」。
function normalizeRow(row, columns, ints, defaults) {
  var out = {};
  for (var i = 0; i < columns.length; i++) {
    var col = columns[i];
    var v = row[col];
    if (ints[col]) {
      var dflt = (defaults && defaults[col] !== undefined) ? defaults[col] : 0;
      out[col] = pickInt(v, dflt);
    } else {
      out[col] = v === null || v === undefined ? '' : String(v);
    }
  }
  return out;
}

var MODEL_INT_COLUMNS = {};
for (var mi = 0; mi < MODEL_COLUMNS.length; mi++) MODEL_INT_COLUMNS[MODEL_COLUMNS[mi]] = false;
['supports_thinking', 'supports_stream', 'supports_vision', 'vision_max_images',
 'price_in', 'price_out', 'price_cache_hit',
 'is_free', 'enabled', 'is_default', 'sort_order', 'price_multiplier_bp',
 'has_offpeak', 'offpeak_discount_bp', 'sync_enabled'].forEach(function(c) { MODEL_INT_COLUMNS[c] = true; });

var SOURCE_INT_COLUMNS = { enabled: true, sort_order: true, sync_enabled: true };

// 缺字段时的缺省值：下发范围默认「发」，否则老数据/老节点一上行就全被关掉
var MODEL_DEFAULTS = { sync_enabled: 1 };
var SOURCE_DEFAULTS = { sync_enabled: 1 };

// ---- 节点侧：整表替换落地 ----
//
// ⚠️ 必须整表替换（先删后插）而非 upsert：下发是「权威全量」语义，
// 中继上删掉的模型/源若在节点上残留，会出现「某班的模型悄悄不一样」。
// 会话里引用了被删 model_id 的旧对话由模型解析回退逻辑兜底（不在本层处理）。
function applySnapshot(snap) {
  if (!snap || !Array.isArray(snap.models)) {
    return { applied: 0, sources: 0 };
  }

  var models = snap.models.map(function(r) {
    return normalizeRow(r, MODEL_COLUMNS, MODEL_INT_COLUMNS, MODEL_DEFAULTS);
  });
  var sources = Array.isArray(snap.sources)
    ? snap.sources.map(function(r) {
      return normalizeRow(r, SOURCE_COLUMNS, SOURCE_INT_COLUMNS, SOURCE_DEFAULTS);
    })
    : [];
  var meta = snap.meta && typeof snap.meta === 'object' ? snap.meta : {};

  // ---- 空快照护栏（2026-10-21 生产事故后加）----
  //
  // 整表替换的代价是：一份 models 为空的快照落地，全校立刻没有任何可用模型，
  // 而这条路径**不会**留下「删除了几个模型」这类可读日志 —— 事后只能靠翻库
  // 才知道发生过什么（10-21 就是这么丢的，10-12 已经丢过一次）。
  //
  // 所以：「把本机现有的模型清成 0」必须是一个**显式**决定（allowEmpty），
  // 不能是上游漏传字段、空数组、脚本传错参数顺手造成的结果。
  // 本机本来就是 0 条时不受影响 —— 那时空快照没有破坏性。
  if (models.length === 0 && snap.allowEmpty !== true) {
    var localCount = 0;
    try {
      localCount = db.prepare('SELECT COUNT(*) AS c FROM ai_models').get().c;
    } catch (e) { /* 表还不存在（首次建库）：没有可保护的东西 */ }
    if (localCount > 0) {
      var guardErr = new Error('拒绝用空快照替换本机 ' + localCount + ' 个模型：'
        + '一旦落地全校将没有可用模型。确需清空请显式传 allowEmpty=true。');
      guardErr.code = 'EMPTY_SNAPSHOT';
      throw guardErr;
    }
  }

  var tx = db.transaction(function() {
    db.exec('DELETE FROM ai_models');
    db.exec('DELETE FROM ai_sources');

    var mStmt = db.prepare([
      'INSERT INTO ai_models (' + MODEL_COLUMNS.join(', ') + ')',
      'VALUES (' + MODEL_COLUMNS.map(function() { return '?'; }).join(', ') + ')'
    ].join('\n'));
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      mStmt.run.apply(mStmt, MODEL_COLUMNS.map(function(c) { return m[c]; }));
    }

    var sStmt = db.prepare([
      'INSERT INTO ai_sources (' + SOURCE_COLUMNS.join(', ') + ')',
      'VALUES (' + SOURCE_COLUMNS.map(function() { return '?'; }).join(', ') + ')'
    ].join('\n'));
    for (var j = 0; j < sources.length; j++) {
      var s = sources[j];
      sStmt.run.apply(sStmt, SOURCE_COLUMNS.map(function(c) { return s[c]; }));
    }

    for (var k = 0; k < SYNC_META_KEYS.length; k++) {
      var key = SYNC_META_KEYS[k];
      if (meta[key] === undefined || meta[key] === null) continue;
      initDb.setMeta(key, String(meta[key]));
    }
  });
  tx();

  return { applied: models.length, sources: sources.length };
}

// ---- 中继侧：下发范围开关 ----
//
// 两条护栏刻意放在这里而不是路由里：它们是**快照正确性的前提**，
// 任何调用方（管理台、脚本、以后的批量接口）都必须受同一套约束。
// 放在路由里的话，第二个入口出现时就会漏掉一条，而漏掉的后果是
// 「全校节点没有计费基准」这种只能在班里的界面上才看得见的故障。
function setModelSync(id, on) {
  var row = db.prepare('SELECT id, label, is_default FROM ai_models WHERE id = ?')
    .get(String(id || ''));
  if (!row) return { ok: false, code: 404, message: '模型不存在' };

  var enabled = on ? 1 : 0;
  var name = row.label || row.id;

  // 默认模型必须下发：它是各班的计费基准，节点上没有它，
  // 所有「基准 × 倍率」都失去参照。拒绝而不是静默改回去 ——
  // 悄悄把一条勾选恢复，管理员下次打开会以为开关坏了。
  if (!enabled && row.is_default === 1) {
    return {
      ok: false,
      code: 400,
      message: '「' + name + '」是默认模型，也是各班的计费基准，不能停止下发。'
        + '要把它排除在外，请先把另一个模型设为默认。'
    };
  }

  db.prepare('UPDATE ai_models SET sync_enabled = ? WHERE id = ?').run(enabled, row.id);
  return { ok: true, id: row.id, name: name, sync_enabled: enabled, affected_models: 0 };
}

function setSourceSync(id, on) {
  var row = db.prepare('SELECT id, label FROM ai_sources WHERE id = ?').get(String(id || ''));
  if (!row) return { ok: false, code: 404, message: '模型源不存在' };

  var enabled = on ? 1 : 0;
  var name = row.label || row.id;
  var attached = 0;
  try {
    attached = db.prepare('SELECT COUNT(*) AS c FROM ai_models WHERE source_id = ?').get(row.id).c;
  } catch (e) { attached = 0; }

  if (!enabled) {
    var def = db.prepare('SELECT label FROM ai_models WHERE source_id = ? AND is_default = 1').get(row.id);
    if (def) {
      return {
        ok: false,
        code: 400,
        message: '默认模型「' + (def.label || '') + '」挂在这个源上，停止下发会让各班失去计费基准。'
          + '请先把它改成自带地址/密钥，或先把默认模型换成别的。'
      };
    }
  }

  db.prepare('UPDATE ai_sources SET sync_enabled = ? WHERE id = ?').run(enabled, row.id);
  return { ok: true, id: row.id, name: name, sync_enabled: enabled, affected_models: attached };
}

module.exports = {
  SYNC_META_KEYS: SYNC_META_KEYS,
  currentModelVersion: currentModelVersion,
  bumpModelVersion: bumpModelVersion,
  snapshot: snapshot,
  syncScopeCounts: syncScopeCounts,
  setModelSync: setModelSync,
  setSourceSync: setSourceSync,
  applySnapshot: applySnapshot
};
