// 节点同步服务（node 模式专用）
//
// 职责：
//   1. 轻量轮询中继的 assign_version；版本变了才拉全量分配快照（省流量）
//   2. 同一次轮询顺路对比 model_config_version，变了拉模型配置快照并整表替换
//   3. 把本班的用量明细上报给中继（中继据此做全网对账）
//   4. 每次同步在请求头里顺路心跳（instance_id + 已应用版本号），中继据此
//      维护节点注册表 —— 不发独立心跳请求，同步本来就够密了
//   5. **反过来**：如果本班持有云端的管理员席位，班管在本地改的模型配置与
//      积分分配由本节点推给云端，云端再下发给同校所有班。先推后拉——
//      否则刚改完的东西会被云端版本覆盖回去（这正是原来额度改了会丢的原因）。
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
var constants = require('../utils/constants');

var TIMEOUT_MS = 8000;

// 同步状态（管理台/健康检查可读）
// 字段分三类：本地身份、���端当前版本、本地已应用版本——
// 管理层要看的就是「云端发的是几、我这台装的是几」，两者必须能对比。
var status = {
  enabled: false,
  last_ok_at: null,
  last_error: '',
  last_error_at: null,
  // 最后一次成功上报用量的时刻（pull 是拉取、push 是上报，混在一起看不出问题）
  last_push_at: null,
  last_push_count: 0,
  assign_version: 0,
  pulled_at: null,
  model_version: 0,
  model_pulled_at: null,
  reported_total: 0,
  pending_usage: 0,
  // 云端服务器时间与本机时间的差值（毫秒）。教室机常年不校时，
  // 用量账目跨月统计全靠时间戳，时间偏了账就偏了。
  clock_skew_ms: null,
  server_time: null,
  // 本班是否持有云端的管理员席位（= 能不能改全校配置，由云端 /sync/version 告知）
  is_seat_admin: false,
  seat_instance: '',
  seat_admin_at: null,
  // 本机自己推上去时拿到的云端版本号。「本地推送的不要再拉回来覆盖」就是靠它：
  // 下行判断版本号等于这个值 → 说明云端上那份就是我自己推的，跳过拉取。
  self_pushed_model_version: 0,
  self_pushed_assign_version: 0,
  // 待上行推给云端的变更。推失败不清空，下次轮询重试 —— 断网不能丢管理员的操作。
  pending_policy: false,
  pending_allocations: 0,
  // 上行推最近一次的结果/原因，面板上要能让管理员看到「我改了，到底同步了没」
  last_push_policy_at: null,
  last_push_policy_error: '',
  last_push_alloc_at: null,
  last_push_alloc_error: ''
};

// 上行待推的额度项（内存态）。每项带一个稳定的 idem_key：
// 云端按它去重，所以重试多少次都不会重复记账。
var pendingAllocItems = [];
// 上行待推的模型配置（内存态，只标记「有变更」，内容在推的时候现取快照）
var pendingPolicy = false;

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

    // 和模型配置同理：这一版是本机自己推上去的，内容已经一致，回拉没有意义
    if (version > 0 && version === status.self_pushed_assign_version) {
      status.assign_version = version;
      status.pulled_at = time.nowUtc();
      console.log('[Sync] 云端额度 v%s 是本机自己推的，跳过回拉', version);
      return { version: version, applied: 0 };
    }

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
        // 幂等键必须含版本号。原来的键是「用户+分配值+周配额」，
        // 于是「10 元 → 5 元 → 改回 10 元」的第三步会撞上第一步的键被跳过，
        // 节点额度再也上不去——而管理员改错了改回来是最常见的操作。
        idem_key: 'relay:' + a.user_id + ':' + version + ':' + a.allocated_micro
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
    var models = data.models || [];

    // 云端没有配置时**不动本机**。
    //
    // applySnapshot 是「先 DELETE 再插入」的整表替换（设计如此：云端删掉的模型
    // 不许在节点上残留）。所以只要云端是空的，下发空快照就等于把本机配置
    // 全清空 —— 而云端在平台还没发布任何配置时（model_config_version = 0）
    // 恰恰就是空的。于是每 60 秒清一次，管理员配好的模型凭空消失。
    //
    // 这里把「云端从未配置过」与「云端配置了但是空的」区分开：
    //   · version <= 0 = 从未发布过 → 保留本机，等云端有东西了再接管
    //   · version > 0 且 models 为空 = 云端明确清空 → 尊重它
    var localModels = db.prepare('SELECT COUNT(*) AS c FROM ai_models').get();
    if (version <= 0 && localModels && localModels.c > 0) {
      status.model_version = 0;
      status.model_pulled_at = time.nowUtc();
      console.log('[Sync] 云端尚未发布模型配置（v0），保留本机 %d 个模型不改', localModels.c);
      return { version: 0, models: localModels.c, skipped: true };
    }

    // 云端这一版就是本机自己推上去的：内容本来就一样，重复拉一遍只会
    // 有机会把「刚推的」当成「别人的」再覆盖一遍。跳过。
    if (version > 0 && version === status.self_pushed_model_version) {
      console.log('[Sync] 云端模型配置 v%s 是本机自己推的，跳过回拉', version);
      status.model_version = version;
      status.model_pulled_at = time.nowUtc();
      return { version: version, models: localModels ? localModels.c : 0, skipped: true };
    }

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
  // 先推后拉：班管刚在本机改的东西，必须先上行到云端，再拉云端权威版本。
  // 顺序反了的话，本机改动会被云端版本直接覆盖回去——这正是原来
  // 「老师改了额度，学生那边却没变」的原因。
  var seatUser = pendingSeatUser();
  return pushPending(seatUser).then(function() {
    return doPoll(force);
  });
}

