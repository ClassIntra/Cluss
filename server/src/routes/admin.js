// 管理端路由（仅中继权威节点使用）
//
// 使用场景：学生线下转账 → 管理员在中继管理台给账号开通额度 → 下发到各班级节点
//
// 关键约定：
//   1. 所有充值/调整都写 cluss_credit_log（只增不改），operator_id 记录操作人，可追溯
//   2. 变更后 bump 分配版本号，班级节点靠版本号判断是否需要拉取
//   3. 批量操作包在一个事务里，要么全成要么全不成

var express = require('express');
var router = express.Router();
var db = require('../utils/db');
var time = require('../utils/time');
var auth = require('../middleware/auth');
var credit = require('../services/credit');
var config = require('../config');
var constants = require('../utils/constants');
var initDb = require('../utils/init-db');
var classRoster = require('../services/class-roster');
// node 模式下的出站同步（申请账号绑定确认码要走它）
var syncService = require('../services/sync');
// 模型配置下发（v1）：管理台每改一次模型/源/视觉/峰谷就 bump 版本号，
// 各班级节点靠 /sync/version 轮询到新版本后整表替换本地配置
var modelConfig = require('../services/model-config');
// 必须在**模块级**引入：parsePeakWindowsInput 是顶层函数，它要用 pricing.parseHm。
// 原先只在各路由处理函数内部 `var pricing = require(...)`，那些是函数作用域的局部量，
// 顶层函数里根本看不到 —— 结果任何一次「保存峰谷配置」都会 ReferenceError → 500。
var pricing = require('../services/pricing');

var MAX_ASSIGN_YUAN = 10000;   // 单次分配上限，防止误输多个零
var MAX_WEEKLY_YUAN = 10000;

// 分配版本号：每次下发变更自增，节点据此判断是否要重新拉取
function bumpAssignVersion() {
  var cur = parseInt(initDb.getMeta('assign_version', '0'), 10) || 0;
  var next = cur + 1;
  initDb.setMeta('assign_version', next);
  return next;
}

function currentAssignVersion() {
  return parseInt(initDb.getMeta('assign_version', '0'), 10) || 0;
}

// node 模式下的模型/源/视觉/峰谷写入闸门（设计文档 §5.3 的演进）：
//
// 原设计是「node 模式一律只读」——那时配置只能在中枢改。2026-10-12 起
// 改成：**持有云端管理员席位的那个班**可以在本机改，改完由本节点上行推给
// 云端，云端再下发给同校所有班。这样「一校一个管理员」的设定才不会变成
// 「只有坐云端网页的人能配」——管理员在教室电脑前就能配。
//
// 非席位班仍然只读：它们改了不会同步到全校，只会造成「某班的模型悄悄
// 不一样」这类难排查问题（而且下一次下发就被覆盖，白改）。
//
// 写入权以云端告知的 is_seat_admin 为准，本机不自己认定。
function requireCanEditModelConfig(req, res, next) {
  if (config.mode !== config.MODES.NODE) return next();
  if (!syncService.isEnabled()) {
    return res.status(403).json({ code: 403, message: '本机未接入中继，无法修改全校配置' });
  }
  var st = syncService.getStatus();
  if (!st.is_seat_admin) {
    var where = st.seat_instance ? ('本校管理员席位在 ' + st.seat_instance + ' 班，本班只能查看') : '本校还没有认领管理员席位';
    return res.status(403).json({ code: 403, message: where + '。请到管理员班操作，或在云端完成账号绑定。' });
  }
  // 记下是谁改的：上行时云端要校验这个学号与席位一致
  syncService.rememberSeatUser(req.user.user_id);
  next();
}

// 模型/源/视觉/峰谷改完之后统一走这里：升版本 + 标脏待上行。
// 分散在 9 处重复写「bumpModelVersion + markPolicyDirty」迟早会漏一处，
// 漏了的表现就是「那个设置改了但同步不到全校」，很难查。
function bumpModelAndQueue(req) {
  syncService.rememberSeatUser(req.user.user_id);
  syncService.markPolicyDirty();
  var v = modelConfig.bumpModelVersion();
  // 立刻推一次，不等下个轮询周期 —— 班管改完希望马上看到「已同步全校」。
  // 推失败不阻塞本次写操作（学生要用），队列留在内存下轮重试。
  if (syncService.isEnabled()) {
    syncService.pushPending(req.user.user_id).catch(function() {});
  }
  return v;
}

// 额度改完之后走这里：升本机版本 + 入待推队列（席位班会同步全校）。
//
// 这修的是一个静默丢数据的 bug：额度路由一直**不受** requireCanEditModelConfig
// 拦截，所以 node 模式下老师改了额度确实写进了本机 —— 但没人推给云端，
// 下一次轮询 `assign_version` 被云端版本覆盖回去，改动就凭空消失了，
// 老师那边看着「加过了」，学生那边额度纹丝不动。
function bumpAssignAndQueue(req, userId, allocatedMicro, weeklyMicro, reason) {
  syncService.rememberSeatUser(req.user.user_id);
  var v = bumpAssignVersion();
  if (!syncService.isEnabled()) return v;
  syncService.queueAllocation(userId, allocatedMicro, weeklyMicro, reason, req.user.user_id);
  syncService.pushPending(req.user.user_id).catch(function() {});
  return v;
}

// 校验金额输入（元 → 微元）
function parseYuan(value, label) {
  var n = Number(value);
  if (!isFinite(n) || n < 0) {
    return { ok: false, message: label + '必须是不小于 0 的数字' };
  }
  if (n > MAX_ASSIGN_YUAN) {
    return { ok: false, message: label + '不能超过 ' + MAX_ASSIGN_YUAN + ' 元' };
  }
  return { ok: true, micro: config.yuanToMicro(n) };
}

// ============================================================
// GET /admin/users —— 账号列表（含额度、消耗）
//
// ⚠️ 这里**不排除管理员**，是有代价换来的（2026-10-09 实测故障）：
//   联动部署下班管（ClassIntra 的 is_class_admin）本人就是管理员，**同时也是
//   要用 Cluss 的学生**。原先按 is_admin=0 过滤，把他从表里滤掉，后果是
//   两件事同时坏掉：
//     · 他看不到自己那一行的已分配 / 已消耗 / 余额；
//     · 充值按钮是挂在每行操作列上的 —— 他在列表里找不到自己，
//       于是**自己给自己充不了钱**（接口本来是放行的，纯列表过滤挡住的）。
//   实测班管是全站第一消耗者（占 76%），滤掉他等于把主要成本从台账上抹掉。
//
// 「学生数」指标仍然只数学生（见 /admin/dashboard）：那是**人数**口径，
// 与额度 / 用量不是同一回事，不该被这里的口径带偏。
// ============================================================
router.get('/users', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var keyword = String(req.query.keyword || '').trim();
  var onlyAllocated = String(req.query.filter || '') === 'allocated';
  var limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

  var params = [];
  var where = [];
  if (keyword) {
    where.push('(u.user_id LIKE ? OR u.net_name LIKE ? OR u.real_name LIKE ?)');
    params.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
  }
  if (onlyAllocated) {
    where.push('IFNULL(c.allocated_micro, 0) > 0');
  }

  // class_no 必须在这里取出来：前端要渲染班级列、并按班级下拉过滤。
  // 以前漏了它，班级列恒为「--」，选中任一班级后列表直接空掉。
  var sql = [
    'SELECT u.user_id, u.net_name, u.real_name, u.status, u.source, u.class_no, u.is_admin,',
    '       u.created_at, u.last_login,',
    '       IFNULL(c.allocated_micro, 0) AS allocated_micro,',
    '       IFNULL(c.weekly_quota_micro, 0) AS weekly_quota_micro,',
    '       IFNULL(s.used_micro, 0) AS used_micro,',
    '       IFNULL(s.calls, 0) AS calls,',
    '       s.last_at',
    'FROM users u',
    'LEFT JOIN cluss_credit c ON c.user_id = u.user_id',
    'LEFT JOIN (',
    '  SELECT user_id, SUM(cost_micro) AS used_micro, COUNT(*) AS calls, MAX(created_at) AS last_at',
    '  FROM cluss_usage_log GROUP BY user_id',
    ') s ON s.user_id = u.user_id'
  ].join('\n');
  if (where.length) sql += '\nWHERE ' + where.join(' AND ');
  sql += '\nORDER BY allocated_micro DESC, used_micro DESC LIMIT ?';
  params.push(limit);

  // 先编译再用展开传参：better-sqlite3 不接受参数数组（会被当具名参数对象）
  var stmt = db.prepare(sql);
  var rows = stmt.all.apply(stmt, params);

  // ---- 全校花名册并入（跨班充值的可见性） ----
  //
  // 上面这条查询只看本机 users：席位班（如 18 班）握着全校写入权，列表里
  // 却只有本班学生，**根本找不到可点的别班学生**；而别班自己的班管没有
  // 写入权，一点提交就 403。两头合起来 = 谁都充不了别人班。
  //
  // 补法是把云端花名册（镜像在 sync_roster）并进来。它只加**行**，
  // 不加权限：本班学生仍然只由上面这条本地查询给出，外班学生的钱与消耗
  // 直接来自云端快照（本机没有他们的 cluss_credit）。非席位班 listRoster
  // 恒返回空，这段等于不存在。
  var merged = rows.slice();
  syncService.listRoster({
    keyword: keyword,
    onlyAllocated: onlyAllocated,
    limit: limit
  }).forEach(function(r) {
    merged.push(Object.assign({ source: 'roster', remote: true, created_at: null }, r));
  });

  // 两段各自排过序，合并后要重排，否则外班学生会整块挤在列表尾部
  merged.sort(function(a, b) {
    if (b.allocated_micro !== a.allocated_micro) return b.allocated_micro - a.allocated_micro;
    return b.used_micro - a.used_micro;
  });
  if (merged.length > limit) merged = merged.slice(0, limit);

  res.json({
    code: 200,
    message: 'ok',
    data: {
      assign_version: currentAssignVersion(),
      // 花名册状态（版本 / 拉取时刻 / 人数）：面板要能回答
      // 「我现在看到的是不是全校、是什么时候的」
      roster: syncService.rosterSummary(),
      users: merged.map(function(r) {
        return {
          user_id: r.user_id,
          net_name: r.net_name,
          real_name: r.real_name,
          status: r.status,
          source: r.source || 'local',
          class_no: r.class_no || '',
          // 外班学生的上报来源（哪个班级节点）。class_no 只是展示用的班级号，
          // 这一列才是权威归属 —— 学号可能重复，节点号不会。
          instance_id: r.instance_id || '',
          // 前端据此标注管理员行（班管本人也在表里，见上方口径说明）
          is_admin: r.is_admin === 1 ? 1 : 0,
          allocated_yuan: config.microToYuan(r.allocated_micro).toFixed(2),
          allocated_micro: r.allocated_micro,
          used_yuan: config.microToYuan(r.used_micro).toFixed(2),
          used_micro: r.used_micro,
          // 注意：这里显示的是「本节点已记录的消耗」，跨班消耗要到节点上报后才齐全
          remaining_yuan: config.microToYuan(r.allocated_micro - r.used_micro).toFixed(2),
          weekly_quota_yuan: config.microToYuan(r.weekly_quota_micro).toFixed(2),
          calls: r.calls,
          last_at: time.toISO(r.last_at),
          created_at: time.toISO(r.created_at),
          // 外班学生：余额来自云端快照（本机账本里没有他），前端据此打标
          remote: !!r.remote
        };
      })
    }
  });
});

// ============================================================
// 额度写入闸门（node 模式）
// ============================================================
// 和模型配置同一套逻辑：**持有云端管理员席位的班**改的额度会同步全校，
// 非席位班改了只在本机生效、下一次云端下发就被覆盖 —— 那等于让管理员
// 以为改成功了其实没有。所以非席位班直接拒，并把席位在哪个班说清楚。
//
// 注意：这条闸门以前**根本不存在**。额度路由从来不受 requireCanEditModelConfig
// 管，所以任何班改了都「成功」了，但改动只留在本机——就是那个静默丢数据的 bug。
// 能不能改某个学生的额度。
//
// 判断粒度是**学生**而不是「整台机器」：本班学生改的是自己班的账，
// 本班班管天然有权，不该因为没有全校席位就连自己班都不能充。
// 只有改**外班**学生的额度才需要席位（那笔钱在别人的账本上）。
//
// 旧实现是「非席位班一律 403」，结果是 8 班的班管在自己机器上给本班学生
// 充不了值 —— 而这本来是每台机器最基础的能力。
function canEditQuotaFor(userId) {
  if (config.mode !== config.MODES.NODE) return { ok: true };

  var local = !!db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(String(userId || '').trim());
  if (local) return { ok: true };

  if (!syncService.isEnabled()) {
    return { ok: false, message: '本机未接入组网，无法修改其他班学生的额度' };
  }
  var st = syncService.getStatus();
  if (!st.is_seat_admin) {
    var where = st.seat_instance
      ? ('管理员席位在 ' + st.seat_instance + ' 班')
      : '本校还没有认领管理员席位';
    return { ok: false, message: where + '，其他班的学生只能查看' };
  }
  return { ok: true };
}

function requireCanEditQuota(req, res, next) {
  var r = canEditQuotaFor(req.params.userId);
  if (!r.ok) return res.status(403).json({ code: 403, message: r.message });
  syncService.rememberSeatUser(req.user.user_id);
  next();
}

