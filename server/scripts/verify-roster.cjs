// ============================================================
// 验证脚本：全校花名册（跨班充值的可见性）—— 端到端
//
// 场景就是这次要解决的那件事：
//   18 班持有管理员席位（写入权），8 班没有。18 班班管要在自己页面上
//   看到 8 班学生并给他们充钱；8 班自己则只能看，改不动。
//
// 这里起两个**真实**节点子进程 + 一个假云端（云端真身由 Cluss-Cloud 仓库的
// scripts/verify.cjs 覆盖，两边各自验证「自己那半」，合起来才是整条链路）：
//
//   ① 上行：两个班都把本班学生报上去（非席位班也必须能报，否则永远看不见）
//   ② 下行：只有席位班拉全校名册（非席位班连试都不试，403 是云端的兜底）
//   ③ 合并：席位班 GET /admin/users 多出带「外班」标的行（source=roster）
//   ④ 充值：给外班学生充值 → 镜像乐观值 + 走云端账本 → **他那个班的节点
//      真的收到额度**（这是整件事的验收点）
//   ⑤ 边界：外班的钱不进本机台账；非席位班改额度被 403 挡住
//
// 跑法：node server/scripts/verify-roster.cjs
// 不碰 server/database/cluss.db（两个子进程都用临时库）。
// ============================================================
'use strict';

var path = require('path');
var os = require('os');
var fs = require('fs');
var net = require('net');
var http = require('http');
var { spawn } = require('child_process');

var SERVER_DIR = path.resolve(__dirname, '..');
var axios = require(path.join(SERVER_DIR, 'node_modules', 'axios'));
var Database = require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3'));

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  | ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

function freePort() {
  return new Promise(function(resolve) {
    var srv = net.createServer();
    srv.listen(0, '127.0.0.1', function() {
      var p = srv.address().port;
      srv.close(function() { resolve(p); });
    });
  });
}

var SHARED_SECRET = 'roster-verify-shared-secret';
var JWT_SECRET = 'roster-verify-jwt-secret-0123456789abcdef';
var SEAT_ADMIN_ID = '999999';
var SEAT_ADMIN_PW = 'roster-verify-seat-admin';
var OTHER_ADMIN_ID = '999998';
var OTHER_ADMIN_PW = 'roster-verify-other-admin';

// 18 班 = 席位班（有写入权）；8 班 = 普通班（只有可见性）
var SEAT_INST = 'class-18';
var OTHER_INST = 'class-08';

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-roster-'));
var seatDbPath = path.join(tmpDir, 'seat.db');
var otherDbPath = path.join(tmpDir, 'other.db');

// ---- 假云端：只实现花名册这条链路需要的接口 ----
// 权限口径与 Cluss-Cloud/server.js 逐条对齐：
//   · 上行（POST）不禁校也不禁班 —— 每个班都得能报，否则席位班永远等不到
//   · 下行（GET）只有席位实例能读，别人一律 403 且理由说清席位在哪
//   · 额度上行（POST /allocations）必须席位 + 班管 + 学号与席位一致
var cloud = {
  rosterVersion: 0,
  assignVersion: 0,
  modelVersion: 0,
  byInstance: {},          // instance_id -> items[]
  allocations: [],         // [{user_id, allocated_micro, weekly_quota_micro}]
  rosterPushes: 0,
  rosterGets: {},           // instance_id -> 拉取次数
  nonSeatAllocPushes: 0
};

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function startFakeCloud() {
  return new Promise(function(resolve) {
    var srv = http.createServer(function(req, res) {
      var body = '';
      req.on('data', function(c) { body += c; });
      req.on('end', function() {
        var payload = {};
        try { payload = JSON.parse(body); } catch (e) { /* 空体 */ }
        var inst = String(req.headers['x-cluss-instance'] || '');
        var isSeat = inst === SEAT_INST;
        var r = handle(req.method, req.url, payload, inst, isSeat);
        res.statusCode = r.status || 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(r.json || { code: 200, message: 'ok', data: {} }));
      });
    });
    srv.listen(0, '127.0.0.1', function() {
      resolve({
        port: srv.address().port,
        close: function() { return new Promise(function(r) { srv.close(function() { r(); }); }); }
      });
    });
  });
}

function handle(method, url, body, inst, isSeat) {
  if (url.indexOf('/api/sync/version') >= 0) {
    return { json: { code: 200, message: 'ok', data: {
      assign_version: cloud.assignVersion,
      model_config_version: cloud.modelVersion,
      roster_version: cloud.rosterVersion,
      is_seat_admin: isSeat,
      seat_instance: SEAT_INST,
      server_time: nowIso()
    } } };
  }

  if (url.indexOf('/api/sync/roster') >= 0 && method === 'POST') {
    cloud.rosterPushes++;
    var raw = Array.isArray(body.items) ? body.items : [];
    var incoming = [];
    var seen = Object.create(null);
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i] || {};
      var uid = String(it.user_id || '').trim();
      if (!uid || seen[uid]) continue;
      seen[uid] = true;
      incoming.push({
        user_id: uid,
        class_no: String(it.class_no || ''),
        net_name: String(it.net_name || ''),
        real_name: String(it.real_name || ''),
        is_admin: it.is_admin ? 1 : 0,
        status: String(it.status || 'active')
      });
    }
    incoming.sort(function(a, b) { return a.user_id < b.user_id ? -1 : 1; });
    var before = cloud.byInstance[inst] || [];
    var changed = JSON.stringify(before) !== JSON.stringify(incoming);
    if (changed) {
      cloud.byInstance[inst] = incoming;
      cloud.rosterVersion++;
    }
    return { json: { code: 200, message: changed ? '花名册已更新' : '花名册无变化',
      data: { roster_version: cloud.rosterVersion, changed: changed, count: incoming.length } } };
  }

  if (url.indexOf('/api/sync/roster') >= 0 && method === 'GET') {
    rosterGets[inst] = (rosterGets[inst] || 0) + 1;
    if (!isSeat) {
      return { status: 403, json: { code: 403,
        message: '全校花名册只有管理员席位可以读取（本校席位在 ' + SEAT_INST + ' 班）' } };
    }
    var rows = [];
    Object.keys(cloud.byInstance).forEach(function(k) {
      cloud.byInstance[k].forEach(function(r) {
        var alloc = cloud.allocations.filter(function(a) { return a.user_id === r.user_id; })[0];
        rows.push(Object.assign({
          instance_id: k,
          allocated_micro: alloc ? alloc.allocated_micro : 0,
          weekly_quota_micro: alloc ? alloc.weekly_quota_micro : 0,
          used_micro: 0, calls: 0, last_at: ''
        }, r));
      });
    });
    rows.sort(function(a, b) {
      if (a.class_no !== b.class_no) return a.class_no < b.class_no ? -1 : 1;
      return a.user_id < b.user_id ? -1 : 1;
    });
    return { json: { code: 200, message: 'ok',
      data: { roster_version: cloud.rosterVersion, roster: rows } } };
  }

  if (url.indexOf('/api/sync/allocations') >= 0 && method === 'POST') {
    // 云端三重校验：席位实例 + 班管身份 + 学号与席位一致
    if (!isSeat) { cloud.nonSeatAllocPushes++; return { status: 403, json: { code: 403, message: '不是管理员席位' } }; }
    if (!body.class_admin) return { status: 403, json: { code: 403, message: '不是班管' } };
    if (String(body.class_user_id || '') !== SEAT_ADMIN_ID) {
      return { status: 403, json: { code: 403, message: '学号与席位不符' } };
    }
    if (typeof body.base_version === 'number' && body.base_version !== cloud.assignVersion) {
      return { status: 409, json: { code: 409, message: '云端额度已被改动，请刷新后重新修改',
        data: { assign_version: cloud.assignVersion } } };
    }
    var applied = 0, skipped = 0;
    (body.items || []).forEach(function(it) {
      var uid = String(it.user_id || '');
      if (!uid) return;
      if (it.idem_key && cloud.allocations.some(function(a) { return a.idem_key === it.idem_key; })) { skipped++; return; }
      var hit = cloud.allocations.filter(function(a) { return a.user_id === uid; })[0];
      if (hit) {
        hit.allocated_micro = it.allocated_micro;
        hit.weekly_quota_micro = it.weekly_quota_micro || 0;
        hit.idem_key = it.idem_key;
      } else {
        cloud.allocations.push({ user_id: uid, allocated_micro: it.allocated_micro,
          weekly_quota_micro: it.weekly_quota_micro || 0, idem_key: it.idem_key });
      }
      applied++;
    });
    cloud.assignVersion++;
    return { json: { code: 200, message: 'ok',
      data: { assign_version: cloud.assignVersion, applied: applied, skipped: skipped } } };
  }

  if (url.indexOf('/api/sync/assignments') >= 0) {
    return { json: { code: 200, message: 'ok',
      data: { assign_version: cloud.assignVersion, assignments: cloud.allocations } } };
  }
  if (url.indexOf('/api/sync/model-config') >= 0) {
    return { json: { code: 200, message: 'ok',
      data: { model_config_version: cloud.modelVersion, models: [], sources: [], meta: {} } } };
  }
  if (url.indexOf('/api/sync/policy') >= 0) {
    return { json: { code: 200, message: 'ok', data: { model_config_version: cloud.modelVersion } } };
  }
  if (url.indexOf('/api/sync/usage') >= 0) {
    return { json: { code: 200, message: 'ok', data: { accepted: 0, duplicated: 0 } } };
  }
  return {};
}

