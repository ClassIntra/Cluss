// ============================================================
// 验证脚本：配置上行写（席位班管在本地改 → 推给云端 → 全校）
//
// 覆盖本地这一侧的关键行为：
//   ① 待推队列：入队、同学生去重（连点两次以最后一次为准）
//   ② 非席位班不入上行（改了也不会同步全校，面板要能说明白）
//   ③ 幂等键稳定：同一份变更重推是同一个键（云端据此去重，不重复记账）
//   ④ 冲突（409）时清队列并留下人话错误，不会无限重推
//   ⑤ 普通失败（断网）时**保留队列**，管理员的操作不能丢
//   ⑥ 席位判定以云端告知为准，本机不能自封
//
// 跑法：
//   JWT_SECRET=verify-only-secret-0123456789abcdef node scripts/verify-sync-up.cjs
// 不碰 server/database/cluss.db（用假中继，不连真实数据库）。
// ============================================================
'use strict';

var path = require('path');
var os = require('os');
var http = require('http');

var SERVER_DIR = path.resolve(__dirname, '..');
var pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  | ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// 清 require 缓存让 config 重新读环境变量
function loadSync(env) {
  Object.keys(env).forEach(function(k) { process.env[k] = env[k]; });
  var srcDir = path.join(SERVER_DIR, 'src');
  Object.keys(require.cache).forEach(function(key) {
    if (key.indexOf(srcDir) === 0) delete require.cache[key];
  });
  return require(path.join(srcDir, 'services', 'sync.js'));
}

// 假中继：可编排响应（成功 / 409 冲突 / 500 故障 / 按 URL 记账）
function startFakeRelay(handler) {
  return new Promise(function(resolve) {
    var seen = [];
    var srv = http.createServer(function(req, res) {
      var body = '';
      req.on('data', function(c) { body += c; });
      req.on('end', function() {
        var payload = {};
        try { payload = JSON.parse(body); } catch (e) { /* 空体 */ }
        seen.push({ url: req.url, body: payload });
        var r = handler(req.url, payload, seen.length) || {};
        res.statusCode = r.status || 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(r.json || { code: 200, message: 'ok', data: {} }));
      });
    });
    srv.listen(0, '127.0.0.1', function() {
      resolve({
        port: srv.address().port,
        seen: seen,
        close: function() { return new Promise(function(r) { srv.close(function() { r(); }); }); }
      });
    });
  });
}