// ============================================================
// PUT /admin/users/:userId/quota —— 追加充值（叠加式）
// body: { quota_yuan, weekly_yuan?, reason? }
//
// quota_yuan 是「本次追加金额」而不是「设定总额」：新额度 = 现有额度 + 追加金额。
// 这样多次充值只需反复输入本次金额，不必每次重算/重填总额（M04 充值体验改造）。
// weekly_yuan 选填：不填则保留原周限额，避免重复填写基础信息。
// 需要下调/纠错时走 DELETE /users/:userId/quota（收回额度）。
// ============================================================
router.put('/users/:userId/quota', auth.requireAuth, auth.requireAdmin, requireCanEditQuota, function(req, res) {
  var userId = String(req.params.userId || '').trim();
  var user = db.prepare('SELECT user_id, net_name, real_name FROM users WHERE user_id = ?').get(userId);

  // 本班没有这个学号 —— 只有一种可能是席位班从云端花名册并进来的**外班**学生。
  // 非席位班 listRoster/getRosterRow 恒空，所以这条路只对席位班开放，
  // 不存在「绕过 requireCanEditQuota」的口子（那道闸门在中间件里已经过完了）。
  var remote = null;
  if (!user) {
    remote = syncService.getRosterRow(userId);
    if (!remote) return res.status(404).json({ code: 404, message: '用户不存在：' + userId });
  }

  var parsed = parseYuan(req.body.quota_yuan, '追加金额');
  if (!parsed.ok) return res.status(400).json({ code: 400, message: parsed.message });
  if (parsed.micro <= 0) return res.status(400).json({ code: 400, message: '追加金额需大于 0' });

  // 余额从哪来：本班读本机账本；外班读云端快照 —— 本机根本没有他的
  // cluss_credit 行，读出来会是 0，叠加就变成「从零充起」的错账。
  var before = user
    ? credit.getAssignment(userId)
    : { allocated_micro: Number(remote.allocated_micro || 0), weekly_quota_micro: Number(remote.weekly_quota_micro || 0) };

  // 周限额仅在显式传入时更新；留空 = 沿用原值（叠加充值不该顺带把周限额清零）
  var weeklyMicro = Number(before.weekly_quota_micro || 0);
  if (req.body.weekly_yuan !== undefined && req.body.weekly_yuan !== '' && req.body.weekly_yuan !== null) {
    var w = parseYuan(req.body.weekly_yuan, '周限额');
    if (!w.ok) return res.status(400).json({ code: 400, message: w.message });
    if (w.micro > MAX_WEEKLY_YUAN * 1000000) return res.status(400).json({ code: 400, message: '周限额过大' });
    weeklyMicro = w.micro;
  }

  // 叠加：新额度 = 现有额度 + 本次追加
  var newAllocated = Number(before.allocated_micro || 0) + parsed.micro;
  if (config.microToYuan(newAllocated) > MAX_ASSIGN_YUAN) {
    return res.status(400).json({ code: 400, message: '累计额度不能超过 ' + MAX_ASSIGN_YUAN + ' 元' });
  }

  var idemKey = constants.makeIdemKey([
    'topup', userId, String(parsed.micro), String(weeklyMicro), String(Date.now()), config.instanceId
  ]);

  if (user) {
    credit.applyAssignment({
      user_id: userId,
      allocated_micro: newAllocated,
      weekly_quota_micro: weeklyMicro,
      assigned_by: req.user.user_id,
      idem_key: idemKey,
      kind: 'topup',
      reason: String(req.body.reason || ''),
      origin_instance: config.instanceId
    });
  }
  var reason = String(req.body.reason || '') ||
    ('本机追加充值 ' + config.microToYuan(parsed.micro).toFixed(2) + ' 元' + (remote ? '（外班 ' + (remote.class_no || '?') + ' 班）' : ''));

  // 外班学生：**不写本机台账**（他的账在云端，写进来就成两处口径），
  // 只把花名册镜像改成乐观值，让管理员马上看到新数字；
  // 权威值由下一轮 fetchRoster 覆盖（推送失败时靠它自愈）。
  // meta 里的 reason/operator 会记进流水 —— 否则中枢对这笔跨班充值毫无记录。
  syncService.applyRosterAllocation(userId, newAllocated, weeklyMicro, {
    kind: 'topup',
    reason: reason,
    operator_id: req.user.user_id
  });
  var version = bumpAssignAndQueue(req, userId, newAllocated, weeklyMicro, reason);
  console.log('[Admin] 追加充值: %s (%s) +%s → %s 元 / 周限额 %s 元，操作人 %s%s',
    userId, user ? user.real_name : (remote.real_name || ''), config.microToYuan(parsed.micro).toFixed(2),
    config.microToYuan(newAllocated), config.microToYuan(weeklyMicro), req.user.user_id,
    remote ? '［外班，走云端账本］' : '');

  res.json({
    code: 200,
    message: remote
      ? ('已追加 ¥' + config.microToYuan(parsed.micro).toFixed(2) + '（' + (remote.class_no || '外') + ' 班学生，将同步到云端账本）')
      : ('已追加 ¥' + config.microToYuan(parsed.micro).toFixed(2)),
    data: {
      user_id: userId,
      delta_yuan: config.microToYuan(parsed.micro).toFixed(2),
      allocated_yuan: config.microToYuan(newAllocated).toFixed(2),
      assign_version: version,
      remote: !!remote
    }
  });
});

// ============================================================
// POST /admin/users/quota/batch —— 批量追加充值（充值时最常见）
// body: { items: [{ user_id, quota_yuan, weekly_yuan? }], reason? }
//
// 与单用户一致：quota_yuan 是「本次追加金额」，逐人在各自现有额度上累加；
// weekly_yuan 不填则保留该用户原有周限额。
// ============================================================
// 批量不做整请求拦截：一次批量里可能既有本班学生（随时可改）又有外班学生
// （要席位）。整请求 403 会让「给本班充 30 人」因为夹了一个外班学号而全盘失败。
// 改成逐条判断、失败项单独回报。
router.post('/users/quota/batch', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ code: 400, message: '没有要处理的用户' });
  if (items.length > 200) return res.status(400).json({ code: 400, message: '单次最多处理 200 个用户' });
  syncService.rememberSeatUser(req.user.user_id);

  var results = [];
  var failed = [];

  var tx = db.transaction(function() {
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var userId = String(it.user_id || '').trim();
      var parsed = parseYuan(it.quota_yuan, '追加金额');

      if (!userId) { failed.push({ user_id: userId, message: '用户ID为空' }); continue; }
      var perm = canEditQuotaFor(userId);
      if (!perm.ok) { failed.push({ user_id: userId, message: perm.message }); continue; }
      if (!parsed.ok) { failed.push({ user_id: userId, message: parsed.message }); continue; }
      if (parsed.micro <= 0) { failed.push({ user_id: userId, message: '追加金额需大于 0' }); continue; }

      var user = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(userId);
      // 外班学生（席位班从云端花名册并进来的行）：本机没有他的账，
      // 余额从镜像读、不写本机台账，理由同单个充值。
      var remoteRow = null;
      if (!user) {
        remoteRow = syncService.getRosterRow(userId);
        if (!remoteRow) { failed.push({ user_id: userId, message: '用户不存在' }); continue; }
      }

      var before = user
        ? credit.getAssignment(userId)
        : {
            allocated_micro: Number(remoteRow.allocated_micro || 0),
            weekly_quota_micro: Number(remoteRow.weekly_quota_micro || 0)
          };

      // 周限额：显式传入才更新，否则沿用原值
      var weeklyMicro = Number(before.weekly_quota_micro || 0);
      if (it.weekly_yuan !== undefined && it.weekly_yuan !== '' && it.weekly_yuan !== null) {
        var w = parseYuan(it.weekly_yuan, '周限额');
        if (!w.ok) { failed.push({ user_id: userId, message: w.message }); continue; }
        weeklyMicro = w.micro;
      }

      var newAllocated = Number(before.allocated_micro || 0) + parsed.micro;
      if (config.microToYuan(newAllocated) > MAX_ASSIGN_YUAN) {
        failed.push({ user_id: userId, message: '累计额度不能超过 ' + MAX_ASSIGN_YUAN + ' 元' });
        continue;
      }

      var idemKey = constants.makeIdemKey([
        'batch', userId, String(parsed.micro), String(weeklyMicro), String(Date.now()), config.instanceId, String(i)
      ]);

      if (user) {
        credit.applyAssignment({
          user_id: userId,
          allocated_micro: newAllocated,
          weekly_quota_micro: weeklyMicro,
          assigned_by: req.user.user_id,
          idem_key: idemKey,
          kind: 'topup',
          reason: String(req.body.reason || '批量充值'),
          origin_instance: config.instanceId
        });
      }

      results.push({
        user_id: userId,
        allocated_yuan: config.microToYuan(newAllocated).toFixed(2),
        allocated_micro: newAllocated,
        weekly_quota_micro: weeklyMicro,
        remote: !!remoteRow
      });
    }
  });

  try {
    tx();
  } catch (err) {
    console.error('[Admin] 批量分配失败:', err.message);
    return res.status(500).json({ code: 500, message: '批量操作失败，已回滚：' + err.message });
  }

  var version = currentAssignVersion();
  if (results.length) {
    // 批量：逐个入待推队列（每人一条，云端按 idem_key 逐条去重）
    for (var qi = 0; qi < results.length; qi++) {
      syncService.rememberSeatUser(req.user.user_id);
      if (syncService.isEnabled()) {
        syncService.queueAllocation(results[qi].user_id, results[qi].allocated_micro,
          results[qi].weekly_quota_micro, '本机批量分配', req.user.user_id);
      }
      // 外班学生改的是云端账本：把花名册镜像改成乐观值，并置位下轮回拉，
      // 让推送失败时也能拿云端权威值盖回来（同单个充值）
      if (results[qi].remote) {
        syncService.applyRosterAllocation(results[qi].user_id,
          results[qi].allocated_micro, results[qi].weekly_quota_micro, {
            kind: 'topup',
            reason: '本机批量追加',
            operator_id: req.user.user_id
          });
      }
    }
    version = bumpAssignVersion();
    if (syncService.isEnabled()) syncService.pushPending(req.user.user_id).catch(function() {});
  }
  console.log('[Admin] 批量分配完成: 成功 %d 个，失败 %d 个，操作人 %s', results.length, failed.length, req.user.user_id);

  res.json({
    code: 200,
    message: '成功 ' + results.length + ' 个' + (failed.length ? '，失败 ' + failed.length + ' 个' : ''),
    data: { succeeded: results, failed: failed, assign_version: version }
  });
});

// ============================================================
// DELETE /admin/users/:userId/quota —— 收回额度（清零）
// ============================================================
router.delete('/users/:userId/quota', auth.requireAuth, auth.requireAdmin, requireCanEditQuota, function(req, res) {
  var userId = String(req.params.userId || '').trim();
  var user = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(userId);
  // 外班学生同样能收回（见 PUT /quota 里对 remote 的说明）
  var remote = user ? null : syncService.getRosterRow(userId);
  if (!user && !remote) return res.status(404).json({ code: 404, message: '用户不存在' });

  var idemKey = constants.makeIdemKey(['revoke', userId, String(Date.now()), config.instanceId]);
  if (user) {
    credit.applyAssignment({
      user_id: userId,
      allocated_micro: 0,
      weekly_quota_micro: 0,
      assigned_by: req.user.user_id,
      idem_key: idemKey,
      kind: 'revoke',
      reason: String(req.body && req.body.reason || '管理员收回额度'),
      origin_instance: config.instanceId
    });
  }
  syncService.applyRosterAllocation(userId, 0, 0, {
    kind: 'revoke',
    reason: String(req.body && req.body.reason || '管理员收回额度'),
    operator_id: req.user.user_id
  });

  var version = bumpAssignAndQueue(req, userId, 0, 0,
    String(req.body && req.body.reason || '管理员收回额度'));
  console.log('[Admin] 额度已收回: %s%s，操作人 %s', userId, remote ? '（外班，走云端账本）' : '', req.user.user_id);
  res.json({ code: 200, message: '已收回额度', data: { assign_version: version, remote: !!remote } });
});

// ============================================================
// GET /admin/logs —— 额度流水（对账凭据）
// ============================================================
router.get('/logs', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  var userId = String(req.query.user_id || '').trim();

  // 姓名要兜到 sync_roster：外班学生不在本机 users 里，只 JOIN users 会得到
  // 空名字，前端只能回退显示学号 —— 管理台看起来就是「该显示姓名的地方显示了 ID」。
  // 撞号（如两班管理员都叫 999999）时优先用本班 users 的口径，不影响阅读。
  var sql = [
    'SELECT l.*,',
    '  COALESCE(NULLIF(u.net_name, \'\'), r.net_name, \'\') AS net_name,',
    '  COALESCE(NULLIF(u.real_name, \'\'), r.real_name, \'\') AS real_name',
    'FROM cluss_credit_log l',
    'LEFT JOIN users u ON u.user_id = l.user_id',
    'LEFT JOIN sync_roster r ON r.user_id = l.user_id'
  ].join('\n');
  var params = [];
  if (userId) {
    sql += '\nWHERE l.user_id = ?';
    params.push(userId);
  }
  sql += '\nORDER BY l.id DESC LIMIT ?';
  params.push(limit);

  var stmt2 = db.prepare(sql);
  var rows = stmt2.all.apply(stmt2, params);
  res.json({
    code: 200,
    message: 'ok',
    data: {
      logs: rows.map(function(r) {
        return {
          id: r.id,
          user_id: r.user_id,
          net_name: r.net_name,
          real_name: r.real_name,
          amount_yuan: config.microToYuan(r.amount_micro).toFixed(2),
          amount_micro: r.amount_micro,
          kind: r.kind,
          reason: r.reason,
          operator_id: r.operator_id,
          origin_instance: r.origin_instance,
          created_at: time.toISO(r.created_at)
        };
      })
    }
  });
});

// ============================================================
// GET /admin/nodes —— 班级节点看板（多班管理主视图）
//
// 数据来源两路合并：
//   · cluss_nodes 注册表（023 迁移）—— 节点身份、心跳（last_seen_at）、
//     配置到达情况（last_assign_version / last_model_version）、状态；
//   · cluss_usage_log 按 origin_instance 聚合 —— 每班消耗（老版本节点
//     不发身份头、不进注册表，但只要报过用量就还能在这里看到一行）。
// 分配额 vs 上报消耗 = 各班余额推算，分钟级延迟（上报间隔 300s）。
// ============================================================
var NODE_ONLINE_WINDOW_SEC = 600; // 心跳新鲜度阈值：同步间隔 60s 的 10 倍宽限

router.get('/nodes', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var nowLocal = new Date();
  var monthStartUtc = time.fmtUtc(new Date(nowLocal.getFullYear(), nowLocal.getMonth(), 1));
  var nowUtc = time.nowUtc();
  var onlineCutoff = time.fmtUtc(new Date(Date.now() - NODE_ONLINE_WINDOW_SEC * 1000));

  var usageRows = db.prepare([
    'SELECT origin_instance,',
    '  COUNT(*) AS calls,',
    '  SUM(cost_micro) AS cost_micro,',
    '  SUM(CASE WHEN created_at >= ? THEN cost_micro ELSE 0 END) AS month_cost_micro,',
    '  SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS month_calls,',
    '  MAX(created_at) AS last_at',
    'FROM cluss_usage_log',
    "WHERE origin_instance != ''",
    'GROUP BY origin_instance'
  ].join('\n')).all(monthStartUtc, monthStartUtc);

  var usageByInstance = {};
  for (var i = 0; i < usageRows.length; i++) usageByInstance[usageRows[i].origin_instance] = usageRows[i];

  var nodeRows = db.prepare('SELECT * FROM cluss_nodes ORDER BY last_seen_at DESC').all();
  var orgNames = {};
  var orgRows = db.prepare('SELECT id, name FROM cluss_orgs').all();
  for (var oi = 0; oi < orgRows.length; oi++) orgNames[orgRows[oi].id] = orgRows[oi].name;
  var seen = {};
  var nodes = [];

  for (var n = 0; n < nodeRows.length; n++) {
    var r = nodeRows[n];
    seen[r.instance_id] = true;
    var u = usageByInstance[r.instance_id] || {};
    nodes.push({
      instance_id: r.instance_id,
      org_id: r.org_id || '',
      org_name: orgNames[r.org_id] || '',
      label: r.label,
      status: r.status,
      revoked_at: r.revoked_at ? time.toISO(r.revoked_at) : null,
      online: !!r.last_seen_at && r.last_seen_at >= onlineCutoff,
      last_seen_at: r.last_seen_at ? time.toISO(r.last_seen_at) : null,
      last_report_at: r.last_report_at ? time.toISO(r.last_report_at) : null,
      first_seen_at: r.first_seen_at ? time.toISO(r.first_seen_at) : null,
      node_version: r.node_version,
      last_assign_version: r.last_assign_version,
      last_model_version: r.last_model_version,
      assign_version_current: currentAssignVersion(),
      model_version_current: modelConfig.currentModelVersion(),
      calls: u.calls || 0,
      cost_micro: u.cost_micro || 0,
      month_calls: u.month_calls || 0,
      month_cost_micro: u.month_cost_micro || 0,
      last_usage_at: u.last_at ? time.toISO(u.last_at) : null,
      registered: true
    });
  }

  // 只报过用量、还没进注册表的老节点（升级前存量）
  for (var k in usageByInstance) {
    if (seen[k]) continue;
    var uo = usageByInstance[k];
    nodes.push({
      instance_id: k,
      label: '',
      status: 'active',
      revoked_at: null,
      online: null,
      last_seen_at: null,
      last_report_at: uo.last_at ? time.toISO(uo.last_at) : null,
      first_seen_at: null,
      node_version: '',
      last_assign_version: 0,
      last_model_version: 0,
      assign_version_current: currentAssignVersion(),
      model_version_current: modelConfig.currentModelVersion(),
      calls: uo.calls || 0,
      cost_micro: uo.cost_micro || 0,
      month_calls: uo.month_calls || 0,
      month_cost_micro: uo.month_cost_micro || 0,
      last_usage_at: uo.last_at ? time.toISO(uo.last_at) : null,
      registered: false
    });
  }

  nodes.sort(function(a, b) { return b.cost_micro - a.cost_micro; });

  res.json({
    code: 200,
    message: 'ok',
    data: {
      instance_id: config.instanceId,
      mode: config.mode,
      now: nowUtc,
      online_window_sec: NODE_ONLINE_WINDOW_SEC,
      nodes: nodes
    }
  });
});

