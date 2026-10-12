// 节点同步服务（node 模式专用）
//
// 职责：
//   1. 轻量轮询中继的 assign_version；版本变了才拉全量分配快照（省流量）
//   2. 同一次轮询顺路对比 model_config_version，变了拉模型配置快照并整表替换
//   3. 把本班的用量明细上报给中继（中继据此做全网对账）
//   4. 每次同步在请求头里顺路心跳（instance_id + 已应用版本号），中继据此
//      维护节点注册表 —— 不发独立心跳请求，同步本来就够密了
//
// 容错原则：**同步失败绝不能影响学生使用**。
// 所有请求失败只记日志、下次重试；额度沿用本地已有分配，配合同步容错额继续放行。

var axios = require('axios');
var config = require('../config');
var credit = require('./credit');
var modelConfig = require('./model-config');
var db = require('../utils/db');
var time = require('../utils/time');
var initDb = require('../utils/init-db');

var TIMEOUT_MS = 8000;

// 同步状态（管理台/健康检查可读）
var status = {
  enabled: false,
  last_ok_at: null,
  last_error: '',
  last_error_at: null,
  assign_version: 0,
  pulled_at: null,
  model_version: 0,
  model_pulled_at: null,
  reported_total: 0,
  pending_usage: 0
};

function isEnabled() {
  return config.mode === config.MODES.NODE && !!(config.relay.url && config.relay.secret);
}

// 身份头：所有同步请求都带，中继据此心跳 + 看配置到达情况。
// 老中继不认识这些头也没关系（HTTP 头就是给服务器自由裁量的）。
// X-Cluss-Org：Cloud 多租户的学校编号（留空 = 自托管单校，走全局共享密钥）
function headers() {
  var h = {
    'Content-Type': 'application/json',
    'X-Cluss-Secret': config.relay.secret,
    'X-Cluss-Instance': config.instanceId,
    'X-Cluss-Node-Version': config.version,
    'X-Cluss-Assign-Version': String(localAssignVersion()),
    'X-Cluss-Model-Version': String(localModelVersion())
  };
  if (config.relay.orgId) h['X-Cluss-Org'] = config.relay.orgId;
  return h;
}

function localAssignVersion() {
  return parseInt(initDb.getMeta('assign_version', '0'), 10) || 0;
}

function localModelVersion() {
  return parseInt(initDb.getMeta('model_config_version', '0'), 10) || 0;
}

function markError(err) {
  status.last_error = err && err.message ? err.message : String(err);
  status.last_error_at = time.nowUtc();
  console.warn('[Sync] 失败:', status.last_error);
}

function markOk() {
  status.last_ok_at = time.nowUtc();
  status.last_error = '';
}

// ---- 拉取额度分配快照 ----
function fetchAssignments() {
  return axios.get(config.relay.url + '/api/sync/assignments', {
    timeout: TIMEOUT_MS, headers: headers()
  }).then(function(resp) {
    var data = resp.data && resp.data.data;
    var version = (data && data.assign_version) || 0;
    var list = (data && data.assignments) || [];
    var applied = 0;

    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      // 只对该节点已存在的用户落地：节点上没有这个账号，分配过来也没有意义
      var exists = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(String(a.user_id));
      if (!exists) continue;

      credit.applyAssignment({
        user_id: a.user_id,
        allocated_micro: a.allocated_micro,
        weekly_quota_micro: a.weekly_quota_micro,
        assigned_by: a.assigned_by,
        origin_instance: 'relay',
        kind: 'topup',
        reason: '中继下发',
        // 幂等键由「用户 + 分配值 + 版本」构成：同一次分配重复拉取不会重复记流水
        idem_key: 'relay:' + a.user_id + ':' + a.allocated_micro + ':' + a.weekly_quota_micro
      });
      applied++;
    }

    initDb.setMeta('assign_version', version);
    status.assign_version = version;
    status.pulled_at = time.nowUtc();
    console.log('[Sync] 已拉取额度分配: 版本 %s，落地 %d 条', version, applied);
    return { version: version, applied: applied };
  });
}

// ---- 拉取模型配置快照并整表替换（§5：不做增量）----
function fetchModelConfig() {
  return axios.get(config.relay.url + '/api/sync/model-config', {
    timeout: TIMEOUT_MS, headers: headers()
  }).then(function(resp) {
    var data = (resp.data && resp.data.data) || {};
    var version = data.model_config_version || 0;

    // 全量快照直接落地；重复拉同一版本无害（整表替换幂等）
    var result = modelConfig.applySnapshot(data);
    initDb.setMeta('model_config_version', version);
    status.model_version = version;
    status.model_pulled_at = time.nowUtc();
    console.log('[Sync] 已拉取模型配置: 版本 %s，模型 %d 条，源 %d 条',
      version, result.applied, result.sources);
    return { version: version, models: result.applied };
  });
}

// ---- 版本轮询：一次 /version 拿两个版本号，按需拉全量 ----
//
// force（启动与管理台「立即同步」）：不信任本机版本号残留 —— 比如换了中继、
// 导入了旧库，版本号碰巧相同就会漏拉。宁可多传两次几 KB 的全量，也不带
// 陈旧配置上线。
function pollOnce(force) {
  if (force) {
    // 各自兜底：老中继没有 /sync/model-config（404）时，额度分配照常落地，
    // 不能因为模型配置这一路失败就把启动同步整体标成失败
    return Promise.all([
      fetchAssignments().catch(function(err) { markError(err); return null; }),
      fetchModelConfig().catch(function(err) { markError(err); return null; })
    ]).then(function() { return { changed: true, forced: true }; });
  }

  return axios.get(config.relay.url + '/api/sync/version', {
    timeout: TIMEOUT_MS, headers: headers()
  }).then(function(resp) {
    var remote = (resp.data && resp.data.data) || {};
    var remoteAssign = remote.assign_version || 0;
    var remoteModel = remote.model_config_version || 0;
    status.assign_version = remoteAssign;
    status.model_version = remoteModel;

    var jobs = [];
    if (remoteAssign !== localAssignVersion()) jobs.push(fetchAssignments());
    if (remoteModel !== localModelVersion()) jobs.push(fetchModelConfig());

    if (!jobs.length) {
      markOk();
      return { changed: false };
    }
    return Promise.all(jobs).then(function() {
      markOk();
      return { changed: true };
    });
  }).catch(function(err) {
    markError(err);
    return { changed: false, error: status.last_error };
  });
}

// ---- 上报用量明细 ----
function reportUsage() {
  var rows = credit.takeUnsyncedUsage(200);
  status.pending_usage = rows.length;
  if (!rows.length) return Promise.resolve({ reported: 0 });

  var records = rows.map(function(r) {
    return {
      user_id: r.user_id,
      conversation_id: r.conversation_id,
      model_id: r.model_id,
      prompt_tokens: r.prompt_tokens,
      completion_tokens: r.completion_tokens,
      cache_hit_tokens: r.cache_hit_tokens,
      cache_miss_tokens: r.cache_miss_tokens,
      total_tokens: r.total_tokens,
      cost_micro: r.cost_micro,
      estimated: r.estimated,
      // 新增字段：中继侧按列名显式接收，旧节点缺这些字段也能正常入库
      source: r.source || 'chat',
      trace_id: r.trace_id || '',
      image_count: r.image_count || 0,
      created_at: r.created_at,
      local_id: r.id
    };
  });

  return axios.post(config.relay.url + '/api/sync/usage', {
    instance_id: config.instanceId,
    records: records
  }, { timeout: TIMEOUT_MS, headers: headers() }).then(function() {
    credit.markUsageSynced(rows.map(function(r) { return r.id; }));
    status.reported_total += records.length;
    status.pending_usage = 0;
    markOk();
    console.log('[Sync] 已上报用量 %d 条', records.length);
    return { reported: records.length };
  }).catch(function(err) {
    markError(err);
    // 不标记 synced，下次继续上报
    return { reported: 0, error: status.last_error };
  });
}

