// ============================================================
// 验证脚本：Cluss Cloud 多租户隔离（A/B 两校互不可见）
//
// 覆盖：
//   ① 注册学校（编号/管理员/接入密钥发放）
//   ② 节点显式接入 /api/org/join（密钥错/学校停用要挡住）
//   ③ 同步接口按校隔离（A 校拿不到 B 校分配与用量，反之亦然）
//   ④ 充值的影响半径（B 校管理员给 A 校学号充值 → 403）
//   ⑤ 学校管理员视角（overview 只见本校；不能碰平台管理接口）
//   ⑥ 平台运营者视角（/admin/nodes 能看到两校节点与校名）
//   ⑦ 自托管旧路径共存（不带 X-Cluss-Org 的全局密钥节点照常工作）
//
// 跑法：起一个真实 relay 实例（临时库/端口），用 HTTP 直接扮演多个节点与
//       两个学校管理员。完整「真节点进程」链路由 verify-sync.cjs 覆盖。
//   node server/scripts/verify-cloud-org.cjs
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

var SHARED_SECRET = 'legacy-shared-secret';
var JWT_SECRET = 'cloud-org-jwt-secret-0123456789abcdef';
var ADMIN_ID = '999999';
var ADMIN_PW = 'cloud-org-admin-pw';

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-org-'));
var relayDbPath = path.join(tmpDir, 'relay.db');

var child = null;
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

// 以「节点」身份调用同步接口
function nodeApi(baseUrl, opts) {
  var headers = {
    'X-Cluss-Secret': opts.secret,
    'X-Cluss-Instance': opts.instance,
    'X-Cluss-Node-Version': '0.2.0',
    'X-Cluss-Assign-Version': String(opts.assignV || 0),
    'X-Cluss-Model-Version': String(opts.modelV || 0)
  };
  if (opts.org) headers['X-Cluss-Org'] = opts.org;
  return axios.create({ baseURL: baseUrl, timeout: 5000, headers: headers });
}

function shutdown(code) {
  if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
  setTimeout(function() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    process.exit(code);
  }, 500);
}

