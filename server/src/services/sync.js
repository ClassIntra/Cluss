// 节点同步服务（node 模式专用）
//
// 职责：
//   1. 轻量轮询中继的 assign_version；版本变了才拉全量分配快照（省流量）
//   2. 把本班的用量明细上报给中继（中继据此做全网对账）
//
// 容错原则：**同步失败绝不能影响学生使用**。
// 所有请求失败只记日志、下次重试；额度沿用本地已有分配，配合同步容错额继续放行。

var axios = require('axios');
var config = require('../config');
var credit = require('./credit');
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
  reported_total: 0,
  pending_usage: 0
};

function isEnabled() {
  return config.mode === config.MODES.NODE && !!(config.relay.url && config.relay.secret);
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-Cluss-Secret': config.relay.secret
  };
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

// ---- 拉取额度分配 ----
function pullAssignments(force) {
  return axios.get(config.relay.url + '/api/sync/version', {
    timeout: TIMEOUT_MS, headers: headers()
  }).then(function(resp) {
    var remoteVersion = (resp.data && resp.data.data && resp.data.data.assign_version) || 0;
    status.assign_version = remoteVersion;

    var localVersion = parseInt(initDb.getMeta('assign_version', '0'), 10) || 0;
    if (!force && remoteVersion === localVersion) {
      markOk();
      return { changed: false, version: remoteVersion };
    }

    return axios.get(config.relay.url + '/api/sync/assignments', {
      timeout: TIMEOUT_MS, headers: headers()
    }).then(function(resp2) {
      var data = resp2.data && resp2.data.data;
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

      initDb.setMeta('assign_version', remoteVersion);
      status.pulled_at = time.nowUtc();
      markOk();
      console.log('[Sync] 已拉取额度分配: 版本 %s，落地 %d 条', remoteVersion, applied);
      return { changed: true, version: remoteVersion, applied: applied };
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
  pullAssignments(true).then(function() { return reportUsage(); });

  var pullTimer = setInterval(function() {
    pullAssignments(false);
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
  pullAssignments: pullAssignments,
  reportUsage: reportUsage,
  getStatus: getStatus
};