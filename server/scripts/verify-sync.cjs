// ============================================================
// 验证脚本：中继 ↔ 班级节点 同步链路（多班管理核心通道，端到端）
//
// 覆盖：
//   ① 节点自动注册 + 心跳（cluss_nodes：首见即注册，last_seen 持续刷新）
//   ② 额度下发（relay 充值 → bump 版本 → node 轮询落地，幂等不重记流水）
//   ③ 用量上报（node 本地扣费明细 → relay synced=1 入库，last_report_at 更新）
//   ④ 模型配置下发（改价 + 视觉 + 峰谷 → bump → node 整表替换）
//   ⑤ 管理台节点看板（/admin/nodes：注册行、在线、版本到达、用量聚合）
//   ⑥ node 模式模型配置只读（PUT /api/admin/models → 403）
//   ⑦ 吊销/恢复（吊销后同步 403、用量滞留本地；恢复后自动续传）
//
// 跑法：起两个真实实例（relay + node 子进程，临时库、临时端口），
//       全程 HTTP + 真实轮询，不 mock 任何同步逻辑。
//   node server/scripts/verify-sync.cjs
// 不碰 server/database/cluss.db。
// ============================================================
'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var net = require('net');
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

// ---- 先占两个空闲端口（关掉后立刻用，存在极小的竞态窗口，可接受）----
function freePort() {
  return new Promise(function(resolve) {
    var srv = net.createServer();
    srv.listen(0, '127.0.0.1', function() {
      var p = srv.address().port;
      srv.close(function() { resolve(p); });
    });
  });
}

var SHARED_SECRET = 'sync-verify-shared-secret';
var JWT_SECRET = 'sync-verify-jwt-secret-0123456789abcdef';
var ADMIN_ID = '999999';
var ADMIN_PW = 'sync-verify-admin-pw';
var STUDENT_ID = '230101';
var NODE_INSTANCE = 'class-01-verify';

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-sync-'));
var relayDbPath = path.join(tmpDir, 'relay.db');
var nodeDbPath = path.join(tmpDir, 'node.db');

function baseEnv(mode, port, dbPath, extra) {
  return Object.assign({}, process.env, {
    CLUSS_MODE: mode,
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: JWT_SECRET,
    ADMIN_USER_ID: ADMIN_ID,
    ADMIN_PASSWORD: ADMIN_PW,
    CLUSS_SHARED_SECRET: SHARED_SECRET,
    CLUSS_INSTANCE_ID: mode === 'relay' ? 'relay-verify' : NODE_INSTANCE,
    // 关掉不相关的噪音，日志留故障排查用
    CI_BRIDGE_URL: ''
  }, extra || {});
}

