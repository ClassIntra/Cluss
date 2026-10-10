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
var initDb = require('../utils/init-db');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function currentAssignVersion() {
  return parseInt(initDb.getMeta('assign_version', '0'), 10) || 0;
}

// 只有 relay 模式才对外提供服务
function requireRelayMode(req, res, next) {
  if (config.mode !== config.MODES.RELAY) {
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
    db.prepare([
      'UPDATE cluss_nodes SET last_seen_at = ?, last_assign_version = ?,',
      'last_model_version = ?, node_version = ? WHERE instance_id = ? AND org_id = ?'
    ].join('\n')).run(now, assignV, modelV, nodeV, instanceId, orgId);
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

// ============================================================
// GET /sync/version
// ============================================================
router.get('/version', function(req, res) {
  res.json({
    code: 200,
    message: 'ok',
    data: {
      instance_id: config.instanceId,
      assign_version: currentAssignVersion(),
      model_config_version: modelConfig.currentModelVersion(),
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
  var rows = db.prepare([
    'SELECT user_id, allocated_micro, weekly_quota_micro, assigned_by, updated_at',
    'FROM cluss_credit WHERE allocated_micro > 0 AND org_id = ?'
  ].join('\n')).all(orgId);

  res.json({
    code: 200,
    message: 'ok',
    data: {
      assign_version: currentAssignVersion(),
      assignments: rows.map(function(r) {
        return {
          user_id: r.user_id,
          allocated_micro: r.allocated_micro,
          weekly_quota_micro: r.weekly_quota_micro,
          assigned_by: r.assigned_by,
          updated_at: time.toISO(r.updated_at)
        };
      })
    }
  });
});

// ============================================================
// GET /sync/model-config —— 模型配置快照（§5.2）
// ai_models + ai_sources + 视觉/峰谷 meta，整表替换语义。
// 全网同一份（v1 语义）：上游地址与 Key 由中枢运营者维护，不分校。
// ============================================================
router.get('/model-config', function(req, res) {
  var snap = modelConfig.snapshot();
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

module.exports = router;