function baseEnv(port) {
  return {
    CLUSS_MODE: 'node',
    CLUSS_RELAY_URL: 'http://127.0.0.1:' + port,
    CLUSS_SHARED_SECRET: 'fake-secret',
    CLUSS_ORG_ID: 'MQSJFM',
    CLUSS_INSTANCE_ID: 'class-seat'
  };
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

(async function main() {
  console.log('========================================');
  console.log('验证：配置上行写（本地侧）');
  console.log('========================================');

  var pushCalls = [];
  var relay = await startFakeRelay(function(url, payload, n) {
    if (url.indexOf('/api/sync/version') >= 0) {
      return { json: { code: 200, message: 'ok', data: {
        assign_version: 3, model_config_version: 5,
        is_seat_admin: true, seat_instance: 'class-seat',
        server_time: '2026-10-12 08:00:00'
      } } };
    }
    if (url.indexOf('/api/sync/policy') >= 0) {
      pushCalls.push({ kind: 'policy', body: payload });
      return { json: { code: 200, message: 'ok', data: { model_config_version: 6 } } };
    }
    if (url.indexOf('/api/sync/allocations') >= 0) {
      pushCalls.push({ kind: 'alloc', body: payload });
      return { json: { code: 200, message: 'ok', data: { assign_version: 4, applied: payload.items.length, skipped: 0 } } };
    }
    return {};
  });

  section('① 席位判定以云端为准');
  var sync = loadSync(baseEnv(relay.port));
  await sync.pollOnce();
  var st = sync.getStatus();
  ok('云端说本班是席位 → 本机认定可写', st.is_seat_admin === true, 'is_seat_admin=' + st.is_seat_admin);
  ok('带出席位所在班', st.seat_instance === 'class-seat', String(st.seat_instance));
  ok('写入权状态进 getStatus()', 'is_seat_admin' in st);

  section('② 额度入队：同一学生只保留最后一次');
  sync.queueAllocation('1001', 1000000, 0, '第一次加 1 元', '999999');
  var q1 = sync.getStatus();
  ok('入队后待同步数 = 1', q1.pending_allocations === 1, String(q1.pending_allocations));
  sync.queueAllocation('1001', 2000000, 0, '又加了一次', '999999');
  var q2 = sync.getStatus();
  ok('同一学生再改不叠加条目', q2.pending_allocations === 1, String(q2.pending_allocations));

  section('③ 上行：带上席管理���学号与幂等键');
  pushCalls = [];
  await sync.pushPending('999999');
  var allocPush = pushCalls.filter(function(c) { return c.kind === 'alloc'; })[0];
  ok('确实推了额度', !!allocPush);
  if (allocPush) {
    var item = allocPush.body.items[0];
    ok('带上学号（云端要校验与席位一致）', allocPush.body.class_user_id === '999999', allocPush.body.class_user_id);
    ok('class_admin 为真', allocPush.body.class_admin === true);
    ok('携带 base_version 做 CAS', typeof allocPush.body.base_version === 'number',
      String(allocPush.body.base_version));
    ok('额度是绝对值（云端是覆盖语义）', item.allocated_micro === 2000000, String(item.allocated_micro));
    ok('带幂等键', !!item.idem_key && item.idem_key.length > 0, String(item.idem_key));
  }
  ok('推成功后队列清空', sync.getStatus().pending_allocations === 0,
    String(sync.getStatus().pending_allocations));

  section('④ 幂等键稳定：同一份变更重推是同一个键');
  sync.queueAllocation('1001', 2000000, 0, '重复提交', '999999');
  var firstKey = null;
  pushCalls = [];
  await sync.pushPending('999999');
  var p1 = pushCalls.filter(function(c) { return c.kind === 'alloc'; })[0];
  firstKey = p1 && p1.body.items[0].idem_key;
  ok('第二次推的键与第一次相同', !!firstKey && firstKey === item.idem_key,
    firstKey + ' vs ' + item.idem_key);
  sync.queueAllocation('1001', 3000000, 0, '改成 3 元', '999999');
  pushCalls = [];
  await sync.pushPending('999999');
  var p2 = pushCalls.filter(function(c) { return c.kind === 'alloc'; })[0];
  ok('金额变了则键也变（真要改时才记新的一笔）',
    p2 && p2.body.items[0].idem_key !== firstKey, p2 && p2.body.items[0].idem_key);

  section('⑤ 模型配置标脏 + 上行');
  sync.markPolicyDirty();
  ok('标脏后 pending_policy 为真', sync.getStatus().pending_policy === true);
  pushCalls = [];
  await sync.pushPending('999999');
  var polPush = pushCalls.filter(function(c) { return c.kind === 'policy'; })[0];
  ok('推了模型配置', !!polPush);
  if (polPush) {
    ok('带 models 数组', Array.isArray(polPush.body.config.models));
    ok('带 base_version 做 CAS', typeof polPush.body.base_version === 'number',
      String(polPush.body.base_version));
  }
  ok('推成功后脏标记清掉', sync.getStatus().pending_policy === false);
  ok('本地版本对齐云端返回值（下次不再空拉）',
    sync.getStatus().model_version === 6, String(sync.getStatus().model_version));

  section('⑥ 非席位班：改了也不上行，错误说人话');
  var relay2 = await startFakeRelay(function(url) {
    if (url.indexOf('/api/sync/version') >= 0) {
      return { json: { code: 200, message: 'ok', data: {
        assign_version: 3, model_config_version: 5,
        is_seat_admin: false, seat_instance: 'class-other',
        server_time: '2026-10-12 08:00:00'
      } } };
    }
    return {};
  });
  var sync2 = loadSync(baseEnv(relay2.port));
  await sync2.pollOnce();
  ok('云端说不是席位 → 本机认定只读', sync2.getStatus().is_seat_admin === false);
  sync2.queueAllocation('1001', 9999999, 0, '不该同步', '888888');
  sync2.markPolicyDirty();
  await sync2.pushPending('888888');
  ok('非席位班不会上行（面板显示「改动只在本机生效」）',
    sync2.getStatus().last_push_alloc_error.indexOf('不是管理员席位') >= 0 ||
    sync2.getStatus().last_push_policy_error.indexOf('不是管理员席位') >= 0,
    sync2.getStatus().last_push_alloc_error + ' / ' + sync2.getStatus().last_push_policy_error);
  ok('非席位班的待推项还留着（没被云端收走）',
    sync2.getStatus().pending_allocations === 1, String(sync2.getStatus().pending_allocations));
  await relay2.close();

  section('⑦ 冲突（409）：清队列 + 留人话，不无限重推');
  var relay3 = await startFakeRelay(function(url, payload) {
    if (url.indexOf('/api/sync/version') >= 0) {
      return { json: { code: 200, message: 'ok', data: {
        assign_version: 3, model_config_version: 5,
        is_seat_admin: true, seat_instance: 'class-seat',
        server_time: '2026-10-12 08:00:00'
      } } };
    }
    if (url.indexOf('/api/sync/allocations') >= 0) {
      return { status: 409, json: { code: 409, message: '云端额度已被改动（你基于 v3 编辑，当前已是 v7），请刷新后重新修改', data: { assign_version: 7 } } };
    }
    return {};
  });
  var sync3 = loadSync(baseEnv(relay3.port));
  await sync3.pollOnce();
  sync3.queueAllocation('1001', 1234567, 0, '会冲突', '999999');
  var r3 = await sync3.pushPending('999999');
  var st3 = sync3.getStatus();
  ok('冲突被识别', !!st3.last_push_alloc_error, String(st3.last_push_alloc_error));
  ok('错误是云端的人话（不是 HTTP 409）',
    st3.last_push_alloc_error.indexOf('请刷新后重新修改') > 0, st3.last_push_alloc_error);
  ok('冲突后清队列（否则会一直推一直 409）', st3.pending_allocations === 0, String(st3.pending_allocations));
  await relay3.close();

  section('⑧ 普通失败（断网）：保留队列，操作不丢');
  var relay4 = await startFakeRelay(function(url) {
    if (url.indexOf('/api/sync/version') >= 0) {
      return { json: { code: 200, message: 'ok', data: {
        assign_version: 3, model_config_version: 5,
        is_seat_admin: true, seat_instance: 'class-seat',
        server_time: '2026-10-12 08:00:00'
      } } };
    }
    if (url.indexOf('/api/sync/allocations') >= 0) return { status: 500, json: { code: 500, message: '服务器内部错误' } };
    return {};
  });
  var sync4 = loadSync(baseEnv(relay4.port));
  await sync4.pollOnce();
  sync4.queueAllocation('1001', 5550000, 0, '断网前改的', '999999');
  await sync4.pushPending('999999');
  var st4 = sync4.getStatus();
  ok('推送失败时记录了错误', !!st4.last_push_alloc_error, String(st4.last_push_alloc_error));
  ok('队列保留（管理员的操作不丢）', st4.pending_allocations === 1, String(st4.pending_allocations));
  // 再推一次：这回云端正常，应该成功并清空
  relay4.seen.length = 0;
  await relay4.close();

  await relay.close();

  console.log('\n========================================');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(function(err) {
  console.error('\n验证异常:', err && err.stack);
  process.exit(1);
});