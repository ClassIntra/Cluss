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
var config = require('../config');

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

  // 出站只带业务列：origin（033）是落地端的状态、hub_base（034）是本机的基线账本。
  // 两个都不该发给对端 —— 中枢把自己那份 origin 发下去，节点照抄就会把整批中枢
  // 配置标成本班私有（下一轮合并全都留下，中枢再删也删不掉）；hub_base 更只是
  // 本机记账，跟着上行/下行跑一遍等于把每个包撑大一倍，还会互相污染基线。
  models = models.map(function(r) { return normalizeRow(r, MODEL_COLUMNS, MODEL_INT_COLUMNS, MODEL_DEFAULTS); });
  sources = sources.map(function(r) { return normalizeRow(r, SOURCE_COLUMNS, SOURCE_INT_COLUMNS, SOURCE_DEFAULTS); });

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

// ---- 字段级合并的基础件（迁移 034）----

// 同一列在两边的表示可能不同（SQLite 给 number、老节点上行给字符串、JSON 里又是
// number）。比较前统一归一，否则「1000」!=1000 会被判成「本班改过」而白锁一个字段。
function normVal(col, v, ints, defaults) {
  if (ints[col]) {
    var dflt = (defaults && defaults[col] !== undefined) ? defaults[col] : 0;
    return pickInt(v, dflt);
  }
  return v === null || v === undefined ? '' : String(v);
}

// hub_base（上一次从中枢收到的这一行）--'' 表示没有基线
function parseHubBase(raw) {
  if (!raw) return null;
  try {
    var o = JSON.parse(String(raw));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return o;
  } catch (e) { return null; }
}

// 三方合并一行。返回 { row, kept, origin }
//   row    要落库的整行（只含业务列）
//   kept   本班保留了自己的值的列名（空 = 这一行完全跟中枢）
//   origin 落库用的来源标记
function mergeRow(local, hub, columns, ints, defaults) {
  var hubJson = JSON.stringify(hub);
  var base = parseHubBase(local.hub_base);
  var origin = String(local.origin || 'local');
  var row = {};
  var kept = [];
  var i, col;

  if (!base) {
    // 没有基线，只能按来源判断（034 之前的老数据都走这里）：
    if (origin === 'hub') {
      // 中枢下发的行：整行按中枢刷新（本来就没有本班改动可保）
      for (i = 0; i < columns.length; i++) row[columns[i]] = normVal(columns[i], hub[columns[i]], ints, defaults);
      return { row: row, kept: kept, origin: 'hub', hubBase: hubJson };
    }
    // 本机自建 / 已接管：整行保留，**但记下基线** —— 下一轮就能按字段收敛：
    // 本班没动过的字段从此开始跟中枢走，动过的继续保留。
    for (i = 0; i < columns.length; i++) {
      col = columns[i];
      row[col] = normVal(col, local[col], ints, defaults);
      kept.push(col);
    }
    return { row: row, kept: kept, origin: 'local', hubBase: hubJson };
  }

  for (i = 0; i < columns.length; i++) {
    col = columns[i];
    var hv = normVal(col, hub[col], ints, defaults);
    var lv = normVal(col, local[col], ints, defaults);
    // 基线里没这一列（哨兵 '{}' = 刚点过「恢复跟随」）→ 视作没动过，取中枢值
    var hasBaseCol = base[col] !== undefined;
    var bv = hasBaseCol ? normVal(col, base[col], ints, defaults) : null;
    if (hasBaseCol && lv !== bv) {
      row[col] = lv;
      kept.push(col);
    } else {
      row[col] = hv;
    }
  }

  return { row: row, kept: kept, origin: kept.length ? 'local' : 'hub', hubBase: hubJson };
}

// 这一行现在跟中枢差在哪几列（管理台徽标用）。
// 返回 { has_base, fields }：has_base=false 表示本机自建、没有中枢对应物。
function diffAgainstHub(row, table) {
  var isSource = table === 'ai_sources';
  var columns = isSource ? SOURCE_COLUMNS : MODEL_COLUMNS;
  var ints = isSource ? SOURCE_INT_COLUMNS : MODEL_INT_COLUMNS;
  var defaults = isSource ? SOURCE_DEFAULTS : MODEL_DEFAULTS;

  var base = parseHubBase(row && row.hub_base);
  if (!base) return { has_base: false, fields: [] };

  var fields = [];
  for (var i = 0; i < columns.length; i++) {
    var col = columns[i];
    if (base[col] === undefined) continue;
    if (normVal(col, row[col], ints, defaults) !== normVal(col, base[col], ints, defaults)) {
      fields.push(col);
    }
  }
  return { has_base: true, fields: fields };
}

