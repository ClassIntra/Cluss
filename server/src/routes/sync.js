// 中继同步接口（relay 模式专用）
//
// 班级节点通过这些接口与中继交互：
//   GET  /sync/version       轻量轮询：分配版本号 + 模型配置版本号（节点据此判断是否拉全量）
//   GET  /sync/assignments   拉取额度分配快照（按学校过滤）
//   GET  /sync/model-config  拉取模型配置快照（v1：改一处全网生效，全网同一份）
//   POST /sync/usage         上报本班用量明细（中继据此做全网对账）
//
// 认证两条路径（024_cloud_orgs）：
//   A) Cluss Cloud 多租户：请求带 X-Cluss-Org（学校编号）+ X-Cluss-Secret（学校接入密钥）。
//      数据一律按学校过滤 —— A 校节点拿不到 B 校的任何数据（设计文档 §7.1 红线）。
//   B) 自托管单校（向后兼容）：只带 X-Cluss-Secret（= 全局 CLUSS_SHARED_SECRET），
//      org 视为 ''（本机），行为与 023 之前完全一致。
//
// 心跳：节点每次同步在请求头顺路报告身份（X-Cluss-Instance / 版本号们），
// 中继更新 cluss_nodes 的 last_seen_at 与配置到达情况。老版本节点不发这些头 →
// 服务照旧，不做强制升级。
//
// ⚠️ v0/v1 遗留边界：自托管路径仍是单一共享密钥，「吊销」只是台账面。
// Cloud 路径下每校一把密钥，吊销一个节点不影响其他节点；但同校节点仍共享
// 校级密钥（密钥轮换/节点级密钥留给 v2，见设计文档 §10.5）。

var crypto = require('crypto');
var express = require('express');
var router = express.Router();
var db = require('../utils/db');
var time = require('../utils/time');
var config = require('../config');
var constants = require('../utils/constants');
var modelConfig = require('../services/model-config');
var credit = require('../services/credit');
var initDb = require('../utils/init-db');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function currentAssignVersion() {
  return parseInt(initDb.getMeta('assign_version', '0'), 10) || 0;
}

// 只有中继类模式才对外提供同步服务：
//   relay —— 云端专职中枢；
//   mesh  —— 组网中枢（本机自己也有班，但同样要收节点的同步请求）。
// 两者共用下面全部接口；standalone / node 一律 404（节点不该被别的节点连）。
function requireRelayMode(req, res, next) {
  var m = config.mode;
  if (m !== config.MODES.RELAY && m !== config.MODES.MESH) {
    return res.status(404).json({ code: 404, message: '当前实例不是中继节点' });
  }
  next();
}

router.use(requireRelayMode);

// ---- 节点认证 + 心跳（每个同步请求都会走）----
// 通过后挂 req.nodeOrg = { id, row }（org 模式）或 null（自托管/旧节点）
function requireNodeAuth(req, res, next) {
  var orgId = String(req.headers['x-cluss-org'] || '').trim();
  var provided = String(req.headers['x-cluss-secret'] || '');

  if (orgId) {
    var org = db.prepare('SELECT * FROM cluss_orgs WHERE id = ?').get(orgId);
    if (!org) return res.status(403).json({ code: 403, message: '学校编号不存在' });
    if (org.status !== 'active') return res.status(403).json({ code: 403, message: '该学校已被停用' });
    if (!org.secret_hash || !constants.safeCompare(sha256(provided), org.secret_hash)) {
      return res.status(403).json({ code: 403, message: '学校接入密钥校验失败' });
    }
    req.nodeOrg = { id: org.id, name: org.name };
  } else {
    // 自托管路径：全网单一共享密钥（未配置时拒绝服务而不是放行）
    if (!config.relay.secret) {
      return res.status(503).json({ code: 503, message: '中继未配置 CLUSS_SHARED_SECRET，拒绝同步请求' });
    }
    if (!constants.safeCompare(provided, config.relay.secret)) {
      return res.status(403).json({ code: 403, message: '密钥校验失败' });
    }
    req.nodeOrg = null;
  }

  var touched = touchNode(req, orgId);
  if (touched && touched.revoked) {
    return res.status(403).json({ code: 403, message: '节点已被吊销，同步被拒绝' });
  }
  next();
}

router.use(requireNodeAuth);

// ---- 心跳：同步请求顺路更新节点注册表（023_cluss_nodes）----
// 返回 null 表示节点没带身份头（老版本节点），跳过记录
function touchNode(req, orgId) {
  var instanceId = String(req.headers['x-cluss-instance'] || '').trim();
  if (!instanceId) return null;

  var now = time.nowUtc();
  var assignV = parseInt(req.headers['x-cluss-assign-version'], 10) || 0;
  var modelV = parseInt(req.headers['x-cluss-model-version'], 10) || 0;
  var nodeV = String(req.headers['x-cluss-node-version'] || '').trim();

  var existing = db.prepare(
    'SELECT instance_id, status FROM cluss_nodes WHERE instance_id = ? AND org_id = ?'
  ).get(instanceId, orgId);
  if (existing) {
    if (existing.status === 'revoked') return { revoked: true };
    // 头缺席时保留旧值：显式 /org/join 写入的 node_version 不该被没带头的
    // 老客户端抹掉；版本号 0 = 从未应用，同样不覆盖
    db.prepare([
      'UPDATE cluss_nodes SET last_seen_at = ?,',
      '  last_assign_version = CASE WHEN ? > 0 THEN ? ELSE last_assign_version END,',
      '  last_model_version = CASE WHEN ? > 0 THEN ? ELSE last_model_version END,',
      "  node_version = CASE WHEN ? != '' THEN ? ELSE node_version END",
      'WHERE instance_id = ? AND org_id = ?'
    ].join('\n')).run(now, assignV, assignV, modelV, modelV, nodeV, nodeV, instanceId, orgId);
    return { revoked: false };
  }

  db.prepare([
    'INSERT INTO cluss_nodes (instance_id, org_id, status, first_seen_at, last_seen_at,',
    'last_assign_version, last_model_version, node_version)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(instanceId, orgId, 'active', now, now, assignV, modelV, nodeV);
  console.log('[Sync] 新节点接入: %s（学校 %s，版本 %s）', instanceId, orgId || '本机', nodeV || '未知');
  return { revoked: false };
}

// ---- 管理员席位 ----
//
// 为什么中枢必须下发音席：写入权不能由节点自己宣称。节点侧
// （services/sync.js 的 requireCanEditModelConfig）每一轮从 /sync/version
// 读 is_seat_admin，据此决定「本班改的到底要不要往全校推」。
// 中枢不返回这两个字段，节点就永远当自己没席位 —— 表现为班管在自己机器上
// 点保存被挡一句「本班不是管理员席位」，而配置其实哪儿都没去。
//
// 默认握在中枢自己手里：管理台跑在它上面，它天然是操作发起方。
// 需要移交的场景：班管平时在自己班那台机器上操作，不想每次都跑到中枢机器上改。
function seatInstance() {
  var v = String(initDb.getMeta('seat_instance', '') || '').trim();
  return v || config.instanceId;
}

function setSeatInstance(instanceId) {
  initDb.setMeta('seat_instance', String(instanceId || '').trim());
}

function isSeatNode(instanceId) {
  return String(instanceId || '').trim() === seatInstance();
}

function nodeInstanceId(req) {
  return String(req.headers['x-cluss-instance'] || '').trim();
}

// ============================================================
// GET /sync/version
// ============================================================
router.get('/version', function(req, res) {
  // 「模型同步档位」是**按节点**的开关（迁移 031 两态 → 迁移 033 三态）：
  //   1 跟随中枢   —— 全量替换下发，本班只读
  //   2 本班自选   —— 下发按来源合并，本班可改、改动不回传
  //   0 完全不同步 —— 不拉也不推
  // 有的班想用自己的 Key / 更便宜的模型，或者本地网络连不上中枢选的那家。
  // 中间那档是为「既想继续收到中枢新配的模型、又想自己能改」准备的：
  // 只给开关不给编辑权，等于逼他们在「全跟」和「全断」之间二选一。
  var inst = nodeInstanceId(req);
  var modelSync = 1;
  if (inst) {
    try {
      var nodeRow = db.prepare('SELECT model_sync FROM cluss_nodes WHERE instance_id = ?').get(inst);
      if (nodeRow) {
        var raw = Number(nodeRow.model_sync);
        if (raw === 0 || raw === 2) modelSync = raw;
      }
    } catch (e) { /* 老 schema：按跟随处理 */ }
  }

  res.json({
    code: 200,
    message: 'ok',
    data: {
      instance_id: config.instanceId,
      assign_version: currentAssignVersion(),
      model_config_version: modelConfig.currentModelVersion(),
      model_sync: modelSync,
      // 席位随版本轮询一起下发：它就是节点判断自己有没有写入权的唯一依据
      is_seat_admin: isSeatNode(inst),
      seat_instance: seatInstance(),
      server_time: time.nowUtc()
    }
  });
});

// ============================================================
// GET /sync/assignments —— 额度分配快照（按学校过滤）
// 返回全部有分配的用户（量级为「已充值学生数」，通常几百行，可整体下发）
// ============================================================
router.get('/assignments', function(req, res) {
  var orgId = req.nodeOrg ? req.nodeOrg.id : '';
  var instanceId = nodeInstanceId(req);

  // 下发哪些人：**只发这个节点自己班的学生**。
  //
  // 原来只读 cluss_credit（中枢本班那 51 人），于是别的班拉到的列表里
  // 根本没有自己的学生 —— 中枢给外班充的值永远发不出去。而外班学生的
  // 权威额度就在 sync_roster 里（由他自己那个班上报上来，见 POST /roster）。
  //
  // 不做「全网广播 + 节点本地过滤」是因为下发是**整表覆盖**语义：
  // 把别班的学生混进列表，一旦学号撞上就是改到别人账上。按 instance_id
  // 精确投递，谁的学生发给谁，撞号也伤不到人。
  //
  // 条件里那个 `hub_quota_set = 1` 是「归零」能传下去的唯一原因：
  // 收回到 0 的学生 allocated_micro 正好是 0，只看 > 0 就会被漏掉，
  // 节点永远停在旧值（实测：中枢归零、8 班仍 ¥2）。
  // 但也不能简单去掉 > 0 —— 全量下发会把节点上刚调过、还没上报的学生冲成 0。
  var rows = db.prepare([
    'SELECT user_id, allocated_micro, weekly_quota_micro, ? AS assigned_by, synced_at AS updated_at',
    'FROM sync_roster WHERE instance_id = ? AND (allocated_micro > 0 OR hub_quota_set = 1)'
  ].join('\n')).all('relay-pull', instanceId || '');

  // 中枢本班学生走原路径（他们的权威账本就是 cluss_credit）。
  // 节点本地没有这些学号时会被 sync.js 的存在性检查挡掉，不会误落。
  if (!instanceId) {
    rows = rows.concat(db.prepare([
      'SELECT user_id, allocated_micro, weekly_quota_micro, assigned_by, updated_at',
      'FROM cluss_credit WHERE allocated_micro > 0 AND org_id = ?'
    ].join('\n')).all(orgId));
  }

  var seen = {};
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (seen[r.user_id]) continue;
    seen[r.user_id] = 1;
    out.push({
      user_id: r.user_id,
      allocated_micro: r.allocated_micro,
      weekly_quota_micro: r.weekly_quota_micro,
      assigned_by: r.assigned_by,
      updated_at: time.toISO(r.updated_at)
    });
  }

  res.json({
    code: 200,
    message: 'ok',
    data: {
      assign_version: currentAssignVersion(),
      assignments: out
    }
  });
});

// ============================================================
// GET /sync/model-config —— 模型配置快照（§5.2）
// ai_models + ai_sources + 视觉/峰谷 meta，整表替换语义。
// 上游地址与 Key 由中枢运营者维护，不分校；但**下发范围可以勾**（迁移 032）。
// ============================================================
router.get('/model-config', function(req, res) {
  // 按请求方决定范围：席位班拿全量 —— 它自己就是配置的编辑者，
  // 「这条不下发」只约束别的班，不该反过来把它本机上的模型删掉。
  // 普通节点只拿勾了下发的条目（源没勾时它挂的模型一并排除，见 model-config）。
  var inst = nodeInstanceId(req);
  var snap = modelConfig.snapshot({ scope: isSeatNode(inst) ? 'all' : 'synced' });
  res.json({
    code: 200,
    message: 'ok',
    data: {
      model_config_version: snap.model_config_version,
      models: snap.models,
      sources: snap.sources,
      meta: snap.meta
    }
  });
});

// ============================================================
// POST /sync/usage —— 接收班级节点上报的用量明细
// body: { instance_id, records: [{ user_id, conversation_id, model_id, tokens..., cost_micro, created_at, local_id }] }
// ============================================================
router.post('/usage', function(req, res) {
  // 身份以认证过的头为准（org 模式下 body.instance_id 只是兼容旧节点的冗余）
  var instanceId = String(req.headers['x-cluss-instance'] || '').trim() ||
    String(req.body.instance_id || '').trim();
  var orgId = req.nodeOrg ? req.nodeOrg.id : '';
  var records = Array.isArray(req.body.records) ? req.body.records : [];

  if (!instanceId) return res.status(400).json({ code: 400, message: '缺少 instance_id' });
  if (records.length > 500) return res.status(400).json({ code: 400, message: '单次上报最多 500 条' });

  // 列名显式列出：凡旧版节点上报里没有的字段（source/trace_id/image_count），
  // 走本表默认值，保证跨版本混跑时不会因为缺字段而插入失败
  var insert = db.prepare([
    'INSERT INTO cluss_usage_log (user_id, conversation_id, model_id, prompt_tokens, completion_tokens,',
    '  cache_hit_tokens, cache_miss_tokens, total_tokens, cost_micro, estimated, origin_instance,',
    '  org_id, source, trace_id, image_count, synced, created_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
  ].join('\n'));

  // 只接受已知来源，防止节点上报任意字符串污染统计口径
  var ALLOWED_SOURCES = ['chat', 'study', 'solve', 'grade', 'vision_relay'];

  var accepted = 0;
  var tx = db.transaction(function() {
    for (var i = 0; i < records.length; i++) {
      var r = records[i] || {};
      if (!r.user_id) continue;

      var src = String(r.source || 'chat');
      if (ALLOWED_SOURCES.indexOf(src) < 0) src = 'chat';

      insert.run(
        String(r.user_id),
        String(r.conversation_id || ''),
        String(r.model_id || ''),
        Number(r.prompt_tokens || 0),
        Number(r.completion_tokens || 0),
        Number(r.cache_hit_tokens || 0),
        Number(r.cache_miss_tokens || 0),
        Number(r.total_tokens || 0),
        Number(r.cost_micro || 0),
        r.estimated ? 1 : 0,
        instanceId,
        orgId,
        src,
        String(r.trace_id || ''),
        Number(r.image_count || 0),
        String(r.created_at || time.nowUtc())
      );
      accepted++;
    }
  });

  try {
    tx();
  } catch (err) {
    console.error('[Sync] 用量入库失败:', err.message);
    return res.status(500).json({ code: 500, message: '用量入库失败' });
  }

  // 上报与心跳分开记：只轮询不上报的节点 ≠ 正常在用（看板据此区分「活着」和「在用」）
  db.prepare('UPDATE cluss_nodes SET last_report_at = ? WHERE instance_id = ? AND org_id = ?')
    .run(time.nowUtc(), instanceId, orgId);

  console.log('[Sync] 收到节点上报: %s（学校 %s），%d 条', instanceId, orgId || '本机', accepted);
  res.json({ code: 200, message: 'ok', data: { accepted: accepted } });
});

// ============================================================
// POST /sync/policy —— 席位班上行「全校」模型配置
// body: { base_version, class_user_id, config: { models, sources, meta } }
// ============================================================
//
// 为什么需要它：中枢自己就能改配置（管理台在它上面），但**班管在自己班那台机器上**
// 改的时候，改动必须有个上行通道，否则就只能跑到中枢机器上操作。
// 走乐观锁而不是「后写覆盖前写」：节点声明自己读到的是哪一版，中枢比对不一致就 409。
// 静默覆盖的后果是两个人同时改、其中一个人的改动凭空消失 —— 这种事故查不出来。
router.post('/policy', function(req, res) {
  var instanceId = nodeInstanceId(req);
  if (!isSeatNode(instanceId)) {
    return res.status(403).json({
      code: 403,
      message: '只有管理员席位班可以修改全校配置（席位现在在 ' + seatInstance() + ' 班）'
    });
  }

  var baseVersion = parseInt(req.body.base_version, 10) || 0;
  var current = modelConfig.currentModelVersion();
  if (baseVersion !== current) {
    return res.status(409).json({
      code: 409,
      message: '配置已被改动（你读到 v' + baseVersion + '，中枢现在是 v' + current + '），请刷新后重改'
    });
  }

  var cfg = req.body.config || {};
  if (!Array.isArray(cfg.models)) {
    return res.status(400).json({ code: 400, message: '缺少 config.models' });
  }

  try {
    modelConfig.applySnapshot({
      models: cfg.models,
      sources: Array.isArray(cfg.sources) ? cfg.sources : [],
      meta: cfg.meta || {}
    });
    var next = modelConfig.bumpModelVersion();
    console.log('[Sync] 席位班 %s 上行全校模型配置：v%s → v%s', instanceId, current, next);
    res.json({ code: 200, message: 'ok', data: { model_config_version: next } });
  } catch (err) {
    console.error('[Sync] 模型配置落地失败:', err.message);
    // 空快照不是"服务端故障"，是调用方传错了 —— 用 400 把原因说清楚，
    // 别让管理员看到笼统的 500 再去猜（10-21 那次丢配置就没人知道该看哪）。
    if (err && err.code === 'EMPTY_SNAPSHOT') {
      return res.status(400).json({ code: 400, message: err.message });
    }
    res.status(500).json({ code: 500, message: '配置落地失败' });
  }
});

// ============================================================
// POST /sync/allocations —— 席位班上行额度分配
// body: { base_version, class_user_id, items: [{ user_id, allocated_micro, weekly_quota_micro, reason, idem_key }] }
// ============================================================
//
// 幂等交给 credit.applyAssignment（它按 idem_key 查 cluss_credit_log 去重），
// 中枢不另造一套去重表 —— 两处口径必然漂移，而重复充值是要赔钱的那种错。
// 分配值是**绝对值**（不是增量），所以即便 idem_key 丢了，重复应用也只是覆盖成同一个数。
router.post('/allocations', function(req, res) {
  var instanceId = nodeInstanceId(req);
  if (!isSeatNode(instanceId)) {
    return res.status(403).json({
      code: 403,
      message: '只有管理员席位班可以分配全校额度（席位现在在 ' + seatInstance() + ' 班）'
    });
  }

  var items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) {
    return res.json({ code: 200, message: 'ok', data: { assign_version: currentAssignVersion(), applied: 0, skipped: 0 } });
  }
  if (items.length > 500) {
    return res.status(400).json({ code: 400, message: '单次最多 500 条' });
  }

  var orgId = req.nodeOrg ? req.nodeOrg.id : '';
  var applied = 0;
  var skipped = 0;

  try {
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      if (!it.user_id) { skipped++; continue; }
      var ok = credit.applyAssignment({
        user_id: String(it.user_id),
        allocated_micro: Number(it.allocated_micro || 0),
        weekly_quota_micro: Number(it.weekly_quota_micro || 0),
        assigned_by: String(it.class_user_id || '').trim(),
        idem_key: String(it.idem_key || '').trim(),
        reason: String(it.reason || '班管分配'),
        kind: 'topup',
        origin_instance: instanceId,
        org_id: orgId
      });
      if (ok) applied++; else skipped++;
    }
  } catch (err) {
    console.error('[Sync] 额度落地失败:', err.message);
    return res.status(500).json({ code: 500, message: '额度落地失败' });
  }

  var version = currentAssignVersion();
  // 只有真的动到账本才升版本：全是重复项还升，会让所有节点白拉一次全量快照
  if (applied > 0) version = initDb.bumpMeta('assign_version');

  console.log('[Sync] 席位班 %s 上行额度：%d 条生效、%d 条跳过（v%s）', instanceId, applied, skipped, version);
  res.json({ code: 200, message: 'ok', data: { assign_version: version, applied: applied, skipped: skipped } });
});

// ============================================================
// POST /sync/roster —— 各节点上报本班名册（谁都能报，这是可见性的来源）
// body: { items: [{ user_id, class_no, net_name, real_name, is_admin, status }] }
// ============================================================
//
// 这是「18 班能给 8 班充钱」的地基：中枢只知道各班自己报上来的人，
// 8 班不上报，18 班的管理台列表里就永远没有 8 班学生（见 026 迁移头注）。
// 覆盖语义：同一学号后报的覆盖先报的 —— 学生转班时由新班级上报自然纠正。
router.post('/roster', function(req, res) {
  var instanceId = nodeInstanceId(req);
  if (!instanceId) return res.status(400).json({ code: 400, message: '缺少 X-Cluss-Instance 头' });

  var items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) {
    return res.json({ code: 200, message: 'ok', data: { roster_version: parseInt(initDb.getMeta('roster_version', '0'), 10) || 0, accepted: 0 } });
  }
  if (items.length > 2000) return res.status(400).json({ code: 400, message: '单次名册最多 2000 人' });

  // 额度只在「节点已经追平中枢的额度版本」时才允许回写。
  //
  // 反过来的场景才是危险的：管理员刚在中枢给这个学生充了值（assign_version
  // 已 bump，但节点下一轮才拉），节点却先一步把自己**改之前**的旧额度报了
  // 上来 —— 中枢若照单全收，那笔充值就被节点自己的上报抹掉了，钱凭空消失。
  // 所以节点落后时不更新额度，名单照常更新（名单不会丢东西）。
  var nodeAssignVersion = parseInt(req.body.assign_version, 10);
  if (isNaN(nodeAssignVersion)) nodeAssignVersion = -1;
  var quotaWritable = nodeAssignVersion >= currentAssignVersion();

  var now = time.nowUtc();
  var upsert = db.prepare([
    'INSERT INTO sync_roster (user_id, instance_id, class_no, net_name, real_name, is_admin, status, synced_at,',
    '  allocated_micro, weekly_quota_micro)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'ON CONFLICT(user_id) DO UPDATE SET instance_id = excluded.instance_id,',
    '  class_no = excluded.class_no, net_name = excluded.net_name,',
    '  real_name = excluded.real_name, is_admin = excluded.is_admin,',
    '  status = excluded.status, synced_at = excluded.synced_at',
    // 额度用 CASE 门控：不写额度时保持原值，绝不退化成 0
    '  , allocated_micro = CASE WHEN ? = 1 THEN excluded.allocated_micro ELSE sync_roster.allocated_micro END,',
    '  weekly_quota_micro = CASE WHEN ? = 1 THEN excluded.weekly_quota_micro ELSE sync_roster.weekly_quota_micro END',
    // 节点追平版本后上报 = 「中枢那次改动的意图已经落地」，可以清标记了。
    // 节点落后时不动它，否则「中枢刚改、节点拿旧值上报」会把意图抹掉，
    // 归零就又传不下去了（迁移 030 的由来）。
    '  , hub_quota_set = CASE WHEN ? = 1 THEN 0 ELSE sync_roster.hub_quota_set END'
  ].join('\n'));

  var accepted = 0;
  var rejected = 0;
  // 撞号保护：user_id 是主键，但**学号并不全局唯一** —— 各班的管理员账号
  // 都叫 999999（实测 8 班与 18 班同时存在）。若不拦，后上报的班会把前一个班
  // 的那一行连 instance_id 一起抢走，前一个班的学生就从名册里消失、
  // 额度也再收不到下发。
  //
  // 不改成 (instance_id, user_id) 联合主键是因为：普通学生的学号自带班号
  // （YYCCNN，如 250800 = 25 级 08 班），跨班天然不重复；真正会撞的只有
  // 999999 这类固定账号，为它动主键不值得。先到先得 + 显式拒绝即可。
  var existing = {};
  db.prepare('SELECT user_id, instance_id FROM sync_roster').all().forEach(function(r) {
    existing[r.user_id] = r.instance_id;
  });

  var tx = db.transaction(function() {
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var uid = String(it.user_id || '').trim();
      if (!uid) continue;
      if (existing[uid] && existing[uid] !== instanceId) {
        rejected++;
        continue;
      }
      upsert.run(
        uid,
        instanceId,
        String(it.class_no || '').trim(),
        String(it.net_name || '').trim(),
        String(it.real_name || '').trim(),
        Number(it.is_admin) === 1 ? 1 : 0,
        String(it.status || 'active').trim() || 'active',
        now,
        Math.max(0, Math.round(Number(it.allocated_micro) || 0)),
        Math.max(0, Math.round(Number(it.weekly_quota_micro) || 0)),
        quotaWritable ? 1 : 0,
        quotaWritable ? 1 : 0,
        quotaWritable ? 1 : 0
      );
      accepted++;
    }
  });

  try {
    tx();
  } catch (err) {
    console.error('[Sync] 名册落地失败:', err.message);
    return res.status(500).json({ code: 500, message: '名册落地失败' });
  }

  var version = initDb.bumpMeta('roster_version');
  console.log('[Sync] 节点 %s 上报名册：%d 人%s（v%s）', instanceId, accepted,
    rejected ? '，撞号拒绝 ' + rejected + ' 人' : '', version);
  res.json({
    code: 200,
    message: 'ok',
    data: { roster_version: version, accepted: accepted, rejected: rejected }
  });
});

// ============================================================
// GET /sync/roster —— 全校名册下发（**仅席位班**）
// ============================================================
//
// 403 不是错误而是设计：非席位班的镜像表应当永远是空的（026 迁移边界 2），
// 中枢不能因为它问了就给 —— 各班学生名单不是各班都需要知道的东西。
//
// 额度读镜像而不是 JOIN 中枢账本：外班学生在中枢的 cluss_credit 里没有行，
// JOIN 出来一律 0（曾实测为 0 而实际有 ¥6666）。权威额度由他自己的班随名册
// 上报（POST /roster），镜像里的值就是最新的那份。
router.get('/roster', function(req, res) {
  var instanceId = nodeInstanceId(req);
  if (!isSeatNode(instanceId)) {
    return res.status(403).json({ code: 403, message: '本班不是管理员席位，不同步全校名册' });
  }

  var orgId = req.nodeOrg ? req.nodeOrg.id : '';
  var rows = db.prepare([
    'SELECT r.user_id, r.instance_id, r.class_no, r.net_name, r.real_name, r.is_admin, r.status,',
    // 额度直接取镜像：权威值是他自己那个班报上来的（见 POST /roster）。
    // 原来 JOIN 中枢的 cluss_credit，而外班学生在里面根本没有行 → 一律显示 0，
    // 管理员看着「这学生没钱」去充值，一叠加就从零算起，账就错了。
    '  COALESCE(r.allocated_micro, 0) AS allocated_micro,',
    '  COALESCE(r.weekly_quota_micro, 0) AS weekly_quota_micro,',
    '  COALESCE(u.used_micro, 0) AS used_micro,',
    '  COALESCE(u.calls, 0) AS calls,',
    "  COALESCE(u.last_at, '') AS last_at",
    'FROM sync_roster r',
    'LEFT JOIN (',
    '  SELECT user_id, SUM(cost_micro) AS used_micro, COUNT(*) AS calls, MAX(created_at) AS last_at',
    '  FROM cluss_usage_log WHERE org_id = ? GROUP BY user_id',
    ') u ON u.user_id = r.user_id',
    'ORDER BY r.user_id'
    // 只剩 cluss_usage_log 那一个 ? 了：额度已改从镜像读，不再 JOIN 账本
  ].join('\n')).all(orgId);

  res.json({
    code: 200,
    message: 'ok',
    data: {
      roster_version: parseInt(initDb.getMeta('roster_version', '0'), 10) || 0,
      roster: rows.map(function(r) {
        return {
          user_id: r.user_id,
          instance_id: r.instance_id,
          class_no: r.class_no,
          net_name: r.net_name,
          real_name: r.real_name,
          is_admin: r.is_admin,
          status: r.status,
          allocated_micro: r.allocated_micro,
          weekly_quota_micro: r.weekly_quota_micro,
          used_micro: r.used_micro,
          calls: r.calls,
          last_at: r.last_at
        };
      })
    }
  });
});

module.exports = router;