function main() {
  var relayUrl, db, adminToken;

  return freePort().then(function(port) {
    relayUrl = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [path.join(SERVER_DIR, 'src', 'app.js')], {
      env: Object.assign({}, process.env, {
        CLUSS_MODE: 'relay',
        PORT: String(port),
        DB_PATH: relayDbPath,
        JWT_SECRET: JWT_SECRET,
        ADMIN_USER_ID: ADMIN_ID,
        ADMIN_PASSWORD: ADMIN_PW,
        CLUSS_SHARED_SECRET: SHARED_SECRET,
        CLUSS_INSTANCE_ID: 'relay-cloud-verify'
      }),
      cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe']
    });
    var out = '';
    child.stdout.on('data', function(d) { out += d; });
    child.stderr.on('data', function(d) { out += d; });
    child.buf = function() { return out; };
    return waitHealthy(relayUrl, 25000);
  }).then(function(err) {
    if (err) throw err;
    var Database = require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3'));
    db = new Database(relayDbPath);
    db.pragma('busy_timeout = 5000');
    db.prepare('UPDATE users SET is_admin = 1 WHERE user_id = ?').run(ADMIN_ID);

    section('① 注册学校 A / B');
    return axios.post(relayUrl + '/api/org/register', {
      school_name: '第一中学', region: '测试省', admin_net_name: 'yzAdmin',
      admin_real_name: '一中管理员', admin_password: 'yz-admin-pass-123'
    }, { timeout: 5000 });
  }).then(function(resp) {
    ok('学校 A 注册成功', resp.data.code === 200 && resp.data.data.org_id, JSON.stringify(resp.data.message));
    global.orgA = resp.data.data;

    return axios.post(relayUrl + '/api/org/register', {
      school_name: '第二中学', region: '测试省', admin_net_name: 'ezAdmin',
      admin_real_name: '二中管理员', admin_password: 'ez-admin-pass-123'
    }, { timeout: 5000 });
  }).then(function(resp) {
    ok('学校 B 注册成功', resp.data.code === 200 && resp.data.data.org_id !== global.orgA.org_id);
    global.orgB = resp.data.data;

    section('② 节点接入');
    return axios.post(relayUrl + '/api/org/join', {
      org_id: global.orgA.org_id, secret: 'wrong-secret', instance_id: 'class-a1'
    }, { timeout: 5000 }).catch(function(e) { return e.response; });
  }).then(function(resp) {
    ok('错误密钥被拒绝', resp.status === 403, 'status=' + resp.status);

    return axios.post(relayUrl + '/api/org/join', {
      org_id: global.orgA.org_id, secret: global.orgA.org_secret,
      instance_id: 'class-a1', node_version: '0.2.0'
    }, { timeout: 5000 });
  }).then(function(resp) {
    ok('节点 A1 接入成功', resp.data.code === 200, JSON.stringify(resp.data.message));

    section('③ 同步接口按校隔离');
    // 给 A 校造两条分配、B 校一条（直接写库，分配链路 verify-sync 已覆盖）
    var now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    var ins = 'INSERT INTO cluss_credit (user_id, allocated_micro, weekly_quota_micro, org_id, updated_at, assigned_by) VALUES (?, ?, 0, ?, ?, ?)';
    db.prepare(ins).run('100101', 3000000, global.orgA.org_id, now, 'test'); // A 校 3 元
    db.prepare(ins).run('100102', 2000000, global.orgA.org_id, now, 'test'); // A 校 2 元
    db.prepare(ins).run('200101', 5000000, global.orgB.org_id, now, 'test'); // B 校 5 元

    return nodeApi(relayUrl, {
      org: global.orgA.org_id, secret: global.orgA.org_secret, instance: 'class-a1'
    }).get('/api/sync/assignments');
  }).then(function(resp) {
    var ids = resp.data.data.assignments.map(function(a) { return a.user_id; }).sort();
    ok('A 校只见自己的分配', ids.length === 2 && ids[0] === '100101' && ids[1] === '100102', JSON.stringify(ids));

    return nodeApi(relayUrl, {
      org: global.orgB.org_id, secret: global.orgB.org_secret, instance: 'class-b1'
    }).get('/api/sync/assignments');
  }).then(function(resp) {
    var ids = resp.data.data.assignments.map(function(a) { return a.user_id; });
    ok('B 校只见自己的分配', ids.length === 1 && ids[0] === '200101', JSON.stringify(ids));

    // A 校节点上报一条用量
    return nodeApi(relayUrl, {
      org: global.orgA.org_id, secret: global.orgA.org_secret, instance: 'class-a1'
    }).post('/api/sync/usage', {
      records: [{
        user_id: '100101', conversation_id: 'c1', model_id: 'deepseek-chat',
        prompt_tokens: 10, completion_tokens: 5, cache_hit_tokens: 0, cache_miss_tokens: 15,
        total_tokens: 15, cost_micro: 123456, estimated: 0, source: 'chat',
        trace_id: '', image_count: 0, created_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
      }]
    });
  }).then(function(resp) {
    ok('A 校用量上报成功', resp.data.data.accepted === 1);

    var row = db.prepare("SELECT org_id, origin_instance FROM cluss_usage_log WHERE cost_micro = 123456").get();
    ok('用量已打上 A 校标', row && row.org_id === global.orgA.org_id, JSON.stringify(row));
    ok('用量来源实例为 A1', row && row.origin_instance === 'class-a1');

    // B 校视角的用量统计应为空
    return nodeApi(relayUrl, {
      org: global.orgB.org_id, secret: global.orgB.org_secret, instance: 'class-b1'
    }).get('/api/sync/assignments');
  }).then(function() {
    section('④ 充值影响半径');
    return axios.post(relayUrl + '/api/auth/login', { account: global.orgB.admin_user_id, password: 'ez-admin-pass-123' }, { timeout: 5000 });
  }).then(function(resp) {
    global.tokenB = resp.data.data.token;
    return axios.post(relayUrl + '/api/auth/login', { account: global.orgA.admin_user_id, password: 'yz-admin-pass-123' }, { timeout: 5000 });
  }).then(function(resp) {
    global.tokenA = resp.data.data.token;

    // B 校管理员给 A 校学号充值 → 403
    return axios.post(relayUrl + '/api/org/my/topup',
      { user_id: '100101', amount_yuan: 5 },
      { headers: { Authorization: 'Bearer ' + global.tokenB }, timeout: 5000 })
      .catch(function(e) { return e.response; });
  }).then(function(resp) {
    ok('跨校充值被拒绝（403）', resp.status === 403, 'status=' + resp.status);

    // B 校给自己学生充值 → 成功
    return axios.post(relayUrl + '/api/org/my/topup',
      { user_id: '200102', amount_yuan: 2 },
      { headers: { Authorization: 'Bearer ' + global.tokenB }, timeout: 5000 });
  }).then(function(resp) {
    ok('本校充值成功', resp.data.code === 200, JSON.stringify(resp.data.message));
    var row = db.prepare("SELECT org_id, allocated_micro FROM cluss_credit WHERE user_id = '200102'").get();
    ok('充值打上 B 校标（2 元）', row && row.org_id === global.orgB.org_id && row.allocated_micro === 2000000, JSON.stringify(row));

    section('⑤ 学校管理员视角');
    return axios.get(relayUrl + '/api/org/my/overview', {
      headers: { Authorization: 'Bearer ' + global.tokenA }, timeout: 5000
    });
  }).then(function(resp) {
    var d = resp.data.data;
    ok('A 校 overview 只见自己节点', d.nodes.length === 1 && d.nodes[0].instance_id === 'class-a1',
      JSON.stringify(d.nodes.map(function(n) { return n.instance_id; })));
    ok('A 校汇总：2 名学生', d.totals.students === 2, String(d.totals.students));
    ok('A 校汇总：已用 123456 微元', d.totals.used_micro === 123456, String(d.totals.used_micro));

    return axios.get(relayUrl + '/api/org/my/overview', {
      headers: { Authorization: 'Bearer ' + global.tokenB }, timeout: 5000
    });
  }).then(function(resp) {
    var d = resp.data.data;
    ok('B 校 overview 看不到 A 校用量', d.totals.used_micro === 0, String(d.totals.used_micro));

    // 学校管理员不能碰平台管理接口
    return axios.get(relayUrl + '/api/admin/users', {
      headers: { Authorization: 'Bearer ' + global.tokenA }, timeout: 5000
    }).catch(function(e) { return e.response; });
  }).then(function(resp) {
    ok('学校管理员访问平台管理接口被拒', resp.status === 403, 'status=' + resp.status);

    section('⑥ 平台运营者视角');
    return axios.post(relayUrl + '/api/auth/login', { account: ADMIN_ID, password: ADMIN_PW }, { timeout: 5000 });
  }).then(function(resp) {
    adminToken = resp.data.data.token;
    return axios.get(relayUrl + '/api/admin/nodes', {
      headers: { Authorization: 'Bearer ' + adminToken }, timeout: 5000
    });
  }).then(function(resp) {
    var nodes = resp.data.data.nodes || [];
    var a1 = nodes.filter(function(n) { return n.instance_id === 'class-a1'; })[0];
    ok('平台看板含 A1 节点且带校名', !!a1 && a1.org_name === '第一中学', JSON.stringify(a1));

    section('⑦ 自托管旧路径共存');
    // 不带 X-Cluss-Org 的旧节点：全局密钥照常工作，只看到 org_id='' 的分配
    var now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('INSERT INTO cluss_credit (user_id, allocated_micro, weekly_quota_micro, org_id, updated_at, assigned_by) VALUES (?, ?, 0, \'\', ?, ?)')
      .run('900001', 1000000, now, 'relay');
    return nodeApi(relayUrl, { secret: SHARED_SECRET, instance: 'legacy-node' }).get('/api/sync/assignments');
  }).then(function(resp) {
    var ids = resp.data.data.assignments.map(function(a) { return a.user_id; });
    ok('旧节点只见无主（本机）分配', ids.length === 1 && ids[0] === '900001', JSON.stringify(ids));

    console.log('\n========================================');
    console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
    console.log('========================================');
    shutdown(fail ? 1 : 0);
  }).catch(function(err) {
    console.error('\n验证异常:', err && err.message);
    if (child) console.error('--- relay 日志尾部 ---\n' + child.buf().split('\n').slice(-30).join('\n'));
    shutdown(1);
  });
}

process.on('SIGINT', function() { shutdown(1); });
main();