// 上行需要知道「当前登录的班管是谁」，而定时器里拿不到请求上下文。
// 路由在处理管理员写操作时调 rememberSeatUser() 记下最近一次的操作者。
var lastSeatUserId = '';
function rememberSeatUser(userId) {
  var u = String(userId || '').trim();
  if (u) lastSeatUserId = u;
}
function pendingSeatUser() {
  return lastSeatUserId;
}

function doPoll(force) {
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

    // 云端也回自己的时间。用它校正本机时钟偏移——教室电脑常年不校时，
    // 而用量记账按时间戳跨月统计，时间偏了账就偏了。
    if (remote.server_time) {
      var skew = Date.parse(String(remote.server_time).replace(' ', 'T') + 'Z') - Date.now();
      if (isFinite(skew)) {
        status.clock_skew_ms = skew;
        status.server_time = remote.server_time;
      }
    }

    // 本班是不是云端管理员席位 —— 以云端为准，本机无权自封。
    // 决定班管在本地能不能改全校配置（模型/积分），非席位班只读。
    if (remote.is_seat_admin !== undefined) {
      var wasSeat = status.is_seat_admin;
      status.is_seat_admin = !!remote.is_seat_admin;
      status.seat_instance = remote.seat_instance || '';
      if (status.is_seat_admin) status.seat_admin_at = time.nowUtc();
      if (wasSeat !== status.is_seat_admin) {
        console.log('[Sync] 本班管理员席位状态: %s', status.is_seat_admin ? '已获得（可改全校配置）' : '无（只读）');
      }
    }

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
    status.last_push_at = time.nowUtc();
    status.last_push_count = records.length;
    markOk();
    console.log('[Sync] 已上报用量 %d 条', records.length);
    return { reported: records.length };
  }).catch(function(err) {
    markError(err);
    // 不标记 synced，下次继续上报
    return { reported: 0, error: status.last_error };
  });
}

// ============================================================
// 配置上行写：本班持有管理员席位时，班管在本地改的推给云端 → 全校
// ============================================================
//
// 谁有权推：云端说了算（/sync/version 里的 is_seat_admin）。本机无权自己
// 认定 —— 否则断网时也能自封管理员，一个班接上云端就能改全校配置。
//
// 幂等与冲突：
//   · 每条额度带稳定 idem_key（内容哈希），云端据此去重，重试不会重复记账；
//   · 推的时候带上 base_version，云端比对当前版本，不一致回 409 ——
//     这期间若平台运营者或别的班改过，本机提示刷新，而不是静默覆盖全校配置。
//
// 失败绝不丢管理员的操作：待推队列留在内存，下次轮询继续推。

function isConflict(err) {
  return !!(err && err.response && err.response.status === 409);
}

// 班管在本机改了模型配置/视觉/峰谷之后调用：标脏，等下一轮推
function markPolicyDirty() {
  pendingPolicy = true;
  status.pending_policy = true;
}

