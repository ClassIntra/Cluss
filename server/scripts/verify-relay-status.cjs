// ============================================================
// 验证脚本：node 端向中继/云端上报的状态字段（getStatus）
//
// 覆盖：管理员在本地管理台要看的每一项，都必须真的从 getStatus() 出来。
// 这组字段以前只喂给 /api/health，管理台一个字都看不到——于是没人知道
// 学校编号丢了、版本对不上、时钟偏了会怎样，出问题只能翻服务器日志。
//
// 跑法：
//   JWT_SECRET=verify-only-secret-0123456789abcdef node scripts/verify-relay-status.cjs
// 不碰 server/database/cluss.db（只读 config，不连库）。
// ============================================================
'use strict';

var path = require('path');
var os = require('os');
var fs = require('fs');
var http = require('http');

var SERVER_DIR = path.resolve(__dirname, '..');
var pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  | ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// 清掉 require 缓存，让 config 与其下游模块重新读环境变量
function loadSync(env) {
  Object.keys(env).forEach(function(k) { process.env[k] = env[k]; });
  var srcDir = path.join(SERVER_DIR, 'src');
  Object.keys(require.cache).forEach(function(key) {
    if (key.indexOf(srcDir) === 0 && key.indexOf(path.sep + 'scripts') < 0) delete require.cache[key];
  });
  return require(path.join(srcDir, 'services', 'sync.js'));
}

// 起一个假中继，捕获本地发出的请求头与路径
function startFakeRelay(onRequest) {
  return new Promise(function(resolve) {
    var srv = http.createServer(function(req, res) {
      var body = '';
      req.on('data', function(c) { body += c; });
      req.on('end', function() {
        onRequest(req.method, req.url, req.headers, body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          code: 200, message: 'ok',
          data: {
            assign_version: 7,
            model_config_version: 3,
            server_time: '2026-10-12 08:00:00',
            assignments: [],
            models: [], sources: [], meta: {},
            accepted: 0
          }
        }));
      });
    });
    srv.listen(0, '127.0.0.1', function() {
      resolve({ srv: srv, port: srv.address().port });
    });
  });
}

function stop(srv) { return new Promise(function(r) { srv.close(function() { r(); }); }); }