// ---- 节点管理：备注 / 吊销 / 恢复 ----
// 吊销的边界（v0/v1）：同步请求全部 403，看板里标灰。但凭证仍是全网共享
// 密钥，被吊销节点换个 instance_id 仍可混入 —— 硬隔离等 v2 节点专属密钥。

function findNodeOr404(req, res) {
  var instanceId = String(req.params.instanceId || '').trim();
  if (!instanceId) {
    res.status(400).json({ code: 400, message: '缺少 instance_id' });
    return null;
  }
  if (instanceId === config.instanceId) {
    res.status(400).json({ code: 400, message: '不能对中继本机做该操作' });
    return null;
  }
  var row = db.prepare('SELECT * FROM cluss_nodes WHERE instance_id = ?').get(instanceId);
  if (!row) {
    res.status(404).json({ code: 404, message: '节点不存在（该班还没接入过）' });
    return null;
  }
  return row;
}

// PUT /admin/nodes/:instanceId —— 备注（如「高一3班」）
router.put('/nodes/:instanceId', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var row = findNodeOr404(req, res);
  if (!row) return;

  var label = String((req.body && req.body.label) || '').trim().slice(0, 60);
  db.prepare('UPDATE cluss_nodes SET label = ? WHERE instance_id = ?').run(label, row.instance_id);
  res.json({ code: 200, message: '已保存', data: { instance_id: row.instance_id, label: label } });
});

// POST /admin/nodes/:instanceId/revoke —— 吊销（淘汰旧机、换电脑）
router.post('/nodes/:instanceId/revoke', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var row = findNodeOr404(req, res);
  if (!row) return;
  if (row.status === 'revoked') {
    return res.json({ code: 200, message: '该节点已是吊销状态', data: { instance_id: row.instance_id } });
  }

  db.prepare("UPDATE cluss_nodes SET status = 'revoked', revoked_at = ? WHERE instance_id = ?")
    .run(time.nowUtc(), row.instance_id);
  console.log('[Admin] 节点已吊销: %s by %s', row.instance_id, req.user.user_id);
  res.json({
    code: 200,
    message: '已吊销 ' + (row.label || row.instance_id) + '：该节点的同步请求将被拒绝',
    data: { instance_id: row.instance_id, status: 'revoked' }
  });
});

// POST /admin/nodes/:instanceId/restore —— 恢复（吊销错了 / 机器重新启用）
router.post('/nodes/:instanceId/restore', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var row = findNodeOr404(req, res);
  if (!row) return;

  db.prepare("UPDATE cluss_nodes SET status = 'active', revoked_at = '' WHERE instance_id = ?")
    .run(row.instance_id);
  console.log('[Admin] 节点已恢复: %s by %s', row.instance_id, req.user.user_id);
  res.json({ code: 200, message: '已恢复', data: { instance_id: row.instance_id, status: 'active' } });
});

// ============================================================
// 组网互联（mesh）：中枢自身状态与管理员席位
// ============================================================
//
// 组网中枢跑在**有自己班级的机器上**（与 relay 那种专职中继不同），
// 所以管理员第一件要知道的事是「这台机器现在是中心吗、别的班连上来了吗」。
// 状态里刻意带上「密钥配了没」和「最近一次同步错误」—— 组网排障 90%
// 都是这两样：密钥不一致（节点 403）或地址不通（节点一直连不上）。
router.get('/mesh/status', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var isHub = config.mode === config.MODES.MESH || config.mode === config.MODES.RELAY;
  var seat = String(initDb.getMeta('seat_instance', '') || '').trim() || config.instanceId;

  var nodes = [];
  var rosterCount = 0;
  try {
    nodes = db.prepare([
      'SELECT instance_id, status, first_seen_at, last_seen_at, last_report_at,',
      'last_assign_version, last_model_version, node_version, IFNULL(model_sync, 1) AS model_sync',
      'FROM cluss_nodes ORDER BY last_seen_at DESC'
    ].join('\n')).all();
    rosterCount = db.prepare('SELECT COUNT(*) AS n FROM sync_roster').get().n;
  } catch (e) {
    // 老 schema（迁移 031 还没跑）时退回不带 model_sync 的查询，
    // 而不是让整页节点列表空掉
    try {
      nodes = db.prepare([
        'SELECT instance_id, status, first_seen_at, last_seen_at, last_report_at,',
        'last_assign_version, last_model_version, node_version',
        'FROM cluss_nodes ORDER BY last_seen_at DESC'
      ].join('\n')).all();
    } catch (e2) {
      nodes = [];
    }
  }

  res.json({
    code: 200,
    message: 'ok',
    data: {
      mode: config.mode,
      is_hub: isHub,
      instance_id: config.instanceId,
      // 中枢地址：节点要填的就是这个。给出来是为了让管理员能直接复制，
      // 而不是让他去翻 .env 再猜端口。
      hub_url: isHub ? ('http://' + (process.env.PUBLIC_BASE_URL || (config.instanceId + ':9003')).replace(/^https?:\/\//, '') ) : '',
      secret_configured: !!config.relay.secret,
      seat_instance: seat,
      seat_is_self: seat === config.instanceId,
      assign_version: currentAssignVersion(),
      model_version: parseInt(initDb.getMeta('model_config_version', '0'), 10) || 0,
      roster_count: rosterCount,
      nodes: nodes
    }
  });
});

// 移交/收回管理员席位
// body: { instance_id } —— 传空串或本機 id 表示收回中枢自己
//
// 为什么允许移交：班管平时在**自己班**那台机器上操作，若席位永远在中枢，
// 他想改全校配置就得物理走到中枢机器前。「席位在谁那」是给出去的权限，
// 不是复制 —— 同一时刻只能有一个班握着写入权，否则两处都能改就是冲突源。
router.post('/mesh/seat', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var isHub = config.mode === config.MODES.MESH || config.mode === config.MODES.RELAY;
  if (!isHub) {
    return res.status(400).json({ code: 400, message: '只有组网中枢可以分配管理员席位' });
  }
  var target = String(req.body.instance_id || '').trim();
  if (target && target !== config.instanceId) {
    var exists = db.prepare('SELECT instance_id FROM cluss_nodes WHERE instance_id = ?').get(target);
    if (!exists) {
      return res.status(404).json({ code: 404, message: '节点 ' + target + ' 还从来没连上来过' });
    }
  }
  initDb.setMeta('seat_instance', target);
  var seat = target || config.instanceId;
  console.log('[Admin] 管理员席位移交给 %s（操作者 %s）', seat, req.user.user_id);
  res.json({ code: 200, message: '席位已设为 ' + seat, data: { seat_instance: seat } });
});

// ============================================================
// POST /admin/mesh/node-model-sync —— 某个班是否跟随中枢的模型选择
// body: { instance_id, enabled: 0|1 }
//
// 关掉之后该班保留自己的渠道/Key/单价，额度与名单照常跟随。
// 为什么按节点而不是全局：班级之间的网络条件与预算都不一样，
// 一刀切会让「只想换自己模型」的班被迫整台断开组网。
// ============================================================
router.post('/mesh/node-model-sync', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var inst = String((req.body && req.body.instance_id) || '').trim();
  if (!inst) return res.status(400).json({ code: 400, message: '缺少 instance_id' });

  var raw = req.body && req.body.enabled;
  var on = (raw === true || Number(raw) === 1) ? 1 : 0;

  var row = db.prepare('SELECT instance_id FROM cluss_nodes WHERE instance_id = ?').get(inst);
  if (!row) return res.status(404).json({ code: 404, message: '该班级节点不存在：' + inst });

  try {
    db.prepare('UPDATE cluss_nodes SET model_sync = ? WHERE instance_id = ?').run(on, inst);
  } catch (e) {
    return res.status(500).json({ code: 500, message: '设置失败：' + e.message });
  }

  console.log('[Admin] 节点 %s 模型同步: %s（操作者 %s）', inst, on ? '跟随中枢' : '关闭', req.user.user_id);
  res.json({
    code: 200,
    message: on ? ('已设为跟随中枢，' + inst + ' 下一轮同步会拉取模型配置') : ('已关闭模型同步，' + inst + ' 会保留自己的模型配置'),
    data: { instance_id: inst, model_sync: on }
  });
});

// ============================================================
// GET /admin/dashboard —— 总览（管理台首页）
// ============================================================
// 口径分两套，刻意不合并（2026-10-09 修正过一次真实的自相矛盾）：
//   · 人数（user_count / by_class.students）—— 只数**学生**，管理员不是「学生」；
//   · 钱与次数（allocated / used / calls / top_users）—— **含管理员**。
// 起因：原来金额汇总含管理员，而下面所有明细列表按 is_admin=0 过滤，
// 于是「已消耗 ¥1.20」把班管算进去了，「消耗 Top 10」第一名却只有 ¥0.09
// 且没有他本人（实测班管占全站消耗 76%，等于把主要成本从台账上抹掉）。
// 现在两边统一为「钱含管理员、人数不含」，并由前端标注管理员行。
router.get('/dashboard', auth.requireAuth, auth.requireAdmin, function(req, res) {
  // 统计要**含外班**：组网之后这台机器看得到别班的学生与消耗，
  // 只数本班 users 会让「全校多少人 / 一共充了多少」少掉整整一个班。
  // 外班学生的权威数据在 sync_roster（由它自己的班上报）。
  // 撞号（两班都有 999999）用 NOT IN 排除，否则同一个人被数两次。
  var totals = db.prepare([
    'SELECT',
    '  (SELECT COUNT(*) FROM users WHERE is_admin = 0)',
    '  + (SELECT COUNT(*) FROM sync_roster r WHERE r.instance_id <> \'\' AND IFNULL(r.is_admin, 0) = 0',
    '       AND r.user_id NOT IN (SELECT user_id FROM users)) AS user_count,',
    '  (SELECT COUNT(*) FROM users WHERE IFNULL(is_admin, 0) = 1)',
    '  + (SELECT COUNT(*) FROM sync_roster r WHERE r.instance_id <> \'\' AND IFNULL(r.is_admin, 0) = 1',
    '       AND r.user_id NOT IN (SELECT user_id FROM users)) AS admin_count,',
    '  (SELECT COUNT(*) FROM users WHERE CAST(user_id AS INTEGER) >= 800001 AND CAST(user_id AS INTEGER) <= 999998) AS overflow_count,',
    '  (SELECT IFNULL(SUM(allocated_micro), 0) FROM cluss_credit)',
    '  + (SELECT IFNULL(SUM(allocated_micro), 0) FROM sync_roster r WHERE r.instance_id <> \'\'',
    '       AND r.user_id NOT IN (SELECT user_id FROM users)) AS allocated_micro,',
    '  (SELECT IFNULL(SUM(cost_micro), 0) FROM cluss_usage_log) AS used_micro,',
    '  (SELECT COUNT(*) FROM cluss_usage_log) AS calls,',
    // 让前端能说清「这些数字里有多少来自别的班」
    '  (SELECT COUNT(*) FROM sync_roster r WHERE r.instance_id <> \'\'',
    '       AND r.user_id NOT IN (SELECT user_id FROM users)) AS remote_user_count,',
    '  (SELECT COUNT(DISTINCT instance_id) FROM sync_roster WHERE instance_id <> \'\') AS remote_class_count,',
    '  (SELECT COUNT(*) FROM cluss_nodes WHERE status = \'active\') AS node_count'
  ].join('\n')).get();

  // 本月消耗（管理员预算视角）：按服务器本地日历月对齐（与峰谷同一面钟约定），
  // 转成 UTC 窗口查台账。预算是管理员的事，学生侧永远看不到这个字段。
  var nowLocal = new Date();
  var monthStartUtc = time.fmtUtc(new Date(nowLocal.getFullYear(), nowLocal.getMonth(), 1));
  var monthRow = db.prepare(
    'SELECT IFNULL(SUM(cost_micro), 0) AS cost_micro, COUNT(*) AS calls' +
    ' FROM cluss_usage_log WHERE created_at >= ?'
  ).get(monthStartUtc);
  var budgetYuan = Number(initDb.getMeta('budget_threshold_yuan', '0')) || 0;
  var monthCostYuan = config.microToYuan(monthRow.cost_micro);

  // 峰谷状态摘要（看板系统信息用；与 /admin/offpeak 同一数据源）
  var pricing = require('../services/pricing');
  var oc = pricing.getOffpeakConfig();
  var offpeakActive = pricing.isInOffpeakWindow(oc);
  var offpeakText = oc.enabled
    ? '峰 ' + oc.peaks.map(function(w) { return minutesToHm(w.startMin) + '–' + minutesToHm(w.endMin); }).join('、') +
      '，谷时 ' + (Math.round(oc.discountBp / 100) / 10) + ' 折'
    : '未启用（全天原价）';

  // 按班级聚合：本班 users ∪ 外班 sync_roster。
  //
  // 这里**数全部成员**（含管理员）：前端拿这份数据渲染「班级」下拉，并用
  // students 数当括号里的人数。若这里只数学生而下拉按它过滤，下拉会写
  // 「18 班（49 人）」而筛出来 50 行 —— 又是一处对不上的数字。
  // 「学生数」指标另算（totals.users / totals.admins），语义仍是学生。
  //
  // 组网之后必须并入外班：否则班级下拉里只有 18 班，管理员选不到 8 班，
  // 「在一个班看多个班的数据」就无从下手。撞号用 NOT IN 去重。
  var byClass = db.prepare([
    'SELECT class_no,',
    '       COUNT(DISTINCT user_id) AS students,',
    '       IFNULL(SUM(allocated_micro), 0) AS allocated_micro',
    'FROM (',
    '  SELECT u.user_id, IFNULL(NULLIF(u.class_no, \'\'), \'--\') AS class_no,',
    '         IFNULL(c.allocated_micro, 0) AS allocated_micro',
    '  FROM users u LEFT JOIN cluss_credit c ON c.user_id = u.user_id',
    '  UNION ALL',
    '  SELECT r.user_id, IFNULL(NULLIF(r.class_no, \'\'), \'--\') AS class_no,',
    '         IFNULL(r.allocated_micro, 0) AS allocated_micro',
    '  FROM sync_roster r',
    '  WHERE r.instance_id <> \'\' AND r.user_id NOT IN (SELECT user_id FROM users)',
    ') t',
    'GROUP BY class_no',
    'ORDER BY class_no ASC'
  ].join('\n')).all();

  // 消耗排行（用于发现异常用量）。**含管理员** —— 联动部署下班管本人就是主要
  // 消耗者，滤掉他等于把最大的一笔成本藏起来；前端给管理员行加标记即可区分。
  var topUsers = db.prepare([
    'SELECT s.user_id,',
    '       COALESCE(NULLIF(u.net_name, \'\'), r.net_name, \'\') AS net_name,',
    '       COALESCE(NULLIF(u.real_name, \'\'), r.real_name, \'\') AS real_name,',
    '       IFNULL(u.is_admin, r.is_admin) AS is_admin,',
    '       s.used_micro, s.calls,',
    '       IFNULL(c.allocated_micro, 0) AS allocated_micro,',
    '       COALESCE(NULLIF(u.class_no, \'\'), r.class_no, \'\') AS class_no',
    'FROM (SELECT user_id, SUM(cost_micro) AS used_micro, COUNT(*) AS calls',
    '      FROM cluss_usage_log GROUP BY user_id) s',
    'LEFT JOIN users u ON u.user_id = s.user_id',
    'LEFT JOIN sync_roster r ON r.user_id = s.user_id',
    'LEFT JOIN cluss_credit c ON c.user_id = s.user_id',
    'ORDER BY s.used_micro DESC LIMIT 10'
  ].join('\n')).all();

    res.json({
      code: 200,
      message: 'ok',
      data: {
        instance_id: config.instanceId,
        mode: config.mode,
        // 中继/云端全量状态：node 模式下管理员要看的就是这些——
        // 我接的是哪所学校、连上了没、云端发的配置我装到第几版了。
        // 以前这些只喂给 /api/health，管理台一个字都看不到。
        relay: syncService.getStatus(),
        // 管理员充值填的是元，学生端看到的是积分。把换算率给到前端，
        // 好让充值框旁边实时显示"学生将看到 N 积分"—— 管理员不必自己心算。
        points_per_yuan: config.points.perYuan,
        assign_version: currentAssignVersion(),
        month: {
          cost_yuan: monthCostYuan.toFixed(2),
          cost_micro: monthRow.cost_micro,
          calls: monthRow.calls,
          threshold_yuan: budgetYuan,
          exceeded: budgetYuan > 0 && monthCostYuan >= budgetYuan
        },
        version: config.version,
        offpeak: {
          enabled: oc.enabled,
          active_now: offpeakActive,
          text: offpeakText
        },
        totals: {
        users: totals.user_count,
        admins: totals.admin_count,
        overflow_users: totals.overflow_count,
        allocated_yuan: config.microToYuan(totals.allocated_micro).toFixed(2),
        used_yuan: config.microToYuan(totals.used_micro).toFixed(2),
        remaining_yuan: config.microToYuan(Math.max(0, totals.allocated_micro - totals.used_micro)).toFixed(2),
        calls: totals.calls,
        // 上面这些数字里有多少来自别的班 —— 不标出来，管理员会以为
        // 「全校 103 人」都是自己这台机器上的
        remote_users: totals.remote_user_count,
        remote_classes: totals.remote_class_count,
        active_nodes: totals.node_count
      },
      by_class: byClass.map(function(r) {
        return {
          class_no: r.class_no,
          students: r.students,
          allocated_yuan: config.microToYuan(r.allocated_micro).toFixed(2)
        };
      }),
      top_users: topUsers.map(function(r) {
        return {
          user_id: r.user_id,
          name: r.real_name || r.net_name || r.user_id,
          is_admin: r.is_admin === 1 ? 1 : 0,
          used_yuan: config.microToYuan(r.used_micro).toFixed(2),
          allocated_yuan: config.microToYuan(r.allocated_micro).toFixed(2),
          calls: r.calls
        };
      })
    }
  });
});