// 班管在本机改了某个学生的额度之后调用：入队，等下一轮推
function queueAllocation(userId, allocatedMicro, weeklyMicro, reason, classUserId) {
  var uid = String(userId || '').trim();
  if (!uid) return;
  // 同一学生只保留最新一条：管理员连点两次，第二次才是他真正想要的
  for (var i = 0; i < pendingAllocItems.length; i++) {
    if (pendingAllocItems[i].user_id === uid) { pendingAllocItems.splice(i, 1); break; }
  }
  // 幂等键含「入队时看到的云端版本」。
  //
  // 为什么不是金额哈希：原来键是「实例+学号+额度值+周配额」，于是「10元 →
  // 5元 → 改回 10元」的第三步与第一步键相同，被云端当成重放跳过 ——
  // 而「改错了改回来」是最常见的操作，学生额度就再也回不去。
  //
  // 为什么版本要在**入队时**取而不是推送时：推送成功会把 status.assign_version
  // 更新成云端的新值，若键在推送时才算，同一条待推项重试就会换一个键 ——
  // 幂等保护等于没有。键在入队时固定，重试天然稳定；新的改动才会读到新版本。
  var queuedAt = status.assign_version;
  pendingAllocItems.push({
    user_id: uid,
    allocated_micro: Math.max(0, Math.round(Number(allocatedMicro) || 0)),
    weekly_quota_micro: Math.max(0, Math.round(Number(weeklyMicro) || 0)),
    reason: String(reason || '班管在本机调整'),
    class_user_id: String(classUserId || '').trim(),
    idem_key: constants.makeIdemKey(['up', config.instanceId, uid, allocatedMicro, weeklyMicro, queuedAt])
  });
  status.pending_allocations = pendingAllocItems.length;
}

// 把本机的模型配置快照推给云端
function pushModelConfig(classUserId) {
  if (!pendingPolicy) return Promise.resolve({ pushed: 0 });
  if (!status.is_seat_admin) {
    // 不是席位班：这不是错误，只是本班没有写入权。别刷错误日志，
    // 但要让面板能显示「本班改的不会同步全校」。
    status.last_push_policy_error = '本班不是管理员席位，改动只在本机生效';
    return Promise.resolve({ pushed: 0, notSeat: true });
  }
  if (!classUserId) {
    status.last_push_policy_error = '未登录班管账号，无法确认改动者身份';
    return Promise.resolve({ pushed: 0 });
  }
  var snap = modelConfig.snapshot();
  return axios.post(config.relay.url + '/api/sync/policy', {
    base_version: status.model_version,   // 我读到的是哪一版；云端比对不上就 409
    class_user_id: classUserId,
    class_admin: true,
    config: { models: snap.models, sources: snap.sources, meta: snap.meta }
  }, { timeout: TIMEOUT_MS, headers: headers() }).then(function(resp) {
    var data = (resp.data && resp.data.data) || {};
    pendingPolicy = false;
    status.pending_policy = false;
    status.last_push_policy_error = '';
    status.last_push_policy_at = time.nowUtc();
    // 云端返回的权威版本号：本机立刻对齐，避免下一轮又去拉一次
    if (data.model_config_version) {
      status.model_version = data.model_config_version;
      status.self_pushed_model_version = data.model_config_version;
      initDb.setMeta('model_config_version', data.model_config_version);
    }
    console.log('[Sync] 已上行模型配置到云端: v%s', data.model_config_version);
    return { pushed: 1, version: data.model_config_version };
  }).catch(function(err) {
    if (isConflict(err)) {
      // 云端已被别人改过：清掉待推标记（否则会一直推、一直 409），
      // 但保留错误，让面板提示班管刷新。云端版本会在下一轮下行拉取时对齐。
      pendingPolicy = false;
      status.pending_policy = false;
      var msg = ((err.response && err.response.data) || {}).message || '云端配置已被改动';
      status.last_push_policy_error = msg;
      console.warn('[Sync] 模型配置上行被拒（云端已变更）:', msg);
      return { pushed: 0, conflict: true, error: msg };
    }
    status.last_push_policy_error = (err && err.message) || String(err);
    return { pushed: 0, error: status.last_push_policy_error };
  });
}