(async function main() {
  console.log('========================================');
  console.log('验证：node 端中继状态字段');
  console.log('========================================');

  var requests = [];
  var relay = await startFakeRelay(function(m, u, h) { requests.push({ m: m, u: u, h: h }); });

  section('① 未接入时：字段齐全且明确说「未接入」');
  var s1 = loadSync({ CLUSS_MODE: 'standalone' }).getStatus();
  ok('standalone 模式 enabled=false', s1.enabled === false);
  ok('仍返回 mode', s1.mode === 'standalone', s1.mode);
  ok('org_id 为空串而不是 undefined', s1.org_id === '', JSON.stringify(s1.org_id));
  ok('本地版本字段是数字', typeof s1.local_assign_version === 'number' && typeof s1.local_model_version === 'number',
    s1.local_assign_version + '/' + s1.local_model_version);
  ok('同步标记存在且为布尔', typeof s1.assign_pending === 'boolean' && typeof s1.model_pending === 'boolean');

  section('② 接入后：身份三件套（学校编号 / 实例 / 版本）');
  var sync = loadSync({
    CLUSS_MODE: 'node',
    CLUSS_RELAY_URL: 'http://127.0.0.1:' + relay.port,
    CLUSS_SHARED_SECRET: 'fake-secret-for-verify',
    CLUSS_ORG_ID: 'MQSJFM',
    CLUSS_INSTANCE_ID: 'class-01'
  });
  var s2 = sync.getStatus();
  // 注意：status.enabled 由 start() 置位（代表定时任务真的起来了），
  // getStatus() 在 start() 之前读它一定是 false —— 这是预期行为，
  // 所以这里验 isEnabled()（配置是否齐备），不验 status.enabled。
  ok('isEnabled() 为真（配置齐备）', sync.isEnabled() === true);
  ok('start 之前 enabled 仍是 false（定时任务确实没起）', s2.enabled === false);
  ok('带出学校编号 org_id', s2.org_id === 'MQSJFM', 'org_id=' + s2.org_id);
  ok('带出本机实例', s2.instance_id === 'class-01', 'instance=' + s2.instance_id);
  ok('带出云端地址', String(s2.relay_url).indexOf('127.0.0.1') > 0, s2.relay_url);

  section('③ 出站请求确实带了身份头');
  await sync.pollOnce();
  var ver = requests.filter(function(r) { return r.u.indexOf('/api/sync/version') >= 0; })[0];
  ok('请求打过 /api/sync/version', !!ver);
  if (ver) {
    ok('X-Cluss-Org = 学校编号', ver.h['x-cluss-org'] === 'MQSJFM', ver.h['x-cluss-org']);
    ok('X-Cluss-Instance = 实例', ver.h['x-cluss-instance'] === 'class-01', ver.h['x-cluss-instance']);
    ok('X-Cluss-Secret = 密钥', ver.h['x-cluss-secret'] === 'fake-secret-for-verify');
    ok('X-Cluss-Node-Version 存在', !!ver.h['x-cluss-node-version'], ver.h['x-cluss-node-version']);
  }

  section('④ 云端版本 vs 本机版本，能算出「待同步」');
  var s3 = sync.getStatus();
  ok('记录了云端额度版本 7', s3.assign_version === 7, String(s3.assign_version));
  ok('记录了云端模型版本 3', s3.model_version === 3, String(s3.model_version));
  // pollOnce 已经把两个版本落到本机 meta，所以此刻云端 == 本机、pending 为 false。
  // 这正是要验的：拉取成功后两端必须对上，否则管理台会一直显示「待同步」。
  ok('拉取成功后云端与本机版本一致', s3.assign_pending === false && s3.model_pending === false,
    '云端 ' + s3.assign_version + '/' + s3.model_version + ' vs 本机 ' + s3.local_assign_version + '/' + s3.local_model_version);
  ok('本机版本已追上云端', s3.local_assign_version === 7 && s3.local_model_version === 3,
    s3.local_assign_version + '/' + s3.local_model_version);

  section('⑤ 时钟偏差（教室机常年不校时，账目跨月统计靠它）');
  ok('记录了云端服务器时间', s3.server_time === '2026-10-12 08:00:00', String(s3.server_time));
  ok('算出了时钟偏差（毫秒）',
    s3.clock_skew_ms !== null && typeof s3.clock_skew_ms === 'number',
    JSON.stringify(s3.clock_skew_ms));

  section('⑥ 用量回传：上传与回传分开记');
  var s4 = sync.getStatus();
  ok('有 last_push_at 字段（哪怕还没传过也是 null）', 'last_push_at' in s4);
  ok('尚未上报时为 null', s4.last_push_at === null, String(s4.last_push_at));
  ok('有 reported_total', s4.reported_total === 0, String(s4.reported_total));
  ok('有 pending_usage', s4.pending_usage === 0, String(s4.pending_usage));

  section('⑦ 异常信息可读（连接失败时管理台要显示原因）');
  // 指向一个没人监听的端口，制造连接失败
  var broken = loadSync({
    CLUSS_MODE: 'node',
    CLUSS_RELAY_URL: 'http://127.0.0.1:1',
    CLUSS_RELAY_SECRET: 'x',
    CLUSS_ORG_ID: 'MQSJFM'
  });
  await broken.pollOnce();
  var s5 = broken.getStatus();
  ok('记录了错误信息', !!s5.last_error, String(s5.last_error));
  ok('记录了错误时间', !!s5.last_error_at);
  // 关键：失败不许伪造成功状态，否则管理台会显示「已连接」而其实没连上
  ok('失败时 last_ok_at 仍为空（不会假装成功）', s5.last_ok_at === null, String(s5.last_ok_at));
  ok('失败时版本不更新', s5.assign_version === 0, String(s5.assign_version));

  await stop(relay.srv);

  console.log('\n========================================');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(function(err) {
  console.error('\n验证异常:', err && err.stack);
  process.exit(1);
});