// ============================================================
// 预算阈值（管理员成本视角，纯管理侧，学生接口不含任何相关字段）
// threshold_yuan = 0 表示不启用提醒
// ============================================================
router.put('/budget', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var n = Number(req.body && req.body.threshold_yuan);
  if (!isFinite(n) || n < 0 || n > 100000) {
    return res.status(400).json({ code: 400, message: '预算阈值必须是不小于 0 的数字（0 = 关闭提醒）' });
  }
  initDb.setMeta('budget_threshold_yuan', String(Math.round(n * 100) / 100));
  console.log('[Admin] 预算阈值设为 %s 元 by %s', n, req.user.user_id);
  res.json({ code: 200, message: '已保存', data: { threshold_yuan: Math.round(n * 100) / 100 } });
});

// ============================================================
// 异常检出（成本安全的短板在管理员的可见性）
//   top7d   近 7 天消耗 Top 10
//   spikes  突增：最近 24 小时消耗 ≥ 0.5 元且 ≥ 前 7 天日均 3 倍的账号
// 用滚动窗口（24h / 7×24h）而不是日历日，避开时区与日期边界语义
//
// 口径含管理员，与 /admin/dashboard 的金额汇总保持一致（同 /admin/users 的理由：
// 班管本人就是主要消耗者，滤掉等于把最大的一笔成本藏起来）。
//
// 抽成函数给 /usage/anomalies 与「AI 洞察」共用：管理台页面上列出的
// 「突增账号」与 AI 分析里引用的必须是同一份结果，各写一份迟早会口径漂移。
// ============================================================
function computeAnomalies() {
  var since24 = time.utcBeforeDays(1);
  var since7 = time.utcBeforeDays(8);
  var MIN_SPIKE_YUAN = 0.5;   // 低于这个量级的突增没有讨论意义
  var SPIKE_RATIO = 3;

  var topRows = db.prepare([
    'SELECT l.user_id,',
    '       COALESCE(NULLIF(u.net_name, \'\'), r.net_name, \'\') AS net_name,',
    '       COALESCE(NULLIF(u.real_name, \'\'), r.real_name, \'\') AS real_name,',
    '       COALESCE(NULLIF(u.class_no, \'\'), r.class_no, \'\') AS class_no,',
    '       COALESCE(u.is_admin, r.is_admin, 0) AS is_admin,',
    '       SUM(l.cost_micro) AS cost_micro, COUNT(*) AS calls',
    'FROM cluss_usage_log l',
    'LEFT JOIN users u ON u.user_id = l.user_id',
    'LEFT JOIN sync_roster r ON r.user_id = l.user_id',
    'WHERE l.created_at >= ?',
    'GROUP BY l.user_id ORDER BY cost_micro DESC LIMIT 10'
  ].join('\n')).all(time.utcBeforeDays(7));

  var last24 = {};
  db.prepare([
    'SELECT user_id, SUM(cost_micro) AS cost_micro, COUNT(*) AS calls',
    'FROM cluss_usage_log WHERE created_at >= ? GROUP BY user_id'
  ].join('\n')).all(since24).forEach(function(r) { last24[r.user_id] = r; });

  var prev = {};
  db.prepare([
    'SELECT user_id, SUM(cost_micro) AS cost_micro',
    'FROM cluss_usage_log WHERE created_at >= ? AND created_at < ? GROUP BY user_id'
  ].join('\n')).all(since7, since24).forEach(function(r) { prev[r.user_id] = r.cost_micro; });

  var spikes = [];
  Object.keys(last24).forEach(function(uid) {
    var cur = Number(last24[uid].cost_micro || 0);
    var base = Number(prev[uid] || 0) / 7;   // 前 7 天日均
    if (cur >= MIN_SPIKE_YUAN * 1e6 && base > 0 && cur >= base * SPIKE_RATIO) {
      // 外班学生不在本机 users 里，查不到名字就会让异常榜显示成一串学号
      var u = db.prepare('SELECT net_name, real_name, class_no, is_admin FROM users WHERE user_id = ?').get(uid);
      if (!u) {
        u = db.prepare('SELECT net_name, real_name, class_no, is_admin FROM sync_roster WHERE user_id = ?').get(uid);
      }
      spikes.push({
        user_id: uid,
        name: (u && (u.real_name || u.net_name)) || uid,
        class_no: (u && u.class_no) || '',
        is_admin: (u && u.is_admin === 1) ? 1 : 0,
        day_yuan: config.microToYuan(cur).toFixed(2),
        avg_yuan: config.microToYuan(Math.round(base)).toFixed(2),
        ratio: Math.round(cur / base * 10) / 10,
        calls: last24[uid].calls
      });
    }
  });
  spikes.sort(function(a, b) { return b.day_yuan - a.day_yuan; });

  return {
    top7d: topRows.map(function(r) {
      return {
        user_id: r.user_id,
        name: (r.real_name || r.net_name) || r.user_id,
        class_no: r.class_no || '',
        is_admin: r.is_admin === 1 ? 1 : 0,
        cost_yuan: config.microToYuan(r.cost_micro).toFixed(2),
        calls: r.calls
      };
    }),
    spikes: spikes,
    rule: { min_day_yuan: MIN_SPIKE_YUAN, ratio: SPIKE_RATIO }
  };
}

router.get('/usage/anomalies', auth.requireAuth, auth.requireAdmin, function(req, res) {
  res.json({ code: 200, message: 'ok', data: computeAnomalies() });
});

// ============================================================
// GET /admin/snapshot —— 导出台账（CSV，便于线下对账）
//
// 含管理员，并单列一列标记：对账表漏掉管理员就等于漏掉真实发生过的支出
// （班管本人就是主要消耗者）。is_admin=0 的过滤曾经让这张表与页面上的金额对不上。
// ============================================================
// 导出必须含**外班**：组网之后本机看得到别的班的学生，导出的账本却只有本班，
// 对账时就对不上。外班行带上「来源班级」一列，便于分清这个学号属于哪个节点。
router.get('/snapshot', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var rows = db.prepare([
    'SELECT u.user_id, u.net_name, u.real_name, u.class_no, IFNULL(u.is_admin, 0) AS is_admin,',
    '       IFNULL(c.allocated_micro, 0) AS allocated,',
    '       IFNULL(s.used_micro, 0) AS used,',
    '       \'\' AS instance_id',
    'FROM users u',
    'LEFT JOIN cluss_credit c ON c.user_id = u.user_id',
    'LEFT JOIN (SELECT user_id, SUM(cost_micro) AS used_micro FROM cluss_usage_log GROUP BY user_id) s ON s.user_id = u.user_id',
    'WHERE (IFNULL(c.allocated_micro, 0) > 0 OR IFNULL(s.used_micro, 0) > 0)',
    'UNION ALL',
    'SELECT r.user_id, r.net_name, r.real_name, r.class_no, IFNULL(r.is_admin, 0) AS is_admin,',
    '       IFNULL(r.allocated_micro, 0) AS allocated,',
    '       IFNULL(s2.used_micro, 0) AS used,',
    '       r.instance_id',
    'FROM sync_roster r',
    'LEFT JOIN (SELECT user_id, SUM(cost_micro) AS used_micro FROM cluss_usage_log GROUP BY user_id) s2 ON s2.user_id = r.user_id',
    'WHERE r.instance_id <> \'\' AND r.user_id NOT IN (SELECT user_id FROM users)',
    '  AND (IFNULL(r.allocated_micro, 0) > 0 OR IFNULL(s2.used_micro, 0) > 0)',
    'ORDER BY allocated DESC'
  ].join('\n')).all();

  var lines = ['用户ID,用户名,姓名,班级,是否管理员,已分配(元),已消耗(元),余额(元),来源班级'];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    lines.push([
      r.user_id,
      String(r.net_name || '').replace(/,/g, '，'),
      String(r.real_name || '').replace(/,/g, '，'),
      String(r.class_no || ''),
      r.is_admin === 1 ? '是' : '否',
      config.microToYuan(r.allocated).toFixed(2),
      config.microToYuan(r.used).toFixed(2),
      config.microToYuan(r.allocated - r.used).toFixed(2),
      String(r.instance_id || '本班')
    ].join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cluss-snapshot.csv"');
  res.send('\ufeff' + lines.join('\n'));   // BOM 让 Excel 正确识别 UTF-8
});

// ============================================================
// 模型管理
//
// 设计原则：改完即时生效，不做缓存 —— 每次对话都重新 resolveModel，
// 所以改单价/换 Key 不需要重启服务，也不需要清缓存。
// ============================================================

// API Key 掩码：管理台要能看出「配了没配」，但不该把完整 Key 回传到浏览器
function maskKey(key) {
  var k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '••••';
  return k.slice(0, 4) + '••••' + k.slice(-4);
}

function serializeModelForAdmin(r, sourcesMap) {
  var pricing = require('../services/pricing');
  var ai = require('../services/ai');
  var health = require('../utils/model-health');
  var multBp = r.price_multiplier_bp > 0 ? r.price_multiplier_bp : 10000;
  var freeActive = !(r.is_free === 1) && pricing.isModelFree(r);
  var h = health.getHealthRow(r.id);

  // 连接信息可能来自模型所挂的源（迁移 022）。管理台表格要展示"实际会用哪个
  // 地址 / 这把 Key 是从哪来的"，否则管理员会对着模型上那份空地址困惑。
  var map = sourcesMap || ai.loadSourcesMap();
  var sourceId = String(r.source_id || '');
  var src = sourceId ? (map[sourceId] || null) : null;
  var useSource = !!(src && src.enabled !== 0);
  var resolvedUrl = useSource ? (src.api_url || '') : (r.api_url || '');
  var resolvedKey = useSource ? (src.api_key || '') : (r.api_key || '');
  var resolvedStyle = (useSource && src.api_style) ? src.api_style : (r.api_style || 'openai');

  // 峰窗回传成 [{start,end}]，前端表单可直接 v-model；折扣回传「折」
  var offpeakWindows = [];
  if (r.offpeak_peak_windows) {
    try {
      var arr = JSON.parse(r.offpeak_peak_windows);
      if (Array.isArray(arr)) {
        offpeakWindows = arr.map(function(w) {
          return { start: String((w && w.start) || ''), end: String((w && w.end) || '') };
        });
      }
    } catch (e) { offpeakWindows = []; }
  }
  var offpeakBp = Number(r.offpeak_discount_bp || 0);

  return {
    id: r.id,
    label: r.label,
    api_url: resolvedUrl,
    api_key_masked: maskKey(resolvedKey),
    has_api_key: !!resolvedKey,
    // 连接信息是否继承自源：前端据此把地址/密钥输入框置灰并标注来源
    api_key_from_source: useSource ? 1 : 0,
    source_id: sourceId,
    source_label: useSource ? (src.label || src.id) : '',
    // 挂了源但源不存在/已停用：表格要给出警示（否则显示成"未配置地址"很误导）
    source_missing: !!(sourceId && !useSource),
    model_name: r.model_name || '',
    api_style: resolvedStyle,
    supports_stream: r.supports_stream !== 0 ? 1 : 0,
    supports_vision: r.supports_vision === 1 ? 1 : 0,
    vision_max_images: r.vision_max_images || 0,
    // 深度思考能力：管理员实测后勾选。必须实测 —— 同一上游里不同模型
    // 对 enable_thinking 的反应完全不同（实测 vision 模型有效、v4.1 无效），
    // 靠命名或文档猜会让学生开了开关却什么都看不到。
    supports_thinking: r.supports_thinking === 1 ? 1 : 0,
    price_in: r.price_in || 0,
    price_out: r.price_out || 0,
    price_cache_hit: r.price_cache_hit || 0,
    // 倍率回传小数（万分比 → ×1.0 口径），前端直接编辑
    price_multiplier: Math.round(multBp) / 10000,
    free_until: r.free_until ? time.toISO(r.free_until) : '',
    free_active: freeActive ? 1 : 0,
    is_free: r.is_free === 1 ? 1 : 0,
    enabled: r.enabled === 1 ? 1 : 0,
    // 迁移 032：「本机可用」与「下发到各班」是两件事。关掉后本机照常用，
    // 只是不进入节点快照。列不存在时按「发」处理（= 老行为）。
    sync_enabled: r.sync_enabled === 0 ? 0 : 1,
    is_default: r.is_default === 1 ? 1 : 0,
    // ---- 峰谷（迁移 022：逐模型声明，不再是全局一刀切）----
    has_offpeak: r.has_offpeak === 1 ? 1 : 0,
    offpeak_peak_windows: offpeakWindows,
    // 「折」口径回传（5000 万分比 → 5 折）；0 = 留空、回退全局默认
    offpeak_discount: offpeakBp > 0 ? Math.round(offpeakBp / 100) / 10 : 0,
    // 健康是运行时事实，不混进配置字段（enabled 是管理员意图，两者必须分开）：
    // 否则管理员看到"启用了但不能用"会以为是 Bug，而实际上是上游挂了。
    health_status: h.health_status || 'unknown',
    health_detail: h.health_detail || '',
    fail_count: h.fail_count || 0,
    health_checked_at: h.checked_at ? time.toISO(h.checked_at) : '',
    sort_order: r.sort_order || 0,
    created_at: time.toISO(r.created_at)
  };
}

function serializeSourceForAdmin(s) {
  var used = 0;
  try {
    used = db.prepare('SELECT COUNT(*) AS c FROM ai_models WHERE source_id = ?').get(s.id).c;
  } catch (e) { used = 0; }
  return {
    id: s.id,
    label: s.label || '',
    api_url: s.api_url || '',
    api_key_masked: maskKey(s.api_key),
    has_api_key: !!s.api_key,
    api_style: s.api_style || 'openai',
    enabled: s.enabled === 1 ? 1 : 0,
    // 迁移 032：源关闭下发时，挂在它上面的模型会级联不再下发
    sync_enabled: s.sync_enabled === 0 ? 0 : 1,
    sort_order: s.sort_order || 0,
    // 有几个模型挂在这个源上：删除前要提示影响面
    model_count: used
  };
}

router.get('/models', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var ai = require('../services/ai');
  var pricing = require('../services/pricing');
  var rows = db.prepare('SELECT * FROM ai_models ORDER BY sort_order ASC, id ASC').all();
  var sourcesMap = ai.loadSourcesMap();
  var vision = require('../services/vision').getVisionConfig();

  // 计费基准 = 默认模型的三档单价。管理台把它摆在面板说明里常驻可见：
  // 「其他模型按 基准 × 倍率 扣积分」这件事，看一眼就能对上号
  var baseRow = db.prepare(
    'SELECT id, label, price_in, price_out, price_cache_hit FROM ai_models WHERE is_default = 1 LIMIT 1'
  ).get();

  var globOffpeak = pricing.getOffpeakConfig();

  res.json({
    code: 200,
    message: 'ok',
    data: {
      // node 模式下模型由云端统一下发。持有管理员席位的班可以改（改动上行同步
      // 全校），非席位班只读 —— 前端据此禁用按钮并说明原因。
      read_only: config.mode === config.MODES.NODE && !(syncService.getStatus().is_seat_admin),
      read_only_reason: (function() {
        if (config.mode !== config.MODES.NODE) return '';
        var st = syncService.getStatus();
        if (st.is_seat_admin) return '';
        if (!st.seat_instance) {
          return '本机已接入 Cluss-Cloud，但本校还没有认领管理员席位。认领后本班班管就能在这里改配置，改动会同步到全校所有班。';
        }
        return '本校管理员席位在 ' + st.seat_instance + ' 班，本班只能查看。请到管理员班修改，或在云端解绑后由本班认领。';
      })(),
      writes_to_school: config.mode === config.MODES.NODE && !!syncService.getStatus().is_seat_admin,
      models: rows.map(function(r) { return serializeModelForAdmin(r, sourcesMap); }),
      // 模型源清单（源可选；模型可挂源共享地址/密钥，也可自带连接信息）
      sources: ai.listSources().map(serializeSourceForAdmin),
      // 下发范围汇总（迁移 032）：前端据此解释「为什么某个模型在班里看不到」，
      // 也用来决定要不要显示「下发」这一列 —— 一个班都没接入时它是噪音。
      sync_scope: (function() {
        var c = modelConfig.syncScopeCounts();
        var nodes = { total: 0, following: 0 };
        try {
          var list = db.prepare("SELECT IFNULL(model_sync, 1) AS s FROM cluss_nodes WHERE status != 'revoked'").all();
          nodes.total = list.length;
          for (var i = 0; i < list.length; i++) if (Number(list[i].s) !== 0) nodes.following++;
        } catch (e) { /* 老 schema / 单机：没有已接入的班 */ }
        return {
          models: c.models,
          synced_models: c.synced_models,
          sources: c.sources,
          synced_sources: c.synced_sources,
          nodes_total: nodes.total,
          nodes_following: nodes.following
        };
      })(),
      default_model: (function() {
        var d = db.prepare('SELECT id FROM ai_models WHERE is_default = 1 LIMIT 1').get();
        return d ? d.id : '';
      })(),
      base_model: baseRow ? {
        id: baseRow.id,
        label: baseRow.label,
        price_in: baseRow.price_in || 0,
        price_out: baseRow.price_out || 0,
        price_cache_hit: baseRow.price_cache_hit || 0
      } : null,
      // 全局峰谷配置：如今是「新模型的默认值 / 模型未声明时的兜底」，
      // 模型表单用它预填，标签也据此说明"留空即用这份全局默认"
      offpeak_defaults: {
        enabled: globOffpeak.enabled ? 1 : 0,
        peak_windows: globOffpeak.peaks.map(function(w) {
          return { start: minutesToHm(w.startMin), end: minutesToHm(w.endMin) };
        }),
        discount: Math.round(globOffpeak.discountBp / 100) / 10
      },
      vision_relay_model_id: vision.relayModelId,
      // 库存口径提示：微元/千 token（2000 = 2 元/百万）；管理台表单已自动按「元/百万」换算
      price_unit_note: '库存单位「微元 / 千 token」（2000 = 2 元/百万）；管理台表单按「元 / 百万 token」输入并自动换算'
    }
  });
});

// 价格换算：库存单位是「微元 / 千 token」，管理台表单按「元 / 百万 token」
// 口径显示并负责 ×1000（1 元/百万 = 1000 微元/千），所以 API 层收到的是
// 已换算好的库存值，这里只需整数化与范围校验
function parsePrice(v, label) {
  var n = Number(v);
  if (!isFinite(n) || n < 0) return { ok: false, message: label + '必须是不小于 0 的数字' };
  if (n > 100000) return { ok: false, message: label + '过大（上限 100000）' };
  return { ok: true, value: Math.round(n) };
}

function validateModelInput(body, isCreate) {
  var b = body || {};
  var out = {};

  if (isCreate) {
    var id = String(b.id || '').trim();
    if (!id) return { ok: false, message: '模型 ID 不能为空' };
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) {
      return { ok: false, message: '模型 ID 只能用字母、数字、点、下划线、短横线' };
    }
    out.id = id;
  }

  if (b.label !== undefined) out.label = String(b.label || '').trim().slice(0, 60) || 'unnamed';
  if (b.api_url !== undefined) out.api_url = String(b.api_url || '').trim().slice(0, 300);
  if (b.api_key !== undefined) out.api_key = String(b.api_key || '').trim().slice(0, 400);
  if (b.model_name !== undefined) out.model_name = String(b.model_name || '').trim().slice(0, 120);
  if (b.api_style !== undefined) out.api_style = b.api_style === 'deepseek' ? 'deepseek' : 'openai';

  // 模型源（迁移 022）：source_id 非空表示连接信息来自该源（地址/密钥以源为准）。
  // 这里只校验格式，存在性在路由里查（要给出一条能看懂的错误）。
  if (b.source_id !== undefined) {
    var sid = String(b.source_id || '').trim();
    if (sid && !/^[A-Za-z0-9._-]{1,60}$/.test(sid)) {
      return { ok: false, message: '模型源 ID 只能用字母、数字、点、下划线、短横线' };
    }
    out.source_id = sid;
  }

  // ---- 峰谷（逐模型）----
  // has_offpeak = 0 明确表示"这个模型不参与峰谷"（与"没声明"不同，后者回退全局）
  if (b.has_offpeak !== undefined) out.has_offpeak = b.has_offpeak ? 1 : 0;
  if (b.offpeak_peak_windows !== undefined) {
    // 空数组 = 显式清空（回退全局默认峰窗）；非空才校验格式。
    // 区分这两种，否则管理员永远没法把模型改回"用全局默认"。
    if (Array.isArray(b.offpeak_peak_windows) && b.offpeak_peak_windows.length === 0) {
      out.offpeak_peak_windows = '';
    } else {
      var w = parsePeakWindowsInput(b.offpeak_peak_windows);
      if (w === null) {
        return { ok: false, message: '峰时段必须是 1~2 个不重叠的 HH:MM 窗口（留空则用全局默认）' };
      }
      // 只留 HH:MM，入库口径与全局配置一致（pricing.parsePeakWindows 直接吃）
      out.offpeak_peak_windows = JSON.stringify(w.map(function(x) {
        return { start: x.start, end: x.end };
      }));
    }
  }
  if (b.offpeak_discount !== undefined && b.offpeak_discount !== '' && b.offpeak_discount !== 0) {
    var zhe = Number(b.offpeak_discount);
    if (!isFinite(zhe) || zhe < 0.1 || zhe > 9.9) {
      return { ok: false, message: '谷时折扣必须在 0.1 ~ 9.9 折之间' };
    }
    out.offpeak_discount_bp = Math.round(zhe * 1000);
  } else if (b.offpeak_discount !== undefined) {
    // 显式传 0 / 空 → 清空，回退全局默认
    out.offpeak_discount_bp = 0;
  }

  if (b.supports_stream !== undefined) out.supports_stream = b.supports_stream ? 1 : 0;
  if (b.supports_vision !== undefined) out.supports_vision = b.supports_vision ? 1 : 0;
  if (b.supports_thinking !== undefined) out.supports_thinking = b.supports_thinking ? 1 : 0;
  if (b.vision_max_images !== undefined) {
    var vm = parseInt(b.vision_max_images, 10);
    out.vision_max_images = isFinite(vm) && vm > 0 ? Math.min(vm, 6) : 0;
  }
  if (b.is_free !== undefined) out.is_free = b.is_free ? 1 : 0;
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.sort_order !== undefined) out.sort_order = parseInt(b.sort_order, 10) || 0;

  // 倍率：管理台填小数（0.01 ~ 100），库里存万分比
  if (b.price_multiplier !== undefined && b.price_multiplier !== '') {
    var mult = Number(b.price_multiplier);
    if (!isFinite(mult) || mult < 0.01 || mult > 100) {
      return { ok: false, message: '倍率必须在 0.01 ~ 100 之间' };
    }
    out.price_multiplier_bp = Math.round(mult * 10000);
  }

  // 限免截止：'' / null 表示清除；否则接受客户端转好的 UTC ISO 串。
  // 为什么让前端转时区：datetime-local 的值没有时区语义，浏览器按本地时区
  // 解析成 ISO 再上传，服务端不必猜「管理员脑中的时间」是哪个时区。
  if (b.free_until !== undefined) {
    var fu = String(b.free_until || '').trim();
    if (!fu) {
      out.free_until = '';
    } else {
      var d = new Date(fu);
      if (isNaN(d.getTime())) return { ok: false, message: '限免截止时间无法解析' };
      out.free_until = time.fmtUtc(d);
    }
  }

  var fields = [
    ['price_in', '输入单价'],
    ['price_out', '输出单价'],
    ['price_cache_hit', '缓存命中单价']
  ];
  for (var i = 0; i < fields.length; i++) {
    var key = fields[i][0];
    if (b[key] !== undefined && b[key] !== '') {
      var p = parsePrice(b[key], fields[i][1]);
      if (!p.ok) return p;
      out[key] = p.value;
    }
  }

  return { ok: true, data: out };
}

router.post('/models', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var v = validateModelInput(req.body, true);
  if (!v.ok) return res.status(400).json({ code: 400, message: v.message });

  var d = v.data;
  var exists = db.prepare('SELECT id FROM ai_models WHERE id = ?').get(d.id);
  if (exists) return res.status(409).json({ code: 409, message: '该模型 ID 已存在' });

  // 挂了源就必须真的存在，否则会得到一个"配好了却用不了"的模型
  if (d.source_id) {
    var src = db.prepare('SELECT id FROM ai_sources WHERE id = ?').get(d.source_id);
    if (!src) return res.status(400).json({ code: 400, message: '指定的模型源不存在，请先在下方「模型源」里创建' });
  }

  db.prepare([
    'INSERT INTO ai_models (id, label, api_url, api_key, model_name, api_style,',
    '  supports_thinking, supports_stream, supports_vision, vision_max_images,',
    '  price_in, price_out, price_cache_hit, price_multiplier_bp, free_until,',
    '  is_free, enabled, source_id, has_offpeak, offpeak_peak_windows, offpeak_discount_bp,',
    '  is_default, sort_order, created_at)',
    // 23 个 ?（含 4 个峰谷/源新列）→ is_default 字面 0 → 2 个 ?
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
  ].join('\n')).run(
    d.id, d.label || d.id, d.api_url || '', d.api_key || '', d.model_name || d.id, d.api_style || 'openai',
    d.supports_thinking || 0,
    d.supports_stream === undefined ? 1 : d.supports_stream,
    d.supports_vision || 0, d.vision_max_images || 0,
    d.price_in || 0, d.price_out || 0, d.price_cache_hit || 0,
    d.price_multiplier_bp || 10000, d.free_until || '',
    d.is_free || 0, d.enabled === undefined ? 1 : d.enabled,
    d.source_id || '', d.has_offpeak || 0, d.offpeak_peak_windows || '', d.offpeak_discount_bp || 0,
    d.sort_order || 0, time.nowUtc()
  );

  console.log('[Admin] 新增模型: %s by %s', d.id, req.user.user_id);
  var mv = bumpModelAndQueue(req);
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(d.id);
  res.json({ code: 200, message: '已添加，模型配置版本 ' + mv + '（各班节点将在 1 分钟内自动同步）', data: serializeModelForAdmin(row) });
});

router.put('/models/:id', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型不存在' });

  var v = validateModelInput(req.body, false);
  if (!v.ok) return res.status(400).json({ code: 400, message: v.message });

  var d = v.data;
  // api_key 留空表示「不修改」：否则管理员只改单价时会把 Key 清掉
  if (d.api_key !== undefined && !d.api_key) delete d.api_key;

  // 改挂的源必须存在（改回"不挂源"是 source_id = ''，不在校验范围）
  if (d.source_id) {
    var src = db.prepare('SELECT id FROM ai_sources WHERE id = ?').get(d.source_id);
    if (!src) return res.status(400).json({ code: 400, message: '指定的模型源不存在' });
  }

  var keys = Object.keys(d);
  if (!keys.length) return res.status(400).json({ code: 400, message: '没有要修改的内容' });

  var sets = [];
  var params = [];
  for (var i = 0; i < keys.length; i++) {
    sets.push(keys[i] + ' = ?');
    params.push(d[keys[i]]);
  }
  params.push(id);

  var stmt = db.prepare('UPDATE ai_models SET ' + sets.join(', ') + ' WHERE id = ?');
  stmt.run.apply(stmt, params);

  console.log('[Admin] 更新模型: %s by %s', id, req.user.user_id);
  var mv = bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: '已更新，模型配置版本 ' + mv + '（各班节点将在 1 分钟内自动同步）',
    data: serializeModelForAdmin(db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id))
  });
});