// 把待推的额度推给云端
function pushAllocations() {
  if (!pendingAllocItems.length) return Promise.resolve({ pushed: 0 });
  if (!status.is_seat_admin) {
    status.last_push_alloc_error = '本班不是管理员席位，改动只在本机生效';
    return Promise.resolve({ pushed: 0, notSeat: true });
  }
  var batch = pendingAllocItems.slice();
  // 逐条带上发起人学号（席位校验要求与绑定记录一致）
  var items = batch.map(function(it) {
    return {
      user_id: it.user_id,
      allocated_micro: it.allocated_micro,
      weekly_quota_micro: it.weekly_quota_micro,
      reason: it.reason,
      idem_key: it.idem_key,
      class_user_id: it.class_user_id
    };
  });
  // 同一批里学号取第一个的（正常情况整批都来自同一次管理员操作）
  var byUser = {};
  items.forEach(function(it) { if (it.class_user_id && !byUser.user) byUser.user = it.class_user_id; });

  return axios.post(config.relay.url + '/api/sync/allocations', {
    base_version: status.assign_version,
    class_user_id: byUser.user || '',
    class_admin: true,
    items: items
  }, { timeout: TIMEOUT_MS, headers: headers() }).then(function(resp) {
    var data = (resp.data && resp.data.data) || {};
    // 全部出队（云端按 idem_key 跳过重复的，所以这里全清是对的）
    pendingAllocItems = [];
    status.pending_allocations = 0;
    status.last_push_alloc_error = '';
    status.last_push_alloc_at = time.nowUtc();
    if (data.assign_version) {
      status.assign_version = data.assign_version;
      status.self_pushed_assign_version = data.assign_version;
      initDb.setMeta('assign_version', data.assign_version);
    }
    console.log('[Sync] 已上行额度到云端: %s 条生效、%s 条跳过', data.applied, data.skipped);
    return { pushed: data.applied || 0, skipped: data.skipped || 0 };
  }).catch(function(err) {
    if (isConflict(err)) {
      pendingAllocItems = [];
      status.pending_allocations = 0;
      var msg = ((err.response && err.response.data) || {}).message || '云端额度已被改动';
      status.last_push_alloc_error = msg;
      console.warn('[Sync] 额度上行被拒（云端已变更）:', msg);
      return { pushed: 0, conflict: true, error: msg };
    }
    // 普通失败（断网/超时）：保留队列，下轮重试
    status.last_push_alloc_error = (err && err.message) || String(err);
    return { pushed: 0, error: status.last_push_alloc_error };
  });
}

// 一次把待推的都推出去
function pushPending(classUserId) {
  if (!isEnabled()) return Promise.resolve({});
  return pushModelConfig(classUserId).then(function() {
    return pushAllocations();
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
  var localAssign = localAssignVersion();
  var localModel = localModelVersion();
  return {
    enabled: status.enabled,
    mode: config.mode,
    relay_url: config.relay.url,
    // 学校编号：管理员在云端注册时拿到的那个码。本地管理台没有它就没法
    // 确认「我接的是哪所学校」，客服排查时第一句就要问这个。
    org_id: config.relay.orgId || '',
    instance_id: config.instanceId,
    node_version: config.version,
    // 云端当前版本 vs 本机已应用版本：两者不等就说明还有配置在路上
    // （或拉取失败了），管理台要能一眼看出来，而不是让人去翻日志。
    assign_version: status.assign_version,
    local_assign_version: localAssign,
    assign_pending: status.assign_version !== localAssign,
    model_version: status.model_version,
    local_model_version: localModel,
    model_pending: status.model_version !== localModel,
    pulled_at: status.pulled_at,
    model_pulled_at: status.model_pulled_at,
    last_ok_at: status.last_ok_at,
    last_error: status.last_error,
    last_error_at: status.last_error_at,
    last_push_at: status.last_push_at,
    last_push_count: status.last_push_count,
    reported_total: status.reported_total,
    pending_usage: status.pending_usage,
    // 上行写入权与待推队列：管理员改了东西之后，面板要能回答
    // 「我改了，到底同步到全校了没」。
    is_seat_admin: status.is_seat_admin,
    seat_instance: status.seat_instance,
    seat_admin_at: status.seat_admin_at,
    self_pushed_model_version: status.self_pushed_model_version,
    self_pushed_assign_version: status.self_pushed_assign_version,
    pending_policy: status.pending_policy,
    pending_allocations: status.pending_allocations,
    last_push_policy_at: status.last_push_policy_at,
    last_push_policy_error: status.last_push_policy_error,
    last_push_alloc_at: status.last_push_alloc_at,
    last_push_alloc_error: status.last_push_alloc_error,
    clock_skew_ms: status.clock_skew_ms,
    server_time: status.server_time
  };
}

module.exports = {
  isEnabled: isEnabled,
  start: start,
  stop: stop,
  pollOnce: pollOnce,
  reportUsage: reportUsage,
  getStatus: getStatus,
  // 上行写（席位班管在本地改 → 同步全校）
  markPolicyDirty: markPolicyDirty,
  queueAllocation: queueAllocation,
  pushPending: pushPending,
  pushModelConfig: pushModelConfig,
  pushAllocations: pushAllocations,
  rememberSeatUser: rememberSeatUser
};
