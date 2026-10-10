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
  'source_id', 'has_offpeak', 'offpeak_peak_windows', 'offpeak_discount_bp'
];

var SOURCE_COLUMNS = [
  'id', 'label', 'api_url', 'api_key', 'api_style', 'enabled', 'sort_order', 'created_at'
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
function snapshot() {
  var models = db.prepare('SELECT * FROM ai_models ORDER BY sort_order, id').all();
  var sources = db.prepare('SELECT * FROM ai_sources ORDER BY sort_order, id').all();
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

function pickInt(v, dflt) {
  var n = parseInt(v, 10);
  return isFinite(n) ? n : dflt;
}

// 行 → 仅含已知列的对象（多余列丢弃、缺失列给默认值）
function normalizeRow(row, columns, ints) {
  var out = {};
  for (var i = 0; i < columns.length; i++) {
    var col = columns[i];
    var v = row[col];
    if (ints[col]) {
      out[col] = pickInt(v, 0);
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
 'has_offpeak', 'offpeak_discount_bp'].forEach(function(c) { MODEL_INT_COLUMNS[c] = true; });

var SOURCE_INT_COLUMNS = { enabled: true, sort_order: true };

// ---- 节点侧：整表替换落地 ----
//
// ⚠️ 必须整表替换（先删后插）而非 upsert：下发是「权威全量」语义，
// 中继上删掉的模型/源若在节点上残留，会出现「某班的模型悄悄不一样」。
// 会话里引用了被删 model_id 的旧对话由模型解析回退逻辑兜底（不在本层处理）。
function applySnapshot(snap) {
  if (!snap || !Array.isArray(snap.models)) {
    return { applied: 0, sources: 0 };
  }

  var models = snap.models.map(function(r) { return normalizeRow(r, MODEL_COLUMNS, MODEL_INT_COLUMNS); });
  var sources = Array.isArray(snap.sources)
    ? snap.sources.map(function(r) { return normalizeRow(r, SOURCE_COLUMNS, SOURCE_INT_COLUMNS); })
    : [];
  var meta = snap.meta && typeof snap.meta === 'object' ? snap.meta : {};

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

module.exports = {
  SYNC_META_KEYS: SYNC_META_KEYS,
  currentModelVersion: currentModelVersion,
  bumpModelVersion: bumpModelVersion,
  snapshot: snapshot,
  applySnapshot: applySnapshot
};