var procs = [];
function startServer(env, tag) {
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

function waitHealthy(url, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 20000);
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

// 轮询等待某个断言成立（同步是异步轮询的，测试也得轮询）
function waitUntil(name, fn, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 10000);
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

function main() {
  var relayDb, nodeDb, relayPort, nodePort, relayUrl, nodeUrl, adminToken;

  return freePort().then(function(p1) {
    return freePort().then(function(p2) {
      relayPort = p1; nodePort = p2;
      relayUrl = 'http://127.0.0.1:' + relayPort;
      nodeUrl = 'http://127.0.0.1:' + nodePort;

      startServer(baseEnv('relay', relayPort, relayDbPath), 'relay');
      return waitHealthy(relayUrl, 25000);
    });
  }).then(function(err) {
    if (err) throw err;

    // relay 的引导账号在 relay 模式下强制非管理员（管理走 ClassIntra），
    // 测试要调管理接口，直接把权限位打开 —— 这是部署方有意识做的动作，
    // 单租户中枢没有 ClassIntra 时就该这样手动提权
    relayDb = openDb(relayDbPath);
    relayDb.prepare('UPDATE users SET is_admin = 1 WHERE user_id = ?').run(ADMIN_ID);

    startServer(baseEnv('node', nodePort, nodeDbPath, {
      CLUSS_RELAY_URL: relayUrl,
      CLUSS_SYNC_INTERVAL: '1',
      CLUSS_REPORT_INTERVAL: '1'
    }), 'node');
    return waitHealthy(nodeUrl, 25000);
  }).then(function(err) {
    if (err) throw err;
    nodeDb = openDb(nodeDbPath);

    // 两边都造同一个学生：分配只会落地到「节点上已存在」的账号
    var insUser = 'INSERT INTO users (user_id, net_name, real_name, password_hash, status, is_admin, info_json, source, created_at)' +
      "VALUES (?, '验证学生', '验证学生', 'x', 'active', 0, '{}', 'local', datetime('now'))";
    relayDb.prepare(insUser).run(STUDENT_ID);
    nodeDb.prepare(insUser).run(STUDENT_ID);

    section('① 节点自动注册 + 心跳');
    return waitUntil('cluss_nodes 出现节点行', function() {
      var row = relayDb.prepare('SELECT * FROM cluss_nodes WHERE instance_id = ?').get(NODE_INSTANCE);
      return row || null;
    }, 8000).then(function(row) {
      ok('节点首次同步即注册', !!row);
      ok('心跳时间已记录', !!row.last_seen_at, row.last_seen_at);
      ok('节点软件版本已上报', !!row.node_version, row.node_version);
      ok('状态为 active', row.status === 'active', row.status);
    });
  }).then(function() {
    section('② 额度下发 + 幂等');
    var now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    relayDb.prepare([
      'INSERT INTO cluss_credit (user_id, allocated_micro, weekly_quota_micro, updated_at, assigned_by)',
      'VALUES (?, 5000000, 0, ?, ?)' // 5 元
    ].join('\n')).run(STUDENT_ID, now, 'relay-verify');
    relayDb.prepare("INSERT INTO cluss_meta (key, value) VALUES ('assign_version', '1') " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run();

    return waitUntil('节点落地分配', function() {
      var row = nodeDb.prepare('SELECT allocated_micro FROM cluss_credit WHERE user_id = ?').get(STUDENT_ID);
      return row && row.allocated_micro === 5000000 ? row : null;
    }, 8000);
  }).then(function() {
    // 轮询是每秒一次的，等 3 秒确认幂等键没有重复记流水
    return new Promise(function(r) { setTimeout(r, 3000); }).then(function() {
      var logs = nodeDb.prepare("SELECT COUNT(*) AS c FROM cluss_credit_log WHERE user_id = ? AND kind = 'topup'").get(STUDENT_ID);
      ok('分配已落地（5 元 = 5000000 微元）', true);
      ok('重复轮询不重复记流水', logs.c === 1, '流水 ' + logs.c + ' 条');
    });
  }).then(function() {
    section('③ 用量上报');
    var now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    nodeDb.prepare([
      'INSERT INTO cluss_usage_log (user_id, conversation_id, model_id, prompt_tokens, completion_tokens,',
      'cache_hit_tokens, cache_miss_tokens, total_tokens, cost_micro, estimated, origin_instance,',
      "source, trace_id, image_count, synced, created_at)",
      "VALUES (?, 'conv-1', 'deepseek-chat', 100, 50, 0, 150, 150, 1000000, 0, ?, 'chat', '', 0, 0, ?)"
    ].join('\n')).run(STUDENT_ID, NODE_INSTANCE, now); // 1 元

    return waitUntil('中继收到用量', function() {
      var row = relayDb.prepare(
        'SELECT synced, origin_instance FROM cluss_usage_log WHERE user_id = ?').get(STUDENT_ID);
      return row && row.synced === 1 ? row : null;
    }, 8000);
  }).then(function(row) {
    ok('用量入库且 synced=1', row.origin_instance === NODE_INSTANCE, row.origin_instance);
    return waitUntil('节点侧标记已同步', function() {
      var r = nodeDb.prepare('SELECT synced FROM cluss_usage_log WHERE user_id = ?').get(STUDENT_ID);
      return r && r.synced === 1 ? r : null;
    }, 8000);
  }).then(function() {
    return waitUntil('last_report_at 已更新', function() {
      var r = relayDb.prepare('SELECT last_report_at FROM cluss_nodes WHERE instance_id = ?').get(NODE_INSTANCE);
      return r && r.last_report_at ? r : null;
    }, 8000);
  }).then(function() {
    ok('节点 last_report_at 已刷新', true);

    section('④ 模型配置下发（整表替换）');
    // 中枢改价 + 视觉转述 + 全局峰谷，一次 bump
    relayDb.prepare("UPDATE ai_models SET price_out = 9999 WHERE id = 'deepseek-chat'").run();
    relayDb.prepare("UPDATE cluss_meta SET value = 'deepseek-chat' WHERE key = 'vision_relay_model_id'").run();
    // offpeak_enabled 首次保存前没有这一行，必须 upsert
    relayDb.prepare("INSERT INTO cluss_meta (key, value) VALUES ('offpeak_enabled', '1') " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run();
    relayDb.prepare("INSERT INTO cluss_meta (key, value) VALUES ('model_config_version', '1') " +
      'ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)').run();

    return waitUntil('节点模型价格已替换', function() {
      var r = nodeDb.prepare("SELECT price_out FROM ai_models WHERE id = 'deepseek-chat'").get();
      return r && r.price_out === 9999 ? r : null;
    }, 8000);
  }).then(function() {
    ok('模型价格整表替换成功（9999）', true);
    return waitUntil('视觉/峰谷配置随行', function() {
      var v = nodeDb.prepare("SELECT value FROM cluss_meta WHERE key = 'vision_relay_model_id'").get();
      var o = nodeDb.prepare("SELECT value FROM cluss_meta WHERE key = 'offpeak_enabled'").get();
      return v && v.value === 'deepseek-chat' && o && o.value === '1' ? true : null;
    }, 8000);
  }).then(function() {
    ok('视觉转述 + 全局峰谷已同步到节点', true);

    section('⑤ 管理台节点看板');
    // 版本到达情况靠下一次心跳头更新（同步间隔 1s），先等它到位再看板
    return waitUntil('节点报告的模型版本到达中继', function() {
      var r = relayDb.prepare(
        'SELECT last_assign_version, last_model_version FROM cluss_nodes WHERE instance_id = ?').get(NODE_INSTANCE);
      return r && r.last_assign_version >= 1 && r.last_model_version >= 1 ? r : null;
    }, 10000).then(function() {
      return axios.post(relayUrl + '/api/auth/login', {
        account: ADMIN_ID, password: ADMIN_PW
      }, { timeout: 5000 });
    });
  }).then(function(resp) {
    adminToken = resp.data && resp.data.data && resp.data.data.token;
    if (!adminToken) throw new Error('relay 登录失败: ' + JSON.stringify(resp.data));
    return axios.get(relayUrl + '/api/admin/nodes', {
      headers: { Authorization: 'Bearer ' + adminToken }, timeout: 5000
    });
  }).then(function(resp) {
    var nodes = (resp.data.data && resp.data.data.nodes) || [];
    var mine = nodes.filter(function(n) { return n.instance_id === NODE_INSTANCE; })[0];
    ok('看板包含节点行', !!mine, JSON.stringify(nodes.map(function(n) { return n.instance_id; })));
    if (mine) {
      ok('在线判定为 true', mine.online === true, String(mine.online));
      ok('版本到达情况已上报', mine.last_assign_version >= 1 && mine.last_model_version >= 1,
        'assign=' + mine.last_assign_version + ' model=' + mine.last_model_version);
      ok('用量聚合正确（1 元）', mine.cost_micro === 1000000, String(mine.cost_micro));
      ok('注册来源为真（非老节点聚合）', mine.registered === true);
    }

    section('⑥ node 模式模型配置只读');
    return axios.post(nodeUrl + '/api/auth/login', {
      account: ADMIN_ID, password: ADMIN_PW
    }, { timeout: 5000 }).then(function(r2) {
      var t2 = r2.data && r2.data.data && r2.data.data.token;
      if (!t2) throw new Error('node 登录失败');
      return axios.put(nodeUrl + '/api/admin/models/deepseek-chat',
        { label: '被篡改的模型名' },
        { headers: { Authorization: 'Bearer ' + t2 }, timeout: 5000 });
    }).then(function(r3) {
      ok('node 上改模型被拒绝（403）', r3.status === 403 || r3.data.code === 403,
        JSON.stringify(r3.data).slice(0, 120));
    }).catch(function(err) {
      var st = err.response && err.response.status;
      ok('node 上改模型被拒绝（403）', st === 403, 'status=' + st);
      return null;
    });
  }).then(function() {
    section('⑦ 吊销 / 恢复');
    return axios.post(relayUrl + '/api/admin/nodes/' + NODE_INSTANCE + '/revoke', {},
      { headers: { Authorization: 'Bearer ' + adminToken }, timeout: 5000 });
  }).then(function(resp) {
    ok('吊销接口返回成功', resp.data.code === 200, JSON.stringify(resp.data.message));

    // 吊销后：节点再塞一条用量 → 上报应被 403 挡住，留在本地
    var now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    nodeDb.prepare([
      'INSERT INTO cluss_usage_log (user_id, conversation_id, model_id, prompt_tokens, completion_tokens,',
      'cache_hit_tokens, cache_miss_tokens, total_tokens, cost_micro, estimated, origin_instance,',
      "source, trace_id, image_count, synced, created_at)",
      "VALUES (?, 'conv-2', 'deepseek-chat', 10, 5, 0, 15, 15, 500000, 0, ?, 'chat', '', 0, 0, ?)"
    ].join('\n')).run(STUDENT_ID, NODE_INSTANCE, now);

    return new Promise(function(r) { setTimeout(r, 3000); }).then(function() {
      var pending = nodeDb.prepare(
        'SELECT COUNT(*) AS c FROM cluss_usage_log WHERE user_id = ? AND synced = 0').get(STUDENT_ID);
      var relayGot = relayDb.prepare(
        'SELECT COUNT(*) AS c FROM cluss_usage_log WHERE cost_micro = 500000').get();
      ok('吊销后上报被拒，用量滞留本地', pending.c >= 1, '本地待同步 ' + pending.c + ' 条');
      ok('吊销后中继没有收到新用量', relayGot.c === 0, '中继收到 ' + relayGot.c + ' 条');
    });
  }).then(function() {
    return axios.post(relayUrl + '/api/admin/nodes/' + NODE_INSTANCE + '/restore', {},
      { headers: { Authorization: 'Bearer ' + adminToken }, timeout: 5000 });
  }).then(function(resp) {
    ok('恢复接口返回成功', resp.data.code === 200, JSON.stringify(resp.data.message));
    return waitUntil('恢复后滞留用量自动续传', function() {
      var r = relayDb.prepare(
        'SELECT COUNT(*) AS c FROM cluss_usage_log WHERE cost_micro = 500000').get();
      return r.c >= 1 ? r : null;
    }, 10000);
  }).then(function() {
    ok('恢复后用量续传到中继', true);
  }).then(function() {
    console.log('\n========================================');
    console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
    console.log('========================================');
    shutdown(fail ? 1 : 0);
  }).catch(function(err) {
    console.error('\n验证异常:', err && err.message);
    for (var i = 0; i < procs.length; i++) {
      console.error('--- ' + procs[i].tag + ' 日志尾部 ---');
      console.error(procs[i].buf().split('\n').slice(-25).join('\n'));
    }
    shutdown(1);
  });
}

function shutdown(code) {
  for (var i = 0; i < procs.length; i++) {
    try { procs[i].kill(); } catch (e) { /* ignore */ }
  }
  setTimeout(function() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    process.exit(code);
  }, 500);
}

process.on('SIGINT', function() { shutdown(1); });
main();