// ---- 启动定时任务 ----
var timers = [];

// ---- 向 Cluss-Cloud 申请账号绑定确认码（只有班管手动触发）----
//
// 绑定是把「本班班管」和「云端学校管理员」认成同一个人，解决两套账号、
// 两个密码的困扰（换届/交接时最容易出岔）。方向**必须**是设备发起：
// 云端不存班级密码，网页上填学号等于谁都能声称自己是任何人；只有本机
// 能作证「此刻登录的这个人就是本班学号 X，而且他是班管」。
// 所以这里把当前登录人的 user_id 随请求带上去，云端再回一个一次性确认码，
// 由那位管理员用自己的密码在网页上确认，两头对上才认作同一人。
//
// 中继不支持这个端点（自托管 relay，或云端尚未部署新版本）时只会 404，
// 页面把服务端的话原样显示给班管，不做任何猜测。
function requestBindCode(adminUsername, classUserId) {
  if (!isEnabled()) return Promise.reject(new Error('本机未接入中继（当前不是 node 模式）'));
  return axios.post(config.relay.url + '/api/sync/bind-request', {
    admin_username: String(adminUsername || '').trim().toLowerCase(),
    class_user_id: String(classUserId || '').trim(),
    class_admin: true
  }, { timeout: TIMEOUT_MS, headers: headers() }).then(function(resp) {
    var data = (resp.data && resp.data.data) || {};
    if (!data.bind_code) throw new Error('中继没有返回确认码（可能不是 Cluss-Cloud）');
    console.log('[Sync] 已申请账号绑定确认码（云端管理员 %s）', data.admin_username);
    return data;
  }).catch(function(err) {
    // axios 的默认报错是 "Request failed with status code 403"，把云端写好的
    // 人话丢干净了。绑定失败的每一种都是「身份对不上」，班管必须看到具体是哪一处，
    // 所以这里把响应体里的 message 捞出来重新抛。
    var payload = (err && err.response && err.response.data) || null;
    var msg = payload && payload.message;
    throw new Error(msg || (err && err.message ? err.message : String(err)));
  });
}

function start() {
  if (!isEnabled()) {
    if (config.mode === config.MODES.NODE) {
      console.warn('[Sync] node 模式但未配置 CLUSS_RELAY_URL / CLUSS_SHARED_SECRET，额度将不会自动同步');
    }
    return;
  }

  status.enabled = true;
  console.log('[Sync] 已启动：中继 %s，拉取间隔 %ds，上报间隔 %ds',
    config.relay.url, config.relay.syncIntervalSec, config.relay.reportIntervalSec);

  // 启动即同步一次，避免第一次使用等一个周期
  pollOnce(true).then(function() { return reportUsage(); });

  var pullTimer = setInterval(function() {
    pollOnce(false);
  }, config.relay.syncIntervalSec * 1000);
  if (pullTimer.unref) pullTimer.unref();
  timers.push(pullTimer);

  var reportTimer = setInterval(function() {
    reportUsage();
  }, config.relay.reportIntervalSec * 1000);
  if (reportTimer.unref) reportTimer.unref();
  timers.push(reportTimer);
}

function stop() {
  for (var i = 0; i < timers.length; i++) clearInterval(timers[i]);
  timers = [];
}

function getStatus() {
  return {
    enabled: status.enabled,
    mode: config.mode,
    relay_url: config.relay.url,
    assign_version: status.assign_version,
    pulled_at: status.pulled_at,
    model_version: status.model_version,
    model_pulled_at: status.model_pulled_at,
    last_ok_at: status.last_ok_at,
    last_error: status.last_error,
    last_error_at: status.last_error_at,
    reported_total: status.reported_total,
    pending_usage: status.pending_usage
  };
}

module.exports = {
  isEnabled: isEnabled,
  start: start,
  stop: stop,
  pollOnce: pollOnce,
  reportUsage: reportUsage,
  getStatus: getStatus,
  requestBindCode: requestBindCode
};