// 「恢复跟随中枢」：把基线置成空哨兵。
// 空对象 ≠ 没有基线 —— 没有基线是「不知道中枢长什么样」，空哨兵是
// 「中枢长什么样都不关我的事，下一轮整行照抄」。两者的分支在上面 mergeRow 里。
//
// 硬门槛：**没有中枢基线的行不允许恢复跟随**。
// 这类行是本班自建的，中枢压根没有同 id 的配置。标成 hub 之后，下一轮
// applySnapshot(merge) 的第一件事是「删掉所有 hub 行里快照没有的」——
// 于是这一条被静默删除，本班自己配的地址、Key、模型名全丢，且没有任何报错，
// 只剩事后翻库。管理台按钮上写的是「本班自建的条目不受影响」，所以这里必须
// 真的不动它们（2026-10-23 探针 probe-follow-hub-local-created 实测：会删）。
function markFollowHub(table, id) {
  var tableName = table === 'ai_sources' ? 'ai_sources' : 'ai_models';
  var row = db.prepare('SELECT id, hub_base FROM ' + tableName + ' WHERE id = ?').get(String(id || ''));
  if (!row) return { ok: false, reason: 'missing' };
  if (row.hub_base === null || String(row.hub_base) === '') {
    return { ok: false, reason: 'local_created' };
  }
  var r = db.prepare('UPDATE ' + tableName + " SET origin = 'hub', hub_base = '{}' WHERE id = ?")
    .run(String(id || ''));
  return { ok: r.changes > 0, changed: r.changes };
}

// 「全部恢复跟随」用的同一套挑选条件：只挑有中枢基线的行。
// follow-all 的批量 UPDATE 必须用这里返回的表达式，否则又会扫到本班自建的条目
// —— 那条路径代价更大（一行 SQL 删掉一整类配置）。
var HAS_HUB_BASE_SQL = "IFNULL(origin, 'local') != 'hub' AND hub_base IS NOT NULL AND hub_base != ''";

// ---- 节点侧：快照落地 ----
//
// opts.mode：
//   'replace'（默认）—— 整表替换。跟随中枢的班用这个：下发是「权威全量」语义，
//                       中继上删掉的模型/源若在节点上残留，会出现「某班的模型
//                       悄悄不一样」。会话里引用了被删 model_id 的旧对话由模型
//                       解析回退逻辑兜底（不在本层处理）。
//   'merge'          —— **字段级**三方合并（迁移 034）。对应「本班自选（不回传）」
//                       这一档：中枢新配的模型能收到，本班自己加的不会被清掉，
//                       而且本班没动过的字段（典型是单价、倍率、峰谷）继续跟随
//                       中枢。033 那版是整行冻结 —— 只要本班改过显示名，中枢调价
//                       就再也下不来，账和钱会静默漂移（2026-10-22 用户报的
//                       「单价什么的也有同步」）。
//
// 三方比较的「三方」= 本机当前值 / 中枢新值 / hub_base（上一次从中枢收到的值）：
//   · 本机值 == 基线 → 本班没动过这个字段 → 用中枢的新值
//   · 本机值 != 基线 → 本班改过这个字段   → 保留本班的值（冲突时本班优先：
//                      那是管理员在本机的明确动作，不该被一次轮询抹掉）
// 恢复跟随：把 hub_base 置成 '{}' 哨兵（基线存在但没有任何字段）→ 下一轮
// 所有字段都判成「本班没动过」→ 整行按中枢刷新。见 markFollowHub()。
//
// 为什么 origin 不放进 MODEL_COLUMNS：它是**落地端的状态**，不是配置内容。
// 中枢把自己的 local 值一起发出来时，节点若照抄就会把整批中枢配置标成本班私有，
// 下一轮 merge 全部保留 —— 中枢再删也删不掉，越用越偏。
function applySnapshot(snap, opts) {
  if (!snap || !Array.isArray(snap.models)) {
    return { applied: 0, sources: 0 };
  }

  var merge = !!(opts && opts.mode === 'merge');

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
  //
  // merge 模式下同样要拦：虽然只清 hub 行，但「本机只剩 local 模型 + 中枢空快照」
  // 时它依然会把中枢那几个删掉，而管理员看到的是「模型突然少了一半」，同样莫名。
  if (models.length === 0 && snap.allowEmpty !== true) {
    var localCount = 0;
    try {
      localCount = merge
        ? db.prepare("SELECT COUNT(*) AS c FROM ai_models WHERE IFNULL(origin, 'local') = 'hub'").get().c
        : db.prepare('SELECT COUNT(*) AS c FROM ai_models').get().c;
    } catch (e) { /* 表还不存在（首次建库）：没有可保护的东西 */ }
    if (localCount > 0) {
      var guardErr = new Error('拒绝用空快照替换本机 ' + localCount + ' 个模型：'
        + '一旦落地全校将没有可用模型。确需清空请显式传 allowEmpty=true。');
      guardErr.code = 'EMPTY_SNAPSHOT';
      throw guardErr;
    }
  }

  // 落地上这一行算谁的（origin）：
  //   · 节点（node）：来自快照 = 'hub'；本机自建 / 本班改过 = 'local'
  //   · 中枢自己（standalone / relay / mesh 中心）：收到席位班上行时也是这条路径，
  //     但中枢上的每一行都是「本机配置」，标成 'hub' 会让管理台显示成「中枢下发」。
  var isNode = config.mode === config.MODES.NODE;
  var hubOrigin = isNode ? 'hub' : 'local';

  var mInsert = db.prepare([
    'INSERT INTO ai_models (' + MODEL_COLUMNS.concat(['origin', 'hub_base']).join(', ') + ')',
    'VALUES (' + MODEL_COLUMNS.concat(['origin', 'hub_base']).map(function() { return '?'; }).join(', ') + ')'
  ].join('\n'));
  var sInsert = db.prepare([
    'INSERT INTO ai_sources (' + SOURCE_COLUMNS.concat(['origin', 'hub_base']).join(', ') + ')',
    'VALUES (' + SOURCE_COLUMNS.concat(['origin', 'hub_base']).map(function() { return '?'; }).join(', ') + ')'
  ].join('\n'));

  var mUpdate = db.prepare([
    'UPDATE ai_models SET ' + MODEL_COLUMNS.map(function(c) { return c + ' = ?'; }).join(', ')
      + ', origin = ?, hub_base = ? WHERE id = ?'
  ].join('\n'));
  var sUpdate = db.prepare([
    'UPDATE ai_sources SET ' + SOURCE_COLUMNS.map(function(c) { return c + ' = ?'; }).join(', ')
      + ', origin = ?, hub_base = ? WHERE id = ?'
  ].join('\n'));

  // 统计：本班保留了自己的值、没跟中枢走的条数（管理台与探针都看这个数）
  var keptRows = 0;

  var tx = db.transaction(function() {
    if (!merge) {
      db.exec('DELETE FROM ai_models');
      db.exec('DELETE FROM ai_sources');
    } else {
      // 只删「中枢已经不要了」的 hub 行。本班自建/接管过的行（origin='local'）
      // 一律保留 —— 那条已经归本班管，中枢删它不该让本班也跟着消失。
      var keepM = {}, keepS = {};
      for (var a = 0; a < models.length; a++) keepM[models[a].id] = true;
      for (var b = 0; b < sources.length; b++) keepS[sources[b].id] = true;

      var staleM = db.prepare("SELECT id FROM ai_models WHERE IFNULL(origin, 'local') = 'hub'").all();
      var delM = db.prepare('DELETE FROM ai_models WHERE id = ?');
      for (var c = 0; c < staleM.length; c++) if (!keepM[staleM[c].id]) delM.run(staleM[c].id);

      var staleS = db.prepare("SELECT id FROM ai_sources WHERE IFNULL(origin, 'local') = 'hub'").all();
      var delS = db.prepare('DELETE FROM ai_sources WHERE id = ?');
      for (var d = 0; d < staleS.length; d++) if (!keepS[staleS[d].id]) delS.run(staleS[d].id);
    }

    if (merge) {
      // ---- 字段级三方合并（迁移 034）----
      // 逐条：已存在就按字段比对，不存在就整条落（origin = hub）。
      // 这里刻意不用「先删后插」：删掉会把 hub_base 一起丢掉，下一轮就没有
      // 基线可比较，本班改过的行会退回「整行冻结」的老毛病。
      var localM = {};
      var rowsM = db.prepare('SELECT * FROM ai_models').all();
      for (var e = 0; e < rowsM.length; e++) localM[rowsM[e].id] = rowsM[e];
      var localS = {};
      var rowsS = db.prepare('SELECT * FROM ai_sources').all();
      for (var g = 0; g < rowsS.length; g++) localS[rowsS[g].id] = rowsS[g];

      for (var i = 0; i < models.length; i++) {
        var m = models[i];
        var lm = localM[m.id];
        if (!lm) {
          mInsert.run.apply(mInsert, MODEL_COLUMNS.map(function(c) { return m[c]; })
            .concat([hubOrigin, JSON.stringify(m)]));
          continue;
        }
        var rm = mergeRow(lm, m, MODEL_COLUMNS, MODEL_INT_COLUMNS, MODEL_DEFAULTS);
        if (rm.kept.length) keptRows++;
        mUpdate.run.apply(mUpdate, MODEL_COLUMNS.map(function(c) { return rm.row[c]; })
          .concat([rm.origin, JSON.stringify(m), m.id]));
      }

      for (var j = 0; j < sources.length; j++) {
        var s = sources[j];
        var ls = localS[s.id];
        if (!ls) {
          sInsert.run.apply(sInsert, SOURCE_COLUMNS.map(function(c) { return s[c]; })
            .concat([hubOrigin, JSON.stringify(s)]));
          continue;
        }
        var rs = mergeRow(ls, s, SOURCE_COLUMNS, SOURCE_INT_COLUMNS, SOURCE_DEFAULTS);
        if (rs.kept.length) keptRows++;
        sUpdate.run.apply(sUpdate, SOURCE_COLUMNS.map(function(c) { return rs.row[c]; })
          .concat([rs.origin, JSON.stringify(s), s.id]));
      }
    } else {
      for (var k2 = 0; k2 < models.length; k2++) {
        var mm = models[k2];
        // 全量替换也记基线：节点日后切到「本班自选」时，第一轮就有得比 ——
        // 否则那一轮所有行都「没有基线」，中枢的改动会被整体判成本班私有。
        mInsert.run.apply(mInsert, MODEL_COLUMNS.map(function(c) { return mm[c]; })
          .concat([hubOrigin, JSON.stringify(mm)]));
      }

      for (var l = 0; l < sources.length; l++) {
        var ss = sources[l];
        sInsert.run.apply(sInsert, SOURCE_COLUMNS.map(function(c) { return ss[c]; })
          .concat([hubOrigin, JSON.stringify(ss)]));
      }
    }

    // 多默认收口。「默认」决定所有对话按哪个单价计费，两个默认时
    // `WHERE is_default = 1 LIMIT 1` 取哪一行是不确定的 —— 计费会随机漂移。
    // 合并档下**本班自选的默认优先**：否则中枢每下发一次，
    // 管理员在本班选定默认模型这件事就被悄悄改回去了。
    var defs = db.prepare(
      'SELECT id FROM ai_models WHERE is_default = 1 '
      + "ORDER BY (CASE WHEN IFNULL(origin, 'local') = 'local' THEN 0 ELSE 1 END), sort_order, id"
    ).all();
    if (defs.length > 1) {
      var clearDefault = db.prepare('UPDATE ai_models SET is_default = 0 WHERE id = ?');
      for (var f = 1; f < defs.length; f++) clearDefault.run(defs[f].id);
    }

    // ---- 随行的全局配置（视觉转述 / 峰谷默认）----
    // 这些不是表行，没法用 hub_base 列记基线，于是把基线写在 meta 里
    // （hub_base:<key>）。判据与模型字段完全一样：本机值 != 基线 = 本班改过。
    // 少了这一层，「本班自选」档里管理员调的全局峰谷会在下一轮被中枢静默改回去，
    // 而模型级峰谷（表字段）却能保住 —— 同一件事两套行为，没法解释。
    for (var n = 0; n < SYNC_META_KEYS.length; n++) {
      var key = SYNC_META_KEYS[n];
      if (meta[key] === undefined || meta[key] === null) continue;
      var incoming = String(meta[key]);
      var shadowKey = 'hub_base:' + key;
      if (merge) {
        var prev = initDb.getMeta(shadowKey, null);
        var cur = initDb.getMeta(key, null);
        var touched = prev !== null && cur !== null && String(cur) !== String(prev);
        if (!touched) initDb.setMeta(key, incoming);
      } else {
        initDb.setMeta(key, incoming);
      }
      initDb.setMeta(shadowKey, incoming);
    }
  });
  tx();

  return { applied: models.length, sources: sources.length, skipped: keptRows, kept: keptRows };
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
  applySnapshot: applySnapshot,
  diffAgainstHub: diffAgainstHub,
  markFollowHub: markFollowHub,
  HAS_HUB_BASE_SQL: HAS_HUB_BASE_SQL
};