// 删除：若已被会话引用则改为软禁用
// 硬删会让历史会话的 model_id 指向不存在的模型，管理台的用量统计就 JOIN 不出名字了
router.delete('/models/:id', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型不存在' });

  var total = db.prepare('SELECT COUNT(*) AS c FROM ai_models').get().c;
  if (total <= 1) {
    return res.status(400).json({ code: 400, message: '至少要保留一个模型' });
  }

  var used = db.prepare(
    'SELECT COUNT(*) AS c FROM ai_conversations WHERE model_id = ?'
  ).get(id).c;

  if (used > 0) {
    db.prepare('UPDATE ai_models SET enabled = 0, is_default = 0 WHERE id = ?').run(id);
    bumpModelAndQueue(req);
    console.log('[Admin] 模型已被 %d 个会话引用，改为禁用: %s', used, id);
    return res.json({
      code: 200,
      message: '该模型已被 ' + used + ' 个会话使用，已改为「禁用」而非删除（保留历史记录可追溯）',
      data: { soft_disabled: true }
    });
  }

  db.prepare('DELETE FROM ai_models WHERE id = ?').run(id);
  bumpModelAndQueue(req);
  console.log('[Admin] 删除模型: %s by %s', id, req.user.user_id);
  res.json({ code: 200, message: '已删除', data: { soft_disabled: false } });
});

router.post('/models/:id/set-default', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型不存在' });
  if (row.enabled !== 1) return res.status(400).json({ code: 400, message: '禁用的模型不能设为默认' });

  var tx = db.transaction(function() {
    db.prepare('UPDATE ai_models SET is_default = 0').run();
    // 默认模型是全站计费基准（×1.00）：换默认时必须把它的倍率归一，
    // 否则基准自己带着倍率，所有模型（含它自己）的账单会整体漂移。
    //
    // 同时强制打开下发（迁移 032）：默认模型是各班的计费参照，缺了它节点上
    // 所有倍率都没有基准，界面会冒出一句「尚未设置默认模型单价」。
    // 这里选择顺手打开并说明，而不是拒绝 —— 管理员的意图很明确是「换基准」。
    db.prepare('UPDATE ai_models SET is_default = 1, price_multiplier_bp = 10000, sync_enabled = 1 WHERE id = ?').run(id);
  });
  tx();

  var forcedSync = row.sync_enabled === 0;
  console.log('[Admin] 默认模型改为: %s（倍率已重置为 ×1.00%s）by %s',
    id, forcedSync ? '，并恢复下发' : '', req.user.user_id);
  bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: '已设为默认模型（计费基准，倍率已重置为 ×1.00）'
      + (forcedSync ? '；它原本不下发，已一并加入下发范围' : ''),
    data: { default_model: id, sync_enabled: 1 }
  });
});

// ============================================================
// POST /admin/models/:id/sync —— 这个模型是否下发到各班（迁移 032）
// body: { enabled: 0|1 }
//
// 与「启用 / 禁用」是两件事，两个都需要：
//   enabled       = 本机用不用；
//   sync_enabled  = 发不发到别的班。
// 想让一个模型先在本机试跑、暂时不给学生班看到，就该是「启用但不下发」。
// 合成一个开关的话，要么本机用不了，要么全校被迫同步。
// ============================================================
router.post('/models/:id/sync', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var raw = req.body && req.body.enabled;
  var on = (raw === true || Number(raw) === 1) ? 1 : 0;

  // 护栏（默认模型必须下发）在 service 里，和快照过滤用同一份判断 ——
  // 见 model-config.setModelSync 的注释
  var r = modelConfig.setModelSync(req.params.id, on);
  if (!r.ok) return res.status(r.code || 400).json({ code: r.code || 400, message: r.message });

  console.log('[Admin] 模型下发范围: %s → %s by %s', r.id, on ? '下发' : '仅本机', req.user.user_id);
  var mv = bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: on
      ? ('「' + r.name + '」将下发到各班（配置 v' + mv + '，节点 1 分钟内自动同步）')
      : ('「' + r.name + '」只保留在本机，各班的模型列表里会移除它（配置 v' + mv + '）'),
    data: { id: r.id, sync_enabled: on, model_config_version: mv }
  });
});

// ============================================================
// POST /admin/sources/:id/sync —— 这个模型源是否下发到各班
// body: { enabled: 0|1 }
//
// 源关闭时它挂着的模型会**级联**不再下发（见 model-config 的 SYNCED_MODEL_WHERE）：
// 只发模型不发源，节点会收到一个指向不存在源的模型，界面上写「源已失效」——
// 提示与事实相反，管理员根本猜不到是中枢少发了源。
// ============================================================
router.post('/sources/:id/sync', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var raw = req.body && req.body.enabled;
  var on = (raw === true || Number(raw) === 1) ? 1 : 0;

  // 护栏（源上的默认模型不能被级联带走）在 service 里，见 model-config.setSourceSync
  var r = modelConfig.setSourceSync(req.params.id, on);
  if (!r.ok) return res.status(r.code || 400).json({ code: r.code || 400, message: r.message });

  console.log('[Admin] 模型源下发范围: %s → %s（挂载 %d 个模型）by %s',
    r.id, on ? '下发' : '仅本机', r.affected_models, req.user.user_id);
  var mv = bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: on
      ? ('源「' + r.name + '」将下发到各班（配置 v' + mv + '）')
      : ('源「' + r.name + '」不再下发，挂在它上面的 '
        + r.affected_models + ' 个模型会一并停止下发（配置 v' + mv + '）'),
    data: {
      id: r.id,
      sync_enabled: on,
      affected_models: r.affected_models,
      model_config_version: mv
    }
  });
});

// 连通性测试：发一条最小请求，验证地址与 Key 是否可用
router.post('/models/:id/test', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var id = String(req.params.id || '');
  var ai = require('../services/ai');
  var mc = ai.resolveModel(id);
  if (!mc) return res.status(404).json({ code: 404, message: '模型不存在' });
  if (!mc.ready) {
    return res.status(400).json({ code: 400, message: '模型未配置完成：' + mc.unavailableReason });
  }

  var started = Date.now();
  ai.chatOnce(mc, [
    { role: 'system', content: '你是连通性测试助手。' },
    { role: 'user', content: '请只回复两个字：正常' }
  ], { timeout: 30000, temperature: 0 }).then(function(data) {
    var text = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    res.json({
      code: 200,
      message: '连通正常',
      data: {
        ok: true,
        reply: String(text || '').slice(0, 100),
        elapsed_ms: Date.now() - started,
        usage: data && data.usage ? {
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0
        } : null
      }
    });
  }).catch(function(err) {
    res.json({
      code: 200,
      message: '测试失败',
      data: {
        ok: false,
        error: err.message || '调用失败',
        detail: err.detail || '',
        elapsed_ms: Date.now() - started
      }
    });
  });
});

// ============================================================
// 模型源（迁移 022）
//
// 一个上游常常一次提供多个模型：地址与 Key 完全相同，只有上游模型名不同。
// 把连接信息沉到「源」上，模型只记 source_id —— 上游换域名/换 Key 只改一处。
// **源是可选的**：不挂源的模型继续用自己的 api_url / api_key（存量零迁移）。
// ============================================================

function validateSourceInput(body, isCreate) {
  var b = body || {};
  var out = {};

  if (isCreate) {
    var id = String(b.id || '').trim();
    if (!id) return { ok: false, message: '模型源 ID 不能为空' };
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) {
      return { ok: false, message: '模型源 ID 只能用字母、数字、点、下划线、短横线' };
    }
    out.id = id;
  }

  if (b.label !== undefined) out.label = String(b.label || '').trim().slice(0, 60) || 'unnamed';
  if (b.api_url !== undefined) out.api_url = String(b.api_url || '').trim().slice(0, 300);
  if (b.api_key !== undefined) out.api_key = String(b.api_key || '').trim().slice(0, 400);
  if (b.api_style !== undefined) out.api_style = b.api_style === 'deepseek' ? 'deepseek' : 'openai';
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.sort_order !== undefined) out.sort_order = parseInt(b.sort_order, 10) || 0;

  return { ok: true, data: out };
}

router.get('/sources', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var rows = db.prepare('SELECT * FROM ai_sources ORDER BY sort_order ASC, id ASC').all();
  res.json({ code: 200, message: 'ok', data: { sources: rows.map(serializeSourceForAdmin) } });
});

router.post('/sources', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var v = validateSourceInput(req.body, true);
  if (!v.ok) return res.status(400).json({ code: 400, message: v.message });

  var d = v.data;
  var exists = db.prepare('SELECT id FROM ai_sources WHERE id = ?').get(d.id);
  if (exists) return res.status(409).json({ code: 409, message: '该模型源 ID 已存在' });

  db.prepare([
    'INSERT INTO ai_sources (id, label, api_url, api_key, api_style, enabled, sort_order, created_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(
    d.id, d.label || d.id, d.api_url || '', d.api_key || '',
    d.api_style || 'openai', d.enabled === undefined ? 1 : d.enabled,
    d.sort_order || 0, time.nowUtc()
  );

  console.log('[Admin] 新增模型源: %s by %s', d.id, req.user.user_id);
  bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: '已添加',
    data: serializeSourceForAdmin(db.prepare('SELECT * FROM ai_sources WHERE id = ?').get(d.id))
  });
});

router.put('/sources/:id', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型源不存在' });

  var v = validateSourceInput(req.body, false);
  if (!v.ok) return res.status(400).json({ code: 400, message: v.message });

  var d = v.data;
  // 与模型同样的语义：Key 留空 = 不修改（只改地址/名字时不该把 Key 抹掉）
  if (d.api_key !== undefined && !d.api_key) delete d.api_key;

  var keys = Object.keys(d);
  if (!keys.length) return res.status(400).json({ code: 400, message: '没有要修改的内容' });

  var sets = [];
  var params = [];
  for (var i = 0; i < keys.length; i++) {
    sets.push(keys[i] + ' = ?');
    params.push(d[keys[i]]);
  }
  params.push(id);
  var stmt = db.prepare('UPDATE ai_sources SET ' + sets.join(', ') + ' WHERE id = ?');
  stmt.run.apply(stmt, params);

  console.log('[Admin] 更新模型源: %s by %s', id, req.user.user_id);
  bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: '已更新',
    data: serializeSourceForAdmin(db.prepare('SELECT * FROM ai_sources WHERE id = ?').get(id))
  });
});

// 删除源：仍被模型引用时先拦一次（避免一次误点把 N 个模型悄悄变成不可用）；
// 带 ?force=1 再确认，则把这些模型回退到「自带地址/密钥」后删除源。
router.delete('/sources/:id', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型源不存在' });

  var used = db.prepare('SELECT COUNT(*) AS c FROM ai_models WHERE source_id = ?').get(id).c;
  var force = String(req.query.force || '') === '1';

  if (used > 0 && !force) {
    return res.status(409).json({
      code: 409,
      message: '还有 ' + used + ' 个模型挂在这个模型源上。删除后它们会回退到各自的地址/密钥（可能为空），确认删除请再点一次。',
      data: { model_count: used, need_confirm: true }
    });
  }

  var tx = db.transaction(function() {
    db.prepare("UPDATE ai_models SET source_id = '' WHERE source_id = ?").run(id);
    db.prepare('DELETE FROM ai_sources WHERE id = ?').run(id);
  });
  tx();

  console.log('[Admin] 删除模型源: %s（%d 个模型回退自带配置）by %s', id, used, req.user.user_id);
  bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: used > 0 ? ('已删除，' + used + ' 个模型已回退到自带配置') : '已删除',
    data: { detached: used }
  });
});

// ============================================================
// 峰谷时段（积分策略，存 cluss_meta，改完即时生效）
//
// 配置的是**峰时段（忙时）**窗口（1~2 个，可跨午夜），谷时（峰外）按折扣计。
// 管理台以「折」为输入单位（谷时段按 5 折计费），库里存万分比。
// 判定用服务器本地时间 —— 峰谷面向的是"学生几点在用"这面墙上的钟。
//
// 注（迁移 022 起）：这份配置是**全局默认值**，逐模型可在模型表单里
// 声明"是否参与峰谷 / 自己的峰窗与折扣"；模型未声明时才回退到这里。
// ============================================================

var HM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// 把可能跨午夜的窗口展开成不跨午夜的区间列表（跨午夜 = [s,24:00) + [00:00,e)）
function expandWindow(s, e) {
  if (s < e) return [[s, e]];
  return [[s, 1440], [0, e]];
}

function windowsOverlap(a, b) {
  var A = expandWindow(a.startMin, a.endMin);
  var B = expandWindow(b.startMin, b.endMin);
  for (var i = 0; i < A.length; i++) {
    for (var j = 0; j < B.length; j++) {
      if (A[i][0] < B[j][1] && B[j][0] < A[i][1]) return true;
    }
  }
  return false;
}

// 校验并归一前端提交的峰窗口；不合法返回 null
function parsePeakWindowsInput(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) return null;
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var w = raw[i] || {};
    var s = String(w.start || '').trim();
    var e = String(w.end || '').trim();
    if (!HM_RE.test(s) || !HM_RE.test(e) || s === e) return null;
    out.push({ start: s, end: e, startMin: pricing.parseHm(s, -1), endMin: pricing.parseHm(e, -1) });
  }
  if (out.length === 2 && windowsOverlap(out[0], out[1])) return null;
  return out;
}

router.get('/offpeak', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var pricing = require('../services/pricing');
  var cfg = pricing.getOffpeakConfig();
  var activeNow = pricing.isInOffpeakWindow(cfg);

  res.json({
    code: 200,
    message: 'ok',
    data: {
      enabled: cfg.enabled,
      peak_windows: cfg.peaks.map(function(w) {
        return { start: minutesToHm(w.startMin), end: minutesToHm(w.endMin) };
      }),
      discount_bp: cfg.discountBp,
      // 「折」给管理台显示（5000 → 5）
      discount: Math.round(cfg.discountBp / 100) / 10,
      // active_now = 当前处于谷时（折扣生效中）；peak_now = 当前处于忙时
      active_now: activeNow,
      peak_now: cfg.enabled && !activeNow
    }
  });
});

router.put('/offpeak', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var pricing = require('../services/pricing');
  var b = req.body || {};

  var enabled = !!b.enabled;
  var windows = parsePeakWindowsInput(b.peak_windows);
  if (enabled && !windows) {
    return res.status(400).json({
      code: 400,
      message: '峰时段必须是 1~2 个不重叠的 HH:MM 窗口（如 09:00-12:00 与 14:00-18:00）'
    });
  }

  // 折扣：0.1 ~ 9.9 折；10 折等于没折，直接视为关闭更不容易误导
  var zhe = Number(b.discount);
  if (!isFinite(zhe) || zhe < 0.1 || zhe > 9.9) {
    return res.status(400).json({ code: 400, message: '折扣必须在 0.1 ~ 9.9 折之间' });
  }
  var discountBp = Math.round(zhe * 1000);

  var peaks = (windows || pricing.getOffpeakConfig().peaks).map(function(w) {
    return { start: w.start || minutesToHm(w.startMin), end: w.end || minutesToHm(w.endMin) };
  });

  pricing.setOffpeakConfig({ enabled: enabled, peaks: peaks, discountBp: discountBp });

  var cfg = pricing.getOffpeakConfig();
  console.log('[Admin] 峰谷配置更新 by %s: %j', req.user.user_id, {
    enabled: cfg.enabled,
    peaks: cfg.peaks.map(function(w) { return minutesToHm(w.startMin) + '-' + minutesToHm(w.endMin); }),
    discount: zhe
  });
  // 峰谷是节点本地计费口径的一部分（模型级峰窗留空时回退全局），必须随配置下发
  bumpModelAndQueue(req);

  var activeNow = pricing.isInOffpeakWindow(cfg);
  res.json({
    code: 200,
    message: '已保存',
    data: {
      enabled: cfg.enabled,
      peak_windows: cfg.peaks.map(function(w) {
        return { start: minutesToHm(w.startMin), end: minutesToHm(w.endMin) };
      }),
      discount_bp: cfg.discountBp,
      discount: Math.round(cfg.discountBp / 100) / 10,
      active_now: activeNow,
      peak_now: cfg.enabled && !activeNow
    }
  });
});

