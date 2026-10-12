// ============================================================
// 验证脚本：节点侧「账号绑定」的线路契约（Cluss → Cluss-Cloud）
//
// 覆盖：
//   ① node 模式能拿到一次性确认码，且请求形状与云端约定逐字段一致
//      （POST /api/sync/bind-request + X-Cluss-* 身份头 + body 三字段）
//   ② admin_username 会去空格并转小写（云端按小写用户名存账号）
//   ③ 云端没返回 bind_code 时报错而不是静默成功（避免页面显示空确认码）
//   ④ 云端 403 的原话透传给班管（"只有本班班管可以发起"这类要看得懂）
//   ⑤ 非 node 模式直接拒绝，不去打网络
//   ⑥ 线路契约本身（云端认哪些头/字段）在这里钉住，防止两仓各改一边漂移
//
// 绑定为什么是双向两段式，看这里：
//   云端永远不存班级密码，所以网页上填学号等于谁都能声称自己是任何人；
//   只有本机能作证「此刻登录的是 X 班学号 Y 且他是班管」。于是：
//     节点（带校级密钥）→ 上报自己的学号 → 云端回一次性确认码
//     管理员（带自己的密码）→ 在网页输入确认码 → 两头对上才算同一人
//
// 跑法：node server/scripts/verify-cloud-bind.cjs
// 不碰 server/database/cluss.db（config 在本脚本里指向临时库）。
// ============================================================
'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var http = require('http');

var SERVER_DIR = path.resolve(__dirname, '..');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  | ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-bind-verify-'));

// ---- 桩云端：只做两件事——把请求原样记下来，按脚本指定的方式回话 ----
var lastReq = null;
var reply = { status: 200, body: { code: 200, data: { bind_code: 'ABC234', admin_username: 'yzadmin' } } };
var stub = http.createServer(function(req, res) {
  var chunks = '';
  req.on('data', function(c) { chunks += c; });
  req.on('end', function() {
    lastReq = {
      method: req.method, url: req.url, headers: req.headers,
      body: chunks ? JSON.parse(chunks) : null
    };
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
});

function loadSync(env) {
  // config 在 require 时读一次环境变量，所以每次换配置都要清缓存重来
  Object.keys(require.cache).forEach(function(k) {
    if (k.indexOf(path.join(SERVER_DIR, 'src')) === 0) delete require.cache[k];
  });
  Object.keys(env).forEach(function(k) {
    if (env[k] === null) delete process.env[k];
    else process.env[k] = env[k];
  });
  return require(path.join(SERVER_DIR, 'src', 'services', 'sync.js'));
}

function cleanup() {
  try { stub.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

stub.listen(0, '127.0.0.1', function() {
  var port = stub.address().port;
  var base = 'http://127.0.0.1:' + port;

  var nodeEnv = {
    CLUSS_MODE: 'node',
    CLUSS_RELAY_URL: base,
    CLUSS_SHARED_SECRET: 'org-secret-for-verify',
    CLUSS_ORG_ID: 'YZ0011',
    CLUSS_INSTANCE_ID: 'class-x1',
    CLUSS_DB_PATH: path.join(tmpDir, 'cluss.db')
  };

  section('① node 模式发起绑定：请求形状');
  var sync = loadSync(nodeEnv);
  ok('node 模式判定为已启用', sync.isEnabled() === true);
  lastReq = null;
  return sync.requestBindCode('  YZAdmin  ', '251800')
    .then(function(data) {
      ok('拿到一次性确认码', data && data.bind_code === 'ABC234', JSON.stringify(data));
      ok('打的是 POST /api/sync/bind-request', lastReq && lastReq.method === 'POST' && lastReq.url === '/api/sync/bind-request',
        lastReq && lastReq.method + ' ' + lastReq.url);
      ok('带校级身份头（X-Cluss-Org / Secret / Instance）',
        lastReq.headers['x-cluss-org'] === 'YZ0011' &&
        lastReq.headers['x-cluss-secret'] === 'org-secret-for-verify' &&
        lastReq.headers['x-cluss-instance'] === 'class-x1',
        JSON.stringify({ o: lastReq.headers['x-cluss-org'], s: !!lastReq.headers['x-cluss-secret'], i: lastReq.headers['x-cluss-instance'] }));
      ok('body 三字段：用户名 / 班级学号 / 班管标记',
        lastReq.body && lastReq.body.admin_username === 'yzadmin' &&
        lastReq.body.class_user_id === '251800' && lastReq.body.class_admin === true,
        JSON.stringify(lastReq.body));
      ok('管理员用户名已去空格并转小写（云端按小写存账号）', lastReq.body.admin_username === 'yzadmin', lastReq.body.admin_username);

      section('② 云端回话：三种异常都要看得懂');
      reply = { status: 200, body: { code: 200, data: {} } };
      return sync.requestBindCode('yzadmin', '251800');
    })
    .then(function() {
      ok('云端没给码 → 报错而不是静默成功', false);
    })
    .catch(function(err) {
      ok('云端没给码 → 报错而不是静默成功', /确认码/.test(err.message), err.message);
      reply = { status: 403, body: { code: 403, message: '只有本班班管可以发起账号绑定（当前账号不是班管）' } };
      return sync.requestBindCode('yzadmin', '251800');
    })
    .then(function() {
      ok('云端 403 原话透传', false);
    })
    .catch(function(err) {
      ok('云端 403 原话透传（班管要看得懂为什么）',
        /只有本班班管/.test(err.message), err.message);
      reply = { status: 404, body: { code: 404, message: 'not found' } };
      return sync.requestBindCode('yzadmin', '251800');
    })
    .then(function() {
      ok('中继不认识该端点（404）→ 拒绝并给出可用原因', false);
    })
    .catch(function(err) {
      ok('中继不认识该端点（404）→ 拒绝', !!err.message, err.message);

      section('③ 非 node 模式不打网络');
      var soloSync = loadSync({
        CLUSS_MODE: 'standalone',
        CLUSS_RELAY_URL: null, CLUSS_SHARED_SECRET: null, CLUSS_ORG_ID: null
      });
      ok('standalone 判定为未启用', soloSync.isEnabled() === false);
      lastReq = null;
      return soloSync.requestBindCode('yzadmin', '251800');
    })
    .then(function() {
      ok('未接中继时拒绝发起', false);
    })
    .catch(function(err) {
      ok('未接中继时拒绝发起，且没有发出任何请求', lastReq === null, err.message);
      ok('拒绝原因是人话（不是 stack 泄漏）', /node/.test(err.message), err.message);

      console.log('\n========================================');
      console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
      console.log('========================================');
      cleanup();
      process.exit(fail ? 1 : 0);
    })
    .catch(function(err) {
      console.error('\n验证异常:', err && err.message);
      console.error(err && err.stack);
      cleanup();
      process.exit(1);
    });
});