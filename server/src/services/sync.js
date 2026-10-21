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
//   6. 全校花名册：每个班把本班学生报上去，**只有席位班**把全校名册拉回本地
//      当只读镜像。它解决的是「18 班手握写入权，列表里却看不到 8 班学生」，
//      所以只补**看得见**，不给任何一条权限开新口子（见 pushRoster 上方注释）。
//
// 容错原则：**同步失败绝不能影响学生使用**。
// 所有请求失败只记日志、下次重试；额度沿用本地已有分配，配合同步容错额继续放行。

var axios = require('axios');
var crypto = require('crypto');
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
  last_push_alloc_error: '',
  // 全校花名册：只有席位班才有（非席位班拉云端也是 403）。
  // 用途只有一件事 —— 让手握写入权的班管在列表里看得见**别班**学生，
  // 否则「18 班给 8 班充值」在 UI 上根本无从下手（见 026 迁移头注）。
  roster_version: 0,
  roster_pulled_at: null,
  roster_count: 0,
  roster_error: '',
  // 本轮需要强制回拉一次名册。置位场景：本机名册刚推上去（云端版本变了，
  // 但同轮里别的班可能也在推，只比版本号会漏）以及额度推送刚落地
  // （镜像里的余额是乐观值，要拿云端权威值覆盖）。
  roster_refetch_pending: false,
  last_push_roster_at: null,
  last_push_roster_count: 0,
  last_push_roster_error: ''
};

// 上行待推的额度项（内存态）。每项带一个稳定的 idem_key：
// 云端按它去重，所以重试多少次都不会重复记账。
var pendingAllocItems = [];
// 上行待推的模型配置（内存态，只标记「有变更」，内容在推的时候现取快照）
var pendingPolicy = false;

function isEnabled() {
  return config.mode === config.MODES.NODE && !!(config.relay.url && config.relay.secret);
}

// 本机是不是「中枢」（mesh 组网中心 / relay 专职中继）
function isHubInstance() {
  return config.mode === config.MODES.MESH || config.mode === config.MODES.RELAY;
}

// 席位是不是握在自己手里（未设置时默认就是自己）
function seatIsSelf() {
  var seat = String(initDb.getMeta('seat_instance', '') || '').trim();
  return !seat || seat === config.instanceId;
}

// ---- 谁能看全校名册 ----
//
// 两条路径，缺一条「18 班给 8 班充钱」就走不通：
//   · 节点且持有席位 —— 它是从云端拉回的镜像（isEnabled + is_seat_admin）；
//   · **中枢自己** —— 名册是各节点报给它的，表就在本机库里。
//
// 第二种以前被漏掉了：中枢不是 NODE 模式，isEnabled() 恒 false，而
// status.is_seat_admin 只有节点轮询 /sync/version 才会被填上 —— 中枢从不轮询自己，
// 于是它永远 false。结果就是「中枢看得见 8 班的心跳和名册条数，管理台列表里
// 却一个 8 班学生都没有」，充值无从下手。
// 席位移交给别班后中枢同样不该再看（一致性：没席位就没全校可见性）。
function canSeeRoster() {
  if (isHubInstance()) return seatIsSelf();
  return isEnabled() && status.is_seat_admin;
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
  //
  // 花名册排在两者之间：它既要先把本班学生报上去（否则席位班看不到别班），
  // 又要在同轮拿到云端权威名册（本机名册刚变，别班可能也在同轮推过）。
  // 名册每个班都要推，但只有席位班会拉。
  var seatUser = pendingSeatUser();
  return pushPending(seatUser).then(function() {
    return pushRoster();
  }).then(function() {
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
    var boot = [
      fetchAssignments().catch(function(err) { markError(err); return null; })
    ];
    // 「不跟随中枢模型选择」的班，重启后也不能被覆盖一次 ——
    // status 是内存态，这里从 meta 读上一轮记下的开关。
    var bootModelSync = parseInt(initDb.getMeta('model_sync', '1'), 10) !== 0;
    if (bootModelSync) {
      boot.push(fetchModelConfig().catch(function(err) { markError(err); return null; }));
    } else {
      console.log('[Sync] 本班已关闭模型同步，启动时保留本机模型配置');
    }
    // 启动时还不知道本班是不是席位（那要等下面那次轮询告诉咱们），
    // 所以用「以前拉到过花名册」当旁证：拉到过 = 曾经是席位，先补一次。
    // 全新学校第一次启动会等一个轮询周期（≤60s），换来的是非席位班
    // 不会在每次重启时白吃一个 403。
    if (status.is_seat_admin || (parseInt(initDb.getMeta('roster_version', '0'), 10) || 0) > 0) {
      boot.push(fetchRoster());
    }
    return Promise.all(boot).then(function() { return { changed: true, forced: true }; });
  }

  return axios.get(config.relay.url + '/api/sync/version', {
    timeout: TIMEOUT_MS, headers: headers()
  }).then(function(resp) {
    var remote = (resp.data && resp.data.data) || {};
    var remoteAssign = remote.assign_version || 0;
    var remoteModel = remote.model_config_version || 0;

    // 中枢可以按节点关掉模型同步（迁移 031）。关掉后：
    //   · 不拉模型配置（本班保留自己的渠道/Key/单价）
    //   · 也不更新本机记的版本号 —— 中枢靠节点上报的 last_model_version 判断
    //     「跟到第几版」，写成中枢版本会让管理台显示成「已跟上」，实际没跟。
    var modelSync = (remote.model_sync === undefined)
      ? 1 : (Number(remote.model_sync) === 0 ? 0 : 1);
    if (status.model_sync !== modelSync) {
      status.model_sync = modelSync;
      try { initDb.setMeta('model_sync', String(modelSync)); } catch (e) { /* 读不到就下轮再写 */ }
      console.log('[Sync] 模型同步: %s', modelSync ? '跟随中枢' : '已关闭，保留本机配置');
    }

    status.assign_version = remoteAssign;
    if (modelSync === 1) status.model_version = remoteModel;

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
    if (modelSync === 1 && remoteModel !== localModelVersion()) jobs.push(fetchModelConfig());

    // 全校花名册：只有席位班才拉（云端对非席位班一律 403）。
    // 两个触发条件缺一不可 —— 只看版本号会漏掉「本机刚推完、云端同轮又被
    // 别的班改过」这一种；只看置位会漏掉别班自己上报的变化。
    // 老云端没有 roster_version 这个字段时只认置位，不去凑一次必 404 的请求。
    if (remote.is_seat_admin) {
      var remoteRoster = remote.roster_version;
      var rosterStale = (remoteRoster !== undefined && remoteRoster !== status.roster_version);
      if (rosterStale || status.roster_refetch_pending) jobs.push(fetchRoster());
    } else {
      // 本班没有席位 = 不存在「全校名册」这回事，把置位收掉，
      // 免得哪天真的拿到席位时被一个陈旧标记牵着多拉一次。
      status.roster_refetch_pending = false;
    }

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

// ---- 全校花名册：补的是**可见性**，不是权限 ----
//
// 死结（2026-10-19 实测）：席位班手握写入权，本机 users 表却只有本班学生，
// 管理台里根本没有「8 班张三」这一行可点；非席位班看得见自己学生，一提交
// 又被 requireCanEditQuota 403。结果是**谁都不能给 8 班充钱**。
//
// 额度那条路本来就是通的（云端 allocations 全校口径、上行只挡跨校），
// 所以这里只做一件事：把本班学生报上去、把全校名册拉下来当**只读镜像**。
//
// 三条不变：
//   · 本机 users 表照旧只收本班 —— class-roster 的世界边界一个字不动；
//   · 镜像不进 cluss_credit / cluss_usage_log —— 外班的钱与消耗只在云端账本；
//   · 写入权仍由 requireCanEditQuota + 云端 checkSeat 把守，名册只让列表
//     多出几行可点的外班学生。
function rosterPushSignature(items) {
  return crypto.createHash('sha1').update(JSON.stringify(items)).digest('hex');
}

// 上行：把**本班**学生整份报给云端（云端按 instance 整表替换）
function pushRoster() {
  if (!isEnabled()) return Promise.resolve({ pushed: 0, skipped: true });

  var rows;
  try {
    // 额度必须跟着名册一起上行。
    //
    // 学生的钱是**在他自己所在班花掉的**，权威值只可能在那台机器的
    // cluss_credit 里。中枢若不知道这个数，给外班学生充值时就会拿 0 当基数
    // 叠加，算出「从零充起」的错账（实测：8 班学生实际有 ¥6666，中枢看到 0，
    // 充 ¥1 后中枢记成 ¥1）—— 而额度下发是整表覆盖语义，一旦下发就会把
    // 节点上那 ¥6666 直接冲掉。所以这个字段不是可选项，是账本正确性的前提。
    rows = db.prepare([
      'SELECT u.user_id, u.net_name, u.real_name, u.class_no, u.is_admin, u.status,',
      '  COALESCE(c.allocated_micro, 0) AS allocated_micro,',
      '  COALESCE(c.weekly_quota_micro, 0) AS weekly_quota_micro',
      'FROM users u',
      'LEFT JOIN cluss_credit c ON c.user_id = u.user_id',
      'ORDER BY u.user_id'
    ].join('\n')).all();
  } catch (err) {
    // 读不到名册就不能拿空数组去覆盖云端（那会把本班学生从全校名册里抹掉）
    status.last_push_roster_error = '读取本班名册失败: ' + err.message;
    return Promise.resolve({ pushed: 0, error: status.last_push_roster_error });
  }

  var items = rows.map(function(r) {
    return {
      user_id: String(r.user_id || ''),
      class_no: String(r.class_no || ''),
      net_name: String(r.net_name || ''),
      real_name: String(r.real_name || ''),
      is_admin: r.is_admin === 1 ? 1 : 0,
      status: String(r.status || 'active'),
      allocated_micro: Math.max(0, Math.round(Number(r.allocated_micro) || 0)),
      weekly_quota_micro: Math.max(0, Math.round(Number(r.weekly_quota_micro) || 0))
    };
  });

  // 变化判定放本机：云端也有比对，但本机能先省掉这一次网络往返。
  // 每轮一次 SELECT + sha1，远比每分钟一次 HTTP 便宜。
  var sig = rosterPushSignature(items);
  if (sig === String(initDb.getMeta('roster_push_hash', '') || '')) {
    return Promise.resolve({ pushed: 0, unchanged: true, count: items.length });
  }

  return axios.post(config.relay.url + '/api/sync/roster', {
    items: items,
    // 带上本机已应用的额度版本：中枢据此判断「我还有没有没被你拉走的改动」。
    // 落后就说明中枢刚被管理员改过、下发还在路上 —— 这时中枢必须拒绝用
    // 我这边的旧值覆盖，否则那笔充值会在抵达节点前被节点自己的上报抹掉。
    assign_version: localAssignVersion()
  }, { timeout: TIMEOUT_MS, headers: headers() }).then(function(resp) {
    var data = (resp.data && resp.data.data) || {};
    // 成功才记哈希：失败不记 → 下一轮仍然重试（本机名册一直是「没同步」状态）
    initDb.setMeta('roster_push_hash', sig);
    status.last_push_roster_at = time.nowUtc();
    status.last_push_roster_count = items.length;
    status.last_push_roster_error = '';
    // 本机名册刚变，云端那一版里可能夹着同轮别的班推上来的改动，
    // 只比版本号会漏 —— 置位让席位班本轮回拉一次权威名册。
    status.roster_refetch_pending = true;
    console.log('[Sync] 已上行本班名册: %d 人（云端 v%s）', items.length, data.roster_version);
    return { pushed: 1, count: items.length, version: data.roster_version || 0 };
  }).catch(function(err) {
    status.last_push_roster_error = (err && err.message) || String(err);
    return { pushed: 0, error: status.last_push_roster_error };
  });
}

// 下行：拉全校花名册，整表替换本地镜像（云端 403 = 本班不是席位，镜像保持为空）
function fetchRoster() {
  if (!isEnabled()) return Promise.resolve({ count: 0, skipped: true });

  return axios.get(config.relay.url + '/api/sync/roster', {
    timeout: TIMEOUT_MS, headers: headers()
  }).then(function(resp) {
    var data = (resp.data && resp.data.data) || {};
    var list = Array.isArray(data.roster) ? data.roster : [];
    var version = data.roster_version || 0;
    var syncedAt = time.nowUtc();

    var tx = db.transaction(function() {
      db.prepare('DELETE FROM sync_roster').run();
      var ins = db.prepare([
        'INSERT INTO sync_roster (user_id, instance_id, class_no, net_name, real_name, is_admin, status,',
        '  allocated_micro, weekly_quota_micro, used_micro, calls, last_at, synced_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ].join('\n'));
      for (var i = 0; i < list.length; i++) {
        var r = list[i] || {};
        var uid = String(r.user_id || '').trim();
        if (!uid) continue;
        ins.run(
          uid, String(r.instance_id || ''), String(r.class_no || ''),
          String(r.net_name || ''), String(r.real_name || ''),
          r.is_admin ? 1 : 0, String(r.status || 'active'),
          Math.max(0, Math.round(Number(r.allocated_micro) || 0)),
          Math.max(0, Math.round(Number(r.weekly_quota_micro) || 0)),
          Math.max(0, Math.round(Number(r.used_micro) || 0)),
          Math.max(0, Math.round(Number(r.calls) || 0)),
          String(r.last_at || ''), syncedAt
        );
      }
    });
    tx();

    status.roster_version = version;
    status.roster_pulled_at = syncedAt;
    status.roster_count = list.length;
    status.roster_error = '';
    status.roster_refetch_pending = false;
    initDb.setMeta('roster_version', String(version));
    initDb.setMeta('roster_synced_at', syncedAt);
    console.log('[Sync] 已拉取全校花名册: %d 人（v%s）', list.length, version);
    return { count: list.length, version: version };
  }).catch(function(err) {
    // 名册拉不到**不算**同步失败：额度与模型照常走，只是管理台暂时看不到外班。
    // 403 时的措辞对管理员最有用，原样留着。
    status.roster_error = (err && err.message) || String(err);
    status.roster_refetch_pending = false;
    return { count: status.roster_count, error: status.roster_error };
  });
}

// 给管理台用：全校外班学生（已按本机查询条件过滤）
// 返回结构与 GET /admin/users 的行字段对齐，调用方直接套同一个映射函数。
function listRoster(opts) {
  opts = opts || {};
  // 没有席位就没有全校可见性，镜像也应该是空的（云端 403 拉不到）。
  // 兜这一句是因为「席位被解绑」后旧镜像还留在库里 —— 不能继续拿它显示。
  if (!canSeeRoster()) return [];

  var where = [];
  var params = [];
  // 本机有的账号一律以本机账本为准；同时排除本班上报的行（本班学生的
  // 权威数据就在 users/cluss_credit 里，镜像那份只会更旧）
  where.push('r.instance_id <> ?');
  params.push(String(config.instanceId || ''));
  where.push('NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = r.user_id)');

  if (opts.keyword) {
    where.push('(r.user_id LIKE ? OR r.net_name LIKE ? OR r.real_name LIKE ?)');
    var kw = '%' + opts.keyword + '%';
    params.push(kw, kw, kw);
  }
  if (opts.onlyAllocated) where.push('r.allocated_micro > 0');

  var sql = [
    'SELECT r.user_id, r.instance_id, r.class_no, r.net_name, r.real_name, r.is_admin, r.status,',
    '       r.allocated_micro, r.weekly_quota_micro, r.used_micro, r.calls, r.last_at, r.synced_at',
    'FROM sync_roster r',
    'WHERE ' + where.join(' AND '),
    'ORDER BY r.allocated_micro DESC, r.used_micro DESC'
  ].join('\n');

  try {
    var limit = Number(opts.limit) > 0 ? Math.min(Number(opts.limit), 500) : 500;
    sql += ' LIMIT ?';
    params.push(limit);
    var stmt = db.prepare(sql);
    // better-sqlite3 不接受参数数组（会被当成具名参数对象），必须展开传
    return stmt.all.apply(stmt, params);
  } catch (err) {
    console.warn('[Sync] 读取花名册镜像失败:', err.message);
    return [];
  }
}

// 单个外班学生（充值前要先拿到他的云端余额，才能在云端值上叠加）
function getRosterRow(userId) {
  if (!canSeeRoster()) return null;
  try {
    return db.prepare('SELECT * FROM sync_roster WHERE user_id = ?').get(String(userId)) || null;
  } catch (e) {
    return null;
  }
}

// 充值写进镜像的乐观值（管理员马上要看到新数字）。
// 云端权威值由下一轮 fetchRoster 覆盖 —— 推送失败时这正是唯一的自愈路径，
// 所以无论成功失败都要置 roster_refetch_pending。
function applyRosterAllocation(userId, allocatedMicro, weeklyMicro, meta) {
  if (!canSeeRoster()) return false;
  try {
    // 先取旧值：下面要算 delta 记流水
    var row = db.prepare('SELECT allocated_micro FROM sync_roster WHERE user_id = ?').get(String(userId));
    if (!row) return false;
    var next = Math.max(0, Math.round(Number(allocatedMicro) || 0));
    var weekly = Math.max(0, Math.round(Number(weeklyMicro) || 0));
    // hub_quota_set 记的是**中枢的意图**：「这次改动还没被节点确认」。
    // 归零时额度是 0，下行列表若只看 allocated_micro > 0 就会把它漏掉，
    // 节点永远停在旧值 —— 管理台显示收回成功、钱却没退（迁移 030 的由来）。
    db.prepare(
      'UPDATE sync_roster SET allocated_micro = ?, weekly_quota_micro = ?, hub_quota_set = 1 WHERE user_id = ?'
    ).run(next, weekly, String(userId));

    // 跨班改动也要留流水。
    //
    // 外班学生的钱不在本机账本（cluss_credit）里，如果连流水都不记，中枢这边
    // 一条记录都没有 —— 管理员事后没法回答「我给 8 班充过多少、什么时候充的」，
    // 流水页也永远只显示本班。origin_instance 写本机，标明这笔是从哪发起的。
    var delta = next - Number(row.allocated_micro || 0);
    var m = meta || {};
    if (delta !== 0) {
      db.prepare([
        'INSERT INTO cluss_credit_log (user_id, amount_micro, kind, reason, operator_id, origin_instance, idem_key, created_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ].join('\n')).run(
        String(userId), delta, String(m.kind || 'topup'), String(m.reason || ''),
        String(m.operator_id || ''), config.instanceId, null, time.nowUtc()
      );
    }

    status.roster_refetch_pending = true;
    return true;
  } catch (e) {
    return false;
  }
}

// 面板一行状态用
function rosterSummary() {
  return {
    version: status.roster_version,
    synced_at: status.roster_pulled_at,
    count: status.roster_count,
    error: status.roster_error,
    pushed_at: status.last_push_roster_at,
    pushed_count: status.last_push_roster_count,
    push_error: status.last_push_roster_error
  };
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
    // 是否跟随中枢的模型选择（迁移 031）。0 = 本班用自己的模型配置，
    // 额度与名单照常同步。面板要能回答「我这个班为什么模型没变」。
    model_sync: (status.model_sync === undefined) ? 1 : status.model_sync,
    self_pushed_model_version: status.self_pushed_model_version,
    self_pushed_assign_version: status.self_pushed_assign_version,
    pending_policy: status.pending_policy,
    pending_allocations: status.pending_allocations,
    last_push_policy_at: status.last_push_policy_at,
    last_push_policy_error: status.last_push_policy_error,
    last_push_alloc_at: status.last_push_alloc_at,
    last_push_alloc_error: status.last_push_alloc_error,
    // 全校花名册：让班管知道「这份跨班可见的名单是什么时候、多少人」
    roster: rosterSummary(),
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
  rememberSeatUser: rememberSeatUser,
  // 全校花名册（跨班充值的可见性）
  pushRoster: pushRoster,
  fetchRoster: fetchRoster,
  listRoster: listRoster,
  getRosterRow: getRosterRow,
  applyRosterAllocation: applyRosterAllocation,
  rosterSummary: rosterSummary
};