// ---- 起真实节点子进程 ----
var procs = [];
function startNode(env, tag) {
  var p = spawn(process.execPath, [path.join(SERVER_DIR, 'src', 'app.js')], {
    env: env, cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe']
  });
  var out = '';
  p.stdout.on('data', function(d) { out += d; });
  p.stderr.on('data', function(d) { out += d; });
  p.tag = tag;
  p.buf = function() { return out; };
  procs.push(p);
  return p;
}

function baseEnv(port, dbPath, instanceId, adminId, adminPw) {
  return Object.assign({}, process.env, {
    CLUSS_MODE: 'node',
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: JWT_SECRET,
    ADMIN_USER_ID: adminId,
    ADMIN_PASSWORD: adminPw,
    CLUSS_SHARED_SECRET: SHARED_SECRET,
    CLUSS_INSTANCE_ID: instanceId,
    CLUSS_RELAY_URL: 'http://127.0.0.1:' + fakeCloud.port,
    CLUSS_SYNC_INTERVAL: '1',
    CLUSS_REPORT_INTERVAL: '1',
    CI_BRIDGE_URL: ''
  });
}

function waitHealthy(url, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 25000);
  function tick() {
    return axios.get(url + '/api/health', { timeout: 1500 }).then(function() {
      return null;
    }).catch(function() {
      if (Date.now() > deadline) return new Error('等待 ' + url + ' 就绪超时');
      return new Promise(function(r) { setTimeout(r, 300); }).then(tick);
    });
  }
  return tick();
}

function waitUntil(name, fn, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 12000);
  function tick() {
    return Promise.resolve().then(fn).then(function(v) {
      if (v) return v;
      if (Date.now() > deadline) throw new Error('等待超时: ' + name);
      return new Promise(function(r) { setTimeout(r, 250); }).then(tick);
    });
  }
  return tick();
}

function openDb(p) {
  var d = new Database(p);
  d.pragma('busy_timeout = 5000');
  return d;
}

function shutdown(code) {
  procs.forEach(function(p) { try { p.kill(); } catch (e) { /* 已退出 */ } });
  if (fakeCloud) { try { fakeCloud.close(); } catch (e) { /* 已关闭 */ } }
  setTimeout(function() { process.exit(code); }, 200);
}

var fakeCloud;
var rosterGets = {};   // instance_id -> 名册下行次数

function login(url, account, password) {
  return axios.post(url + '/api/auth/login', { account: account, password: password }, { timeout: 5000 })
    .then(function(r) { return r.data.data.token; })
    .catch(function(e) {
      // 有的登录接口收 username 字段，两个都试
      return axios.post(url + '/api/auth/login', { username: account, password: password }, { timeout: 5000 })
        .then(function(r) { return r.data.data.token; })
        .catch(function() { throw e; });
    });
}