// 分钟数 → 'HH:MM'（峰谷配置入库是分钟数口径的展示反转）
function minutesToHm(min) {
  var m = Math.max(0, Math.min(1439, Math.round(Number(min) || 0)));
  var h = Math.floor(m / 60);
  var mm = m % 60;
  return (h < 10 ? '0' + h : String(h)) + ':' + (mm < 10 ? '0' + mm : String(mm));
}

// ============================================================
// 视觉配置
// ============================================================
router.get('/vision', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var vision = require('../services/vision');
  var ai = require('../services/ai');
  var cfg = vision.getVisionConfig();
  var rows = db.prepare('SELECT * FROM ai_models ORDER BY sort_order ASC').all();
  // 连接信息可能来自模型所挂的源（迁移 022），所以不能用行上的 api_url/api_key
  // 直接判断"配没配好" —— 挂了源的模型这两个字段本来就是空的，
  // 用旧判据会让它们从转述候选里被误删。
  var sourcesMap = ai.loadSourcesMap();

  res.json({
    code: 200,
    message: 'ok',
    data: {
      enabled: cfg.enabled,
      relay_model_id: cfg.relayModelId,
      max_images: cfg.maxImages,
      image_max_edge: cfg.imageMaxEdge,
      image_quality: cfg.imageQuality,
      shrink_enabled: cfg.shrinkEnabled,
      sharp_available: vision.sharpAvailable,
      // 只有自身支持视觉且可用的模型才能当转述模型
      relay_candidates: rows.filter(function(r) {
        if (r.supports_vision !== 1 || r.enabled !== 1) return false;
        var m = ai.rowToModel(r, sourcesMap[r.source_id] || null);
        return !!(m.apiUrl && m.apiKey);
      }).map(function(r) {
        return { id: r.id, label: r.label };
      })
    }
  });
});

router.put('/vision', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var vision = require('../services/vision');
  var b = req.body || {};
  var patch = {};

  if (b.enabled !== undefined) patch.vision_enabled = b.enabled ? '1' : '0';
  if (b.shrink_enabled !== undefined) patch.image_shrink_enabled = b.shrink_enabled ? '1' : '0';

  if (b.relay_model_id !== undefined) {
    var relayId = String(b.relay_model_id || '').trim();
    if (relayId) {
      // 转述模型必须自己支持视觉，否则转述本身就无法工作
      var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(relayId);
      if (!row) return res.status(404).json({ code: 404, message: '转述模型不存在' });
      if (row.supports_vision !== 1) {
        return res.status(400).json({ code: 400, message: '转述模型必须自身支持视觉，请先在该模型上勾选「支持视觉」' });
      }
    }
    patch.vision_relay_model_id = relayId;
  }

  if (b.max_images !== undefined) {
    var n = parseInt(b.max_images, 10);
    if (!isFinite(n) || n < 1) return res.status(400).json({ code: 400, message: '最多图片数必须大于 0' });
    patch.vision_max_images = String(Math.min(n, 6));
  }
  if (b.image_max_edge !== undefined) {
    var e = parseInt(b.image_max_edge, 10);
    if (!isFinite(e) || e < 200) return res.status(400).json({ code: 400, message: '长边上限至少 200' });
    patch.image_max_edge = String(Math.min(e, 4096));
  }
  if (b.image_quality !== undefined) {
    var q = parseInt(b.image_quality, 10);
    if (!isFinite(q) || q < 1) return res.status(400).json({ code: 400, message: '压缩质量必须在 1~100' });
    patch.image_quality = String(Math.min(q, 100));
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ code: 400, message: '没有要修改的配置' });
  }

  var stmt = db.prepare(
    'INSERT INTO cluss_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  var tx = db.transaction(function() {
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) stmt.run(keys[i], patch[keys[i]]);
  });
  tx();

  console.log('[Admin] 视觉配置更新 by %s: %j', req.user.user_id, patch);
  // 视觉转述配置随模型配置一起下发（§5.2：relayModelId 不随行节点会引用到不存在的模型）
  bumpModelAndQueue(req);
  var cfg = vision.getVisionConfig();
  res.json({
    code: 200,
    message: '已保存',
    data: {
      enabled: cfg.enabled,
      relay_model_id: cfg.relayModelId,
      max_images: cfg.maxImages,
      image_max_edge: cfg.imageMaxEdge,
      image_quality: cfg.imageQuality,
      shrink_enabled: cfg.shrinkEnabled
    }
  });
});

// 单图转述测试：验证转述链路是否通（排障用，学生看不到）
router.post('/vision/test', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var vision = require('../services/vision');
  var cfg = vision.getVisionConfig();

  if (!cfg.relayModelId) {
    return res.status(400).json({ code: 400, message: '尚未配置转述模型' });
  }
  var hash = String(req.body.hash || '').trim();
  if (!hash) return res.status(400).json({ code: 400, message: '请提供要测试的图片 hash' });

  var relay = require('../services/ai').resolveModel(cfg.relayModelId);
  if (!relay || !relay.ready) {
    return res.status(400).json({ code: 400, message: '转述模型不可用（未启用或缺 API Key）' });
  }

  var loaded = vision.loadImageItems(req.user.user_id, [hash], {});
  if (loaded.error) return res.status(400).json({ code: 400, message: loaded.error });

  var started = Date.now();
  vision.shrinkAll(loaded.items, null).then(function(items) {
    return vision.describeImages(relay, items, null);
  }).then(function(r) {
    res.json({
      code: 200,
      message: '转述完成',
      data: {
        ok: true,
        model: cfg.relayModelId,
        elapsed_ms: Date.now() - started,
        text: r.text,
        failed: r.failed.length
      }
    });
  }).catch(function(err) {
    res.status(500).json({ code: 500, message: '转述失败：' + (err.message || '未知错误') });
  });
});

// ============================================================
// 全站用量统计
// ============================================================
// ================= 联网搜索 =================
//
// 与 /vision 同一套形态：GET 读配置（Key 只回脱敏后的形状）、PUT 改配置、
// POST /test 用一句真实查询验证"到底能不能搜到"。
//
// 为什么要有 test：搜索这类外部依赖坏起来是**静默**的（Key 过期、额度用完、
// 域名被拦），不实测的话表现只是"AI 回答里没有来源"，老师根本无从判断。
router.get('/search', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var search = require('../services/websearch');
  res.json({ code: 200, message: 'ok', data: search.statusForAdmin() });
});

router.put('/search', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var search = require('../services/websearch');
  var b = req.body || {};
  var patch = {};

  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.provider !== undefined) patch.provider = b.provider;
  if (b.max_results !== undefined) patch.max_results = b.max_results;
  if (b.timeout_ms !== undefined) patch.timeout_ms = b.timeout_ms;
  if (b.depth !== undefined) patch.depth = b.depth;

  // Key 的三态语义（与模型配置一致）：
  //   不传        → 保持原 Key 不变（老师只勾了个开关，不该把 Key 清掉）
  //   传空字符串  → 明确清空（换服务商时要能删）
  //   传新值      → 覆盖
  if (b.clear_key === true) patch.api_key = '';
  else if (b.api_key !== undefined && String(b.api_key).trim() !== '') {
    patch.api_key = String(b.api_key).trim();
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ code: 400, message: '没有要修改的配置' });
  }

  try {
    search.saveSearchConfig(patch);
  } catch (e) {
    return res.status(e.status || 500).json({ code: e.status || 500, message: e.message });
  }

  // 刻意不动 bumpModelAndQueue：搜索配置是**节点本地**能力，
  // 与云端下发的模型/视觉配置无关，提交给中继只会让别的班跟着变。
  console.log('[Admin] 联网搜索配置更新 by %s: %j',
    req.user.user_id,
    { enabled: patch.enabled, provider: patch.provider, key_changed: patch.api_key !== undefined });

  res.json({ code: 200, message: '已保存', data: search.statusForAdmin() });
});

router.post('/search/test', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var search = require('../services/websearch');
  var q = String((req.body && req.body.query) || '').trim();
  var cfg = search.getSearchConfig();

  if (!cfg.enabled) return res.status(400).json({ code: 400, message: '联网搜索还没启用' });
  if (!cfg.apiKey) return res.status(400).json({ code: 400, message: '还没填 API Key' });
  if (!q) q = '今天的新闻';

  search.search(q).then(function(payload) {
    res.json({
      code: 200,
      message: payload.ok ? '搜索成功' : (payload.error || '搜索失败'),
      data: {
        ok: !!payload.ok,
        error: payload.error || '',
        provider: payload.provider,
        query: payload.query,
        // 多路检索是本轮加强的重点，管理台要能看出"这次到底搜了几组、上游给了多少条"
        queries: payload.queries || [payload.query],
        total_before_rank: payload.total_before_rank || (payload.results || []).length,
        took_ms: payload.took_ms || 0,
        cached: !!payload.cached,
        results: (payload.results || []).slice(0, 5)
      }
    });
  });
});

router.get('/usage/summary', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var stats = require('../services/usage-stats');
  var win = stats.resolveWindow(req.query);
  var groupBy = String(req.query.group_by || 'user');
  if (['user', 'model', 'day', 'source', 'instance'].indexOf(groupBy) < 0) groupBy = 'user';

  var data = stats.summary({
    userId: String(req.query.user_id || ''),
    classNo: String(req.query.class_no || ''),
    from: win.from,
    to: win.to,
    days: win.days,
    groupBy: groupBy
  });

  res.json({ code: 200, message: 'ok', data: data });
});

router.get('/usage/records', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var stats = require('../services/usage-stats');
  var win = stats.resolveWindow(req.query);

  var data = stats.records({
    userId: String(req.query.user_id || ''),
    from: win.from,
    to: win.to,
    modelId: String(req.query.model_id || ''),
    source: String(req.query.source || ''),
    page: req.query.page,
    limit: req.query.limit
  });

  data.window = { from: win.from, to: win.to, days: win.days };
  res.json({ code: 200, message: 'ok', data: data });
});

router.get('/usage/export.csv', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var stats = require('../services/usage-stats');
  var win = stats.resolveWindow(req.query);

  var data = stats.records({
    userId: String(req.query.user_id || ''),
    from: win.from,
    to: win.to,
    modelId: String(req.query.model_id || ''),
    source: String(req.query.source || ''),
    page: 1,
    limit: 200
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cluss-usage-all.csv"');
  res.send(stats.recordsToCsv(data.items));
});

// ============================================================
// AI 洞察（POST /admin/ai/insight）
//
// 管理台从来不缺数字，缺的是「这些数字说明什么、我该先做什么」。
// 这件事必须在服务端做：模型地址与 Key 只存在于下发配置里，前端拿不到。
//
// 复用 chatOnce（与「模型连通性测试」「记忆提取」同一条非流式通道），
// 不新造第二条调用路径。**刻意不写 cluss_usage_log**：这是运维侧自身的
// 调用，若记账就会被算进「学生用量」，污染管理员此刻正在看的那份统计
//（同理 /models/:id/test 也不记账）。
//
// 两种用法：
//   { question: '' }    基于全局快照出一份常规体检
//   { question: '...' } 在同一份数据底座上回答管理员的具体问题
// ============================================================

// 洞察这一步用哪个模型，可以由管理员显式指定（question 之外再带 model_id）。
//
// 为什么必须能选：同样的台账，便宜模型给出的是套话，强模型才看得出「哪个班的
// 消耗曲线是异常形状」。管理员需要「平时用便宜的、月底用强的」这种自由；
// 而默认行为保持不变 —— 不传 model_id 时仍然是「第一个可用的模型」，老前端不受影响。
//
// 指定了就**绝不回退**：静默换模型会让「我选的是 X」变成一句谎话，管理员对比
// 两次分析的结论时会把差异归因到模型上，实际却换了另一只。宁可 400 说清楚。
function pickInsightModel(preferredId) {
  var ai = require('../services/ai');
  var want = String(preferredId || '').trim();

  if (want) {
    var picked = ai.resolveModel(want);
    if (!picked) return { mc: null, error: '所选模型不存在或已停用，请在「模型与单价」里确认' };
    if (!picked.ready) return { mc: null, error: '所选模型还没配好地址与 Key，换一个模型或先去「模型与单价」补齐' };
    return { mc: picked, error: '' };
  }

  // 自动模式：管理台自己的分析不能因为「默认模型没配 Key」就整个不可用。
  // 逐个 enabled 模型试 resolveModel（ready = 地址与 Key 都配齐了），取第一个能用的。
  var rows = ai.getEnabledModels();
  for (var i = 0; i < rows.length; i++) {
    var mc = ai.resolveModel(rows[i].id);
    if (mc && mc.ready) return { mc: mc, error: '' };
  }
  return { mc: null, error: '' };
}

// 前端下拉要的清单：只列 enabled 的模型，ready 交给前端置灰（而不是隐藏）——
// 管理员需要看见「这个模型在这儿，但还不能用」，隐藏会让人以为模型丢了。
function insightModelOptions() {
  var ai = require('../services/ai');
  var rows = ai.getEnabledModels();
  var dft = ai.getDefaultModelId();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var mc = ai.resolveModel(rows[i].id);
    if (!mc) continue;
    out.push({
      id: String(mc.id),
      label: mc.label || String(mc.id),
      ready: !!mc.ready,
      is_default: String(mc.id) === String(dft)
    });
  }
  return out;
}

