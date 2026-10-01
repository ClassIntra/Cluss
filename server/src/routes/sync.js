// 中继同步接口（relay 模式专用）
//
// 班级节点通过这三个接口与中继交互：
//   GET  /sync/version   轻量轮询：本机分配版本号（节点据此判断是否需要拉全量）
//   GET  /sync/assignments  拉取额度分配快照
//   POST /sync/usage     上报本班用量明细（中继据此做全网对账）
//
// 认证：X-Cluss-Secret 头，值等于两端配置的 CLUSS_SHARED_SECRET。
// 未配置密钥时**拒绝服务**（而不是放行），避免局域网内任意机器伪造上报。

var express = require('express');
var router = express.Router();
var db = require('../utils/db');
var time = require('../utils/time');
var config = require('../config');
var constants = require('../utils/constants');
var adminRoutes = require('./admin');

function requireSharedSecret(req, res, next) {
  if (!config.relay.secret) {
    return res.status(503).json({ code: 503, message: '中继未配置 CLUSS_SHARED_SECRET，拒绝同步请求' });
  }
  var provided = req.headers['x-cluss-secret'] || '';
  if (!constants.safeCompare(String(provided), config.relay.secret)) {
    return res.status(403).json({ code: 403, message: '密钥校验失败' });
  }
  next();
}

// 只有 relay 模式才对外提供服务
function requireRelayMode(req, res, next) {
  if (config.mode !== config.MODES.RELAY) {
    return res.status(404).json({ code: 404, message: '当前实例不是中继节点' });
  }
  next();
}

router.use(requireRelayMode);
router.use(requireSharedSecret);

// ============================================================
// GET /sync/version
// ============================================================
router.get('/version', function(req, res) {
  res.json({
    code: 200,
    message: 'ok',
    data: {
      instance_id: config.instanceId,
      assign_version: parseInt(require('../utils/init-db').getMeta('assign_version', '0'), 10) || 0,
      server_time: time.nowUtc()
    }
  });
});

// ============================================================
// GET /sync/assignments —— 额度分配快照
// 返回全部有分配的用户（量级为「已充值学生数」，通常几百行，可整体下发）
// ============================================================
router.get('/assignments', function(req, res) {
  var rows = db.prepare([
    'SELECT user_id, allocated_micro, weekly_quota_micro, assigned_by, updated_at',
    'FROM cluss_credit WHERE allocated_micro > 0'
  ].join('\n')).all();

  res.json({
    code: 200,
    message: 'ok',
    data: {
      assign_version: parseInt(require('../utils/init-db').getMeta('assign_version', '0'), 10) || 0,
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
// POST /sync/usage —— 接收班级节点上报的用量明细
// body: { instance_id, records: [{ user_id, conversation_id, model_id, tokens..., cost_micro, created_at, local_id }] }
// ============================================================
router.post('/usage', function(req, res) {
  var instanceId = String(req.body.instance_id || '').trim();
  var records = Array.isArray(req.body.records) ? req.body.records : [];

  if (!instanceId) return res.status(400).json({ code: 400, message: '缺少 instance_id' });
  if (records.length > 500) return res.status(400).json({ code: 400, message: '单次上报最多 500 条' });

  var insert = db.prepare([
    'INSERT INTO cluss_usage_log (user_id, conversation_id, model_id, prompt_tokens, completion_tokens,',
    '  cache_hit_tokens, cache_miss_tokens, total_tokens, cost_micro, estimated, origin_instance, synced, created_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
  ].join('\n'));

  var accepted = 0;
  var tx = db.transaction(function() {
    for (var i = 0; i < records.length; i++) {
      var r = records[i] || {};
      if (!r.user_id) continue;
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

  console.log('[Sync] 收到节点上报: %s，%d 条', instanceId, accepted);
  res.json({ code: 200, message: 'ok', data: { accepted: accepted } });
});

module.exports = router;