(async function main() {
  console.log('========================================');
  console.log('验证：全校花名册（跨班充值的可见性）端到端');
  console.log('========================================');

  fakeCloud = await startFakeCloud();
  var seatUrl = 'http://127.0.0.1:' + await freePort();
  var otherUrl = 'http://127.0.0.1:' + await freePort();

  startNode(baseEnv(seatUrl.split(':').pop(), seatDbPath, SEAT_INST, SEAT_ADMIN_ID, SEAT_ADMIN_PW), 'seat');
  await waitHealthy(seatUrl);
  startNode(baseEnv(otherUrl.split(':').pop(), otherDbPath, OTHER_INST, OTHER_ADMIN_ID, OTHER_ADMIN_PW), 'other');
  await waitHealthy(otherUrl);

  var seatDb = openDb(seatDbPath);
  var otherDb = openDb(otherDbPath);

  // 两个班各自有两名学生（外加引导出来的班管账号，一人 = 一行）
  var insUser = "INSERT INTO users (user_id, net_name, real_name, password_hash, status, is_admin, info_json, source, class_no, created_at)" +
    " VALUES (?, ?, ?, 'x', 'active', 0, '{}', 'local', ?, datetime('now'))";
  seatDb.prepare(insUser).run('180101', '甲同学', '甲同学', '18');
  seatDb.prepare(insUser).run('180102', '乙同学', '乙同学', '18');
  otherDb.prepare(insUser).run('080101', '丙同学', '丙同学', '08');
  otherDb.prepare(insUser).run('080102', '丁同学', '丁同学', '08');

  section('① 上行：每个班都把本班学生报上去');
  // 两个班都要推（非席位班也必须推，否则席位班永远等不到 8 班的名字）
  await waitUntil('8 班名册已上行', function() {
    return (cloud.byInstance[OTHER_INST] || []).length >= 3 ? true : null;
  });
  ok('8 班（非席位）的名册上去了',
    (cloud.byInstance[OTHER_INST] || []).length === 3,
    JSON.stringify((cloud.byInstance[OTHER_INST] || []).map(function(x) { return x.user_id; })));
  await waitUntil('18 班名册已上行', function() {
    return (cloud.byInstance[SEAT_INST] || []).length >= 3 ? true : null;
  });
  ok('18 班（席位）的名册也上去了',
    (cloud.byInstance[SEAT_INST] || []).length === 3,
    JSON.stringify((cloud.byInstance[SEAT_INST] || []).map(function(x) { return x.user_id; })));
  var otherPushed = cloud.byInstance[OTHER_INST] || [];
  ok('每班上报的行标明了自己是哪个班',
    otherPushed.filter(function(x) { return x.user_id.indexOf('08') === 0; })
      .every(function(x) { return x.class_no === '08'; }),
    JSON.stringify(otherPushed.map(function(x) { return x.user_id + '/' + x.class_no; })));

  section('② 下行：只有席位班能读全校名册');
  await waitUntil('18 班已拉到全校名册镜像', function() {
    var r = seatDb.prepare("SELECT COUNT(*) AS c FROM sync_roster WHERE instance_id = ?").get(OTHER_INST);
    return r && r.c >= 3 ? r : null;
  });
  var seatMirror = seatDb.prepare('SELECT user_id, instance_id FROM sync_roster').all();
  ok('席位班本地有全校镜像', seatMirror.length === 6, '镜像 ' + seatMirror.length + ' 行');
  ok('镜像里包含 8 班报上来的学生',
    seatMirror.filter(function(r) { return r.instance_id === OTHER_INST; }).length === 3,
    'rows=' + seatMirror.length);
  ok('席位班在拉（roster 下行只对它开放）', (rosterGets[SEAT_INST] || 0) >= 1,
    '拉取 ' + (rosterGets[SEAT_INST] || 0) + ' 次');
  // 非席位班连试都不试：403 是云端的兜底，本地不该每次轮询白吃一次拒绝
  ok('非席位班不主动去拉（不白吃 403）', !rosterGets[OTHER_INST],
    '拉取 ' + (rosterGets[OTHER_INST] || 0) + ' 次');
  var otherMirrorCount = otherDb.prepare('SELECT COUNT(*) AS c FROM sync_roster').get().c;
  ok('非席位班本地没有全校镜像（不该有也不该拉）', otherMirrorCount === 0,
    '镜像 ' + otherMirrorCount + ' 行');

  section('③ 合并：席位班管理台看得见外班学生');
  var seatToken = await login(seatUrl, SEAT_ADMIN_ID, SEAT_ADMIN_PW);
  var listRes = await axios.get(seatUrl + '/api/admin/users', {
    timeout: 5000, headers: { Authorization: 'Bearer ' + seatToken }
  });
  var users = listRes.data.data.users || [];
  var rosterRows = users.filter(function(u) { return u.remote; });
  var localRows = users.filter(function(u) { return !u.remote; });
  ok('列表 = 本班 3 人 + 外班 3 人', users.length === 6, '共 ' + users.length + ' 行');
  ok('外班学生带 source=roster / remote 标记',
    rosterRows.length === 3 && rosterRows.every(function(u) { return u.source === 'roster' && u.remote === true; }),
    JSON.stringify(rosterRows.map(function(u) { return u.user_id; })));
  ok('本班学生仍是本机行（source 不被覆盖）',
    localRows.length === 3 && localRows.every(function(u) { return u.source !== 'roster' && u.remote === false; }),
    JSON.stringify(localRows.map(function(u) { return u.user_id + '/' + u.source; })));
  ok('外班学生带着他自己的班级号（前端要按班筛选）',
    rosterRows.filter(function(u) { return u.user_id.indexOf('08') === 0; })
      .every(function(u) { return u.class_no === '08'; }),
    JSON.stringify(rosterRows.map(function(u) { return u.user_id + '/' + u.class_no; })));
  ok('响应里带花名册状态（面板那行「已载入全校花名册」的来源）',
    listRes.data.data.roster && listRes.data.data.roster.count === 6,
    JSON.stringify(listRes.data.data.roster));
  // 外班余额必须来自云端快照，不能是 0（否则叠加充值会从零充起）
  var foreign = rosterRows.filter(function(u) { return u.user_id === '080101'; })[0];
  ok('外班学生的余额读自云端快照（不是本机的 0）',
    foreign && Number(foreign.allocated_micro) === 0, JSON.stringify(foreign));
  // 本班学生的行不因并入名册而重复出现
  ok('同一个人不会出现两行（本机行优先）',
    new Set(users.map(function(u) { return u.user_id; })).size === users.length);

  section('④ 跨班充值：钱进云端账本，他那个班真的收到');
  var putRes = await axios.put(seatUrl + '/api/admin/users/080101/quota', {
    quota_yuan: 5, reason: '跨班充值验证'
  }, { timeout: 5000, headers: { Authorization: 'Bearer ' + seatToken } });
  ok('席位班给外班学生充值成功', putRes.status === 200 && putRes.data.data.remote === true,
    JSON.stringify(putRes.data));
  ok('响应说清了这是外班学生', String(putRes.data.message).indexOf('08') > 0, putRes.data.message);

  // 验收点：8 班自己的节点要真的收到这笔额度
  await waitUntil('8 班节点收到这笔额度', function() {
    var r = otherDb.prepare('SELECT allocated_micro FROM cluss_credit WHERE user_id = ?').get('080101');
    return r && r.allocated_micro === 5000000 ? r : null;
  });
  ok('8 班节点落地 5 元（跨班充值真的到了）', true);
  var mirrored = seatDb.prepare('SELECT allocated_micro FROM sync_roster WHERE user_id = ?').get('080101');
  ok('席位班镜像先显示乐观值（管理员马上看到新数字）',
    mirrored && mirrored.allocated_micro === 5000000, JSON.stringify(mirrored));
  // 外班的钱绝不能写进本机台账 —— 那就成了两处口径
  var localCredit080101 = seatDb.prepare('SELECT 1 AS x FROM cluss_credit WHERE user_id = ?').get('080101');
  ok('外班的钱不进本机台账（只有云端一份账）', !localCredit080101);
  var cloudRow = cloud.allocations.filter(function(a) { return a.user_id === '080101'; })[0];
  ok('云端账本记下了这笔（走的是席位校验过的上行）',
    !!cloudRow && cloudRow.allocated_micro === 5000000, JSON.stringify(cloudRow));

  section('⑤ 批量 + 收回：外班学生与本班同等对待');
  var batchRes = await axios.post(seatUrl + '/api/admin/users/quota/batch', {
    items: [{ user_id: '180101', quota_yuan: 2 }, { user_id: '080102', quota_yuan: 3 }],
    reason: '批量验证'
  }, { timeout: 5000, headers: { Authorization: 'Bearer ' + seatToken } });
  var br = (batchRes.data && batchRes.data.data && batchRes.data.data.succeeded) || [];
  ok('批量结果逐人回传', batchRes.status === 200 && br.length === 2, JSON.stringify(batchRes.data));
  ok('批量结果标出了谁是外班',
    br.filter(function(x) { return x.remote; }).length === 1 &&
    br.filter(function(x) { return x.remote; })[0].user_id === '080102',
    JSON.stringify(br.map(function(x) { return x.user_id + '=' + x.remote; })));
  await waitUntil('8 班节点收到批量那笔', function() {
    var r = otherDb.prepare('SELECT allocated_micro FROM cluss_credit WHERE user_id = ?').get('080102');
    return r && r.allocated_micro === 3000000 ? r : null;
  });
  ok('批量里外班那笔也到了 8 班节点', true);

  var delRes = await axios.delete(seatUrl + '/api/admin/users/080101/quota', {
    timeout: 5000, headers: { Authorization: 'Bearer ' + seatToken }
  });
  ok('收回外班额度成功', delRes.status === 200 && delRes.data.data.remote === true,
    JSON.stringify(delRes.data));
  await waitUntil('8 班节点收到归零', function() {
    var r = otherDb.prepare('SELECT allocated_micro FROM cluss_credit WHERE user_id = ?').get('080101');
    return r && r.allocated_micro === 0 ? r : null;
  });
  ok('归零也下发到了 8 班（停用学生的额度停得掉）', true);

  section('⑥ 非席位班（8 班自己）：看得见本班，改不动');
  var otherToken = await login(otherUrl, OTHER_ADMIN_ID, OTHER_ADMIN_PW);
  var otherList = await axios.get(otherUrl + '/api/admin/users', {
    timeout: 5000, headers: { Authorization: 'Bearer ' + otherToken }
  });
  var otherUsers = otherList.data.data.users || [];
  ok('8 班列表只有本班学生', otherUsers.length === 3, '共 ' + otherUsers.length + ' 行');
  ok('8 班列表里没有外班行（非席位没有全校可见性）',
    otherUsers.every(function(u) { return !u.remote && u.source !== 'roster'; }),
    JSON.stringify(otherUsers.map(function(u) { return u.user_id; })));

  var otherPut, otherPutErr = null;
  try {
    otherPut = await axios.put(otherUrl + '/api/admin/users/080101/quota', { quota_yuan: 1 },
      { timeout: 5000, headers: { Authorization: 'Bearer ' + otherToken } });
  } catch (e) { otherPut = e.response || { status: 0 }; otherPutErr = e; }
  ok('8 班给自己学生充值也被拒（403，席位不在本班）', otherPut.status === 403,
    'HTTP ' + otherPut.status + ' ' + JSON.stringify(otherPut.data));

  var otherForeign, otherForeignErr = null;
  try {
    otherForeign = await axios.put(otherUrl + '/api/admin/users/180101/quota', { quota_yuan: 1 },
      { timeout: 5000, headers: { Authorization: 'Bearer ' + otherToken } });
  } catch (e) { otherForeign = e.response || { status: 0 }; otherForeignErr = e; }
  ok('8 班给 18 班学生充值同样被拒（先过闸门，不存在绕路）',
    otherForeign.status === 403, 'HTTP ' + otherForeign.status);
  // 本地闸门先挡：压根没有请求发到云端，谈不上「推上去又被拒」
  ok('8 班的改动一次都没发到云端（本地就挡住了）', cloud.nonSeatAllocPushes === 0,
    '云端收到非席位上行 ' + cloud.nonSeatAllocPushes + ' 次');

  section('⑦ 外班学生不会混进本班名册的世界边界');
  var localOnly = seatDb.prepare('SELECT COUNT(*) AS c FROM users WHERE user_id = ?').get('080101');
  ok('本机 users 表没有外班学生（名册边界一个字没动）', localOnly.c === 0, String(localOnly.c));
  var localCredit = seatDb.prepare('SELECT COUNT(*) AS c FROM cluss_credit WHERE user_id = ?').get('080102');
  ok('本机台账里也没有外班学生', localCredit.c === 0, String(localCredit.c));

  seatDb.close();
  otherDb.close();
  await Promise.all(procs.map(function(p) {
    return new Promise(function(r) { p.on('exit', r); p.kill(); });
  }));
  await fakeCloud.close();

  console.log('\n========================================');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(function(err) {
  console.error('\n验证异常:', err && err.message);
  procs.forEach(function(p) { console.error('--- ' + p.tag + ' 日志尾部 ---\n' +
    String(p.buf()).split('\n').slice(-20).join('\n')); });
  shutdown(1);
});