// 组装给模型看的数据底座。
// 口径全部复用既有来源：账号/账目与 /admin/dashboard 同一组子查询，
// 用量分组走 services/usage-stats，突增走 computeAnomalies —— 各写一份
// 迟早会出现「页面上是这个数、AI 说的是那个数」。
function buildInsightSnapshot() {
  var stats = require('../services/usage-stats');
  var win = stats.resolveWindow({ days: 7 });

  var totals = db.prepare([
    'SELECT',
    '  (SELECT COUNT(*) FROM users WHERE is_admin = 0) AS user_count,',
    '  (SELECT COUNT(*) FROM users WHERE IFNULL(is_admin, 0) = 1) AS admin_count,',
    '  (SELECT IFNULL(SUM(allocated_micro), 0) FROM cluss_credit) AS allocated_micro,',
    '  (SELECT IFNULL(SUM(cost_micro), 0) FROM cluss_usage_log) AS used_micro,',
    '  (SELECT COUNT(*) FROM cluss_usage_log) AS calls'
  ].join('\n')).get();

  // 本月窗口按服务器本地日历月对齐（与「本月消耗」「峰谷」同一面钟），再转 UTC 查台账
  var nowLocal = new Date();
  var monthStartUtc = time.fmtUtc(new Date(nowLocal.getFullYear(), nowLocal.getMonth(), 1));
  var monthRow = db.prepare(
    'SELECT IFNULL(SUM(cost_micro), 0) AS cost_micro, COUNT(*) AS calls' +
    ' FROM cluss_usage_log WHERE created_at >= ?'
  ).get(monthStartUtc);
  var budgetYuan = Number(initDb.getMeta('budget_threshold_yuan', '0')) || 0;
  var monthCostYuan = config.microToYuan(monthRow.cost_micro);

  var byClass = db.prepare([
    'SELECT IFNULL(NULLIF(u.class_no, \'\'), \'--\') AS class_no,',
    '       COUNT(DISTINCT u.user_id) AS students,',
    '       IFNULL(SUM(c.allocated_micro), 0) AS allocated_micro',
    'FROM users u',
    'LEFT JOIN cluss_credit c ON c.user_id = u.user_id',
    'GROUP BY class_no',
    'ORDER BY class_no ASC'
  ].join('\n')).all();

  var byModel = stats.summary({ from: win.from, to: win.to, days: win.days, groupBy: 'model' });
  var bySource = stats.summary({ from: win.from, to: win.to, days: win.days, groupBy: 'source' });
  var byDay = stats.summary({ from: win.from, to: win.to, days: win.days, groupBy: 'day' });
  var byUser = stats.summary({ from: win.from, to: win.to, days: win.days, groupBy: 'user' });
  var anomalies = computeAnomalies();

  var pricing = require('../services/pricing');
  var oc = pricing.getOffpeakConfig();

  var allocatedYuan = config.microToYuan(totals.allocated_micro);
  var usedYuan = config.microToYuan(totals.used_micro);
  var remainYuan = Math.max(0, allocatedYuan - usedYuan);
  var usedPct = allocatedYuan > 0 ? Math.round(usedYuan / allocatedYuan * 1000) / 10 : 0;

  // 「额度花得值不值」的核心指标：有实际调用的学生数（不含管理员，管理员的用量是运维成本）
  var activeStudents = byUser.items.filter(function(it) { return !it.is_admin; }).length;

  // 模型与单价配置：管理员问「单价合不合理 / 该不该换模型」时要有依据。
  // 与「模型与单价」页同一口径：price_in/price_out 是"每千 token 的微元数"，
  // 这里换算成更好读的"元 / 百万 token"（×1000/1e6 = ÷1000）。
  // 最多列 12 个，避免模型多时把快照撑成一张大表。
  var aiSvc = require('../services/ai');
  var defaultModelId = aiSvc.getDefaultModelId();
  var enableRows = aiSvc.getEnabledModels();
  var modelFacts = [];
  for (var mi = 0; mi < enableRows.length && mi < 12; mi++) {
    var mm = aiSvc.resolveModel(enableRows[mi].id);
    if (!mm) continue;
    modelFacts.push({
      id: String(enableRows[mi].id),
      label: mm.label || String(enableRows[mi].id),
      in_yuan_per_m: Number((Number(mm.price_in || 0) / 1000).toFixed(4)),
      out_yuan_per_m: Number((Number(mm.price_out || 0) / 1000).toFixed(4)),
      multiplier: Math.round(Number(mm.price_multiplier_bp || 10000)) / 10000,
      ready: !!mm.ready,
      is_default: String(enableRows[mi].id) === String(defaultModelId)
    });
  }

  var L = [];
  L.push('【统计窗口】近 ' + win.days + ' 天（自 ' + String(win.from).slice(0, 10) + '）；本月自 ' + monthStartUtc.slice(0, 10));
  L.push('【账号规模】学生 ' + totals.user_count + ' 人（近 7 天有调用 ' + activeStudents + ' 人），管理员 ' + totals.admin_count + ' 人');
  L.push('【额度总盘】已分配 ¥' + allocatedYuan.toFixed(2) + '，已消耗 ¥' + usedYuan.toFixed(2) +
    '，剩余 ¥' + remainYuan.toFixed(2) + '（消耗率 ' + usedPct + '%）');
  L.push('【本月（自然月）】消耗 ¥' + monthCostYuan.toFixed(2) + '，调用 ' + monthRow.calls + ' 次；' +
    (budgetYuan > 0
      ? ('预算阈值 ¥' + budgetYuan.toFixed(2) + '，' + (monthCostYuan >= budgetYuan ? '**已超预算**' : '尚未触达'))
      : '未设置预算阈值'));
  L.push('【峰谷计价】' + (oc.enabled
    ? ('启用中，谷时 ' + (Math.round(oc.discountBp / 100) / 10) + ' 折，当前' +
       (pricing.isInOffpeakWindow(oc) ? '处于谷时' : '处于峰时'))
    : '未启用（全天原价）'));
  L.push('【模型与单价】' + (modelFacts.length
    ? ('共 ' + enableRows.length + ' 个启用模型' +
       (enableRows.length > modelFacts.length ? '（下列前 ' + modelFacts.length + ' 个）' : '') + '；' +
       modelFacts.map(function(m) {
         return m.label + '：输入 ¥' + m.in_yuan_per_m + '/百万token、输出 ¥' + m.out_yuan_per_m + '/百万token' +
           (m.multiplier !== 1 ? '、倍率 ×' + m.multiplier : '') +
           (m.is_default ? '、默认' : '') + (m.ready ? '' : '、未配 Key');
       }).join('；'))
    : '无启用模型 —— 学生当前无法提问'));
  L.push('【班级分布】' + (byClass.length
    ? byClass.map(function(r) {
        return r.class_no + '班 ' + r.students + ' 人 / 已分配 ¥' + config.microToYuan(r.allocated_micro).toFixed(2);
      }).join('；')
    : '无'));
  L.push('【近 7 天 · 按模型】' + (byModel.items.length
    ? byModel.items.map(function(it) {
        return (it.label || it.key) + ' ' + it.calls + ' 次 / ¥' + it.cost_yuan + ' / ' + it.total_tokens + ' token';
      }).join('；')
    : '无调用'));
  L.push('【近 7 天 · 按调用类型】' + (bySource.items.length
    ? bySource.items.map(function(it) {
        return stats.sourceLabel(it.key) + ' ' + it.calls + ' 次 / ¥' + it.cost_yuan;
      }).join('；')
    : '无调用'));
  L.push('【近 7 天 · 按天】' + (byDay.items.length
    ? byDay.items.map(function(it) { return it.key + ' ¥' + it.cost_yuan + '(' + it.calls + '次)'; }).join('；')
    : '无调用'));
  L.push('【近 7 天 · 消耗 Top】' + (anomalies.top7d.length
    ? anomalies.top7d.map(function(r) {
        return r.name + (r.class_no ? '(' + r.class_no + '班)' : '') + (r.is_admin ? '[管理]' : '') +
          ' ¥' + r.cost_yuan + ' / ' + r.calls + ' 次';
      }).join('；')
    : '无记录'));
  L.push('【异常突增（最近 24 小时）】' + (anomalies.spikes.length
    ? anomalies.spikes.map(function(r) {
        return r.name + ' ¥' + r.day_yuan + '（前 7 天日均 ¥' + r.avg_yuan + '，' + r.ratio + ' 倍）';
      }).join('；')
    : '无（这是好事）'));

  return {
    text: L.join('\n'),
    facts: {
      window_days: win.days,
      students: totals.user_count,
      active_students_7d: activeStudents,
      admins: totals.admin_count,
      allocated_yuan: allocatedYuan.toFixed(2),
      used_yuan: usedYuan.toFixed(2),
      remaining_yuan: remainYuan.toFixed(2),
      used_pct: usedPct,
      models: modelFacts,
      month: {
        cost_yuan: monthCostYuan.toFixed(2),
        calls: monthRow.calls,
        threshold_yuan: budgetYuan,
        exceeded: budgetYuan > 0 && monthCostYuan >= budgetYuan
      },
      spike_count: anomalies.spikes.length
    }
  };
}

var INSIGHT_SYSTEM = [
  '你是「Cluss」学习平台的管理运营分析助手，服务对象是管理台的管理员（班管 / 校管）。',
  '你的任务是把系统数据翻译成他能立刻行动的判断与建议。',
  '',
  '规则：',
  '1. 只依据用户消息里给出的【数据快照】作答。快照里没有的数字、趋势、原因，一个字都不要编；',
  '   需要快照之外的信息才能判断时，明确说「需要再导出 X」，不要猜。',
  '2. 金额一律说「元」，用量说「次」，不要复述快照里的原始表格。',
  '3. 结论先行：先给 3~5 条最重要的判断，再逐条展开。不要写「总体来看」这类空开头。',
  '4. 每条建议都要具体、可执行、可验证，写清「做什么 → 预期看到什么 → 怎么确认」。',
  '   反例（不要写）：「加强成本管理」「注意用量异常」。',
  '5. 快照里出现「已超预算」「异常突增」这类风险项时必须单独点出，并给出处置动作。',
  '6. 管理员问的是一个具体问题时，直接回答它，不要扩写成全面体检。',
  '7. 用中文，语气像给同事的一份运维简报：平实、直接，不客套、不堆形容词、不用 emoji。',
  '8. 篇幅控制在 600 字以内；确有必要可适当超出，但不要为凑长度重复。',
  '9. 快照里的【模型与单价】【峰谷计价】【本月预算】是管理台当前的配置项。',
  '   管理员问「怎么省」「单价合不合理」「该不该换模型」时，直接对着这些配置给建议：',
  '   说清改哪一项、改成什么、预计省多少；不要只说「优化模型选择」这类空话。'
].join('\n');

// 下拉清单。放在 POST 之前，前端切到「AI 洞察」时先拉一次（零模型调用，只是读配置）。
router.get('/ai/insight/models', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var auto = pickInsightModel();
  res.json({
    code: 200,
    message: 'ok',
    data: {
      models: insightModelOptions(),
      // 「自动」这一项到底会落到哪只模型，必须让管理员看得见：
      // 否则「自动」是个黑盒，出了问题也无从判断是不是选错模型导致的。
      auto_id: auto.mc ? String(auto.mc.id) : '',
      auto_label: auto.mc ? (auto.mc.label || String(auto.mc.id)) : ''
    }
  });
});

router.post('/ai/insight', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var question = String((req.body && req.body.question) || '').trim().slice(0, 500);
  var wantedModelId = String((req.body && req.body.model_id) || '').trim();

  var picked = pickInsightModel(wantedModelId);
  var mc = picked.mc;
  if (!mc) {
    return res.status(400).json({
      code: 400,
      message: picked.error || '当前没有可用的模型 —— 需要先在「模型与单价」里给至少一个模型配好地址与 Key'
    });
  }

  var snapshot = buildInsightSnapshot();
  var userText = '【数据快照】\n' + snapshot.text + '\n\n' +
    (question
      ? ('【管理员的问题】\n' + question)
      : '【任务】\n请基于以上快照给出一份常规体检：最需要注意的几点 + 具体、可执行的运维建议。');

  var started = Date.now();
  var ai = require('../services/ai');
  // 超时给到 90s：这段分析读的是整份快照，比一轮普通对话长；
  // 客户端调用侧也要相应放宽 axios 的 30s 默认超时，否则会先被前端掐断。
  ai.chatOnce(mc, [
    { role: 'system', content: INSIGHT_SYSTEM },
    { role: 'user', content: userText }
  ], { temperature: 0.3, timeout: 90000, maxTokens: 1400 }).then(function(data) {
    var text = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    var answer = String(text || '').trim();
    if (!answer) {
      return res.json({
        code: 200,
        message: '模型没有返回内容',
        data: { ok: false, error: '模型没有返回内容，请重试' }
      });
    }
    console.log('[Admin] AI 洞察生成完成（模型 %s，%dms）by %s', mc.id, Date.now() - started, req.user.user_id);
    res.json({
      code: 200,
      message: 'ok',
      data: {
        ok: true,
        answer: answer,
        model: mc.label || mc.id,
        model_id: String(mc.id),
        elapsed_ms: Date.now() - started,
        context: snapshot.facts
      }
    });
  }).catch(function(err) {
    console.warn('[Admin] AI 洞察生成失败：%s', err.message);
    // 与 /models/:id/test 同风格：HTTP 200 + ok:false，前端只读 data.error，
    // 不让拦截器把它渲染成一句泛化的「服务器暂时不可用」
    res.json({
      code: 200,
      message: 'AI 洞察生成失败',
      data: { ok: false, error: err.message || '生成失败，请稍后重试' }
    });
  });
});

// ============================================================
// 本班名册（ClassIntra 联动）
//
// Cluss 是「一班一节点」的应用：名册就是世界边界。
//   GET  /class-roster          现状（本班在册 / 非本班清单），零副作用
//   POST /class-roster/sync     拉名册并纳入本班 —— **幂等，只增不删**
//   POST /class-roster/prune    清理非本班账号 —— **破坏性**，必须显式 confirm
//
// 「本班」由**当前管理员的学号**解出（YYCCNN），不由前端传参决定：
// 班管只可能管自己那个班，参数传什么都不可能越到别的班。
// ============================================================
function adminClass(req) {
  return classRoster.classOfAdmin(String(req.user.user_id));
}

router.get('/class-roster', auth.requireAuth, auth.requireAdmin, function(req, res) {
  try {
    var c = adminClass(req);
    if (!c) {
      return res.json({ code: 400, message: '当前账号的学号不含班级信息（如开发账号），无法确定本班', data: null });
    }
    return res.json({ code: 200, message: 'ok', data: classRoster.status(c.yy, c.classNo) });
  } catch (err) {
    console.error('[Admin] class-roster status error:', err);
    return res.json({ code: 500, message: '服务器内部错误', data: null });
  }
});

router.post('/class-roster/sync', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var c = adminClass(req);
  if (!c) {
    return res.json({ code: 400, message: '当前账号的学号不含班级信息，无法确定本班', data: null });
  }
  classRoster.syncClass(c.yy, c.classNo, { prune: false }).then(function(r) {
    console.log('[Admin] 名册同步: %s届%s班 新增 %d / 更新 %d / 失败 %d / 操作人 %s',
      c.yy, c.classNo, r.adopted.added, r.adopted.updated, r.adopted.failed.length, req.user.user_id);
    return res.json({ code: 200, message: '本班名册已同步', data: r });
  }).catch(function(err) {
    var st = err.response && err.response.status;
    var msg = (err.response && err.response.data && err.response.data.message) || err.message;
    if (st === 503 || st === 403 || /未配置|联动/.test(err.message)) {
      return res.json({ code: 503, message: 'ClassIntra 联动不可用：' + msg, data: null });
    }
    console.error('[Admin] 名册同步失败:', err.message);
    return res.json({ code: 500, message: '同步失败：' + msg, data: null });
  });
});

router.post('/class-roster/prune', auth.requireAuth, auth.requireAdmin, function(req, res) {
  if (req.body.confirm !== true) {
    return res.json({ code: 400, message: '缺少确认标记：清理会连同学生的会话、额度与流水一并删除，必须显式 confirm', data: null });
  }
  var c = adminClass(req);
  if (!c) {
    return res.json({ code: 400, message: '当前账号的学号不含班级信息，无法确定本班', data: null });
  }

  try {
    var doomed = classRoster.listForeign(c.yy, c.classNo);
    if (!doomed.length) {
      return res.json({ code: 200, message: '没有需要清理的非本班账号', data: { removed: { count: 0 }, list: [] } });
    }
    // 开发账号（999999 等）在 listForeign 里就被豁免了，这里再钉一道保险：
    // 删除名单里出现豁免 id 视为编程错误，直接拒绝而不是默默跳过
    var dev = String(config.admin.userId || '999999');
    if (doomed.some(function(r) { return String(r.user_id) === dev; })) {
      return res.json({ code: 500, message: '清理名单里包含受保护的账号，已中止', data: null });
    }

    var removed = classRoster.purgeUsers(doomed.map(function(r) { return r.user_id; }));
    console.log('[Admin] 清理非本班账号: %s届%s班，删除 %d 个（云盘文件 %d 份），操作人 %s',
      c.yy, c.classNo, removed.count, removed.files, req.user.user_id);

    return res.json({
      code: 200,
      message: '已清理 ' + removed.count + ' 个非本班账号',
      data: {
        removed: removed,
        list: doomed.map(function(r) {
          return { user_id: r.user_id, net_name: r.net_name, real_name: r.real_name };
        })
      }
    });
  } catch (err) {
    console.error('[Admin] 清理非本班账号失败:', err);
    return res.json({ code: 500, message: '清理失败：' + err.message, data: null });
  }
});

module.exports = router;
module.exports.bumpAssignVersion = bumpAssignVersion;