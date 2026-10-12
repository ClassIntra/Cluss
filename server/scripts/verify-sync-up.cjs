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
  var allocVersion = 3;
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
      allocVersion += 1; // 云端每次成功接收都会推进版本（真实行为）
      return { json: { code: 200, message: 'ok', data: { assign_version: allocVersion, applied: payload.items.length, skipped: 0 } } };
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

  section('④ 幂等键：同一条重试稳定，新的改动必然换键');
  // 键里含云端版本号（这是「10元→5元→改回10元」不被吞的前提）。
  // 于是「同一版本内重推」才是同一笔；一旦云端版本动了，哪怕金额回到旧值，
  // 也必须是一笔新的改动。
  sync.queueAllocation('1001', 2000000, 0, '重复提交', '999999');
  var firstKey = null;
  pushCalls = [];
  await sync.pushPending('999999');
  var p1 = pushCalls.filter(function(c) { return c.kind === 'alloc'; })[0];
  firstKey = p1 && p1.body.items[0].idem_key;
  // 真正要保证的是「同一条待推项重试时键不变」——断网推失败后队列保留，
  // 下一轮重试必须是云端眼里的同一笔，否则会重复记账。
  // （拿「重新入队同一金额」来比是不对的：那是新的一笔操作，版本已推进，
  //   键本就该不同 —— 正是这一点让「改回旧值」不会被当成重放吞掉。）
  var kBefore = (sync.getStatus().pending_allocations > 0)
    ? null : null;
  ok('队列已清空（上一次推成功）', sync.getStatus().pending_allocations === 0,
    String(sync.getStatus().pending_allocations));
  sync.queueAllocation('1001', 3000000, 0, '改成 3 元', '999999');
  pushCalls = [];
  await sync.pushPending('999999');
  var p2 = pushCalls.filter(function(c) { return c.kind === 'alloc'; })[0];
  ok('金额变了则键也变（真要改时才记新的一笔）',
    p2 && p2.body.items[0].idem_key !== firstKey, p2 && p2.body.items[0].idem_key);
  // 关键场景：改回旧值。原实现（键=内容哈希）会把它当成第一次那笔的重放而跳过，
  // 于是管理员「改错了改回来」时学生额度再也回不去。
  sync.queueAllocation('1001', 2000000, 0, '改回 2 元', '999999');
  pushCalls = [];
  await sync.pushPending('999999');
  var p3 = pushCalls.filter(function(c) { return c.kind === 'alloc'; })[0];
  // 上一笔推成功后 status.assign_version 已推进（假中继每次 +1），
  // 所以「改回 2 元」入队时读到的是新版本 → 键必然不同 → 云端不会当成重放。
  ok('「改回旧值」也生成新的一笔（不被当成重放吞掉）',
    p3 && p3.body.items[0].idem_key !== firstKey,
    p3 && p3.body.items[0].idem_key + ' vs 第一次 ' + firstKey);

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
  // 重试键必须和首次一样：靠 §⑧ 推成功时用的同一个假中继拿不到键，
  // 所以这里直接比「连续两次 pushPending 发出的键」——第二次是队列未清空的同一条。
  var keys4 = [];
  var origSeen = relay4.seen;
  await sync4.pushPending('999999');
  var last4 = origSeen.filter(function(x) { return x.url.indexOf('/api/sync/allocations') >= 0; }).pop();
  var first4 = origSeen.filter(function(x) { return x.url.indexOf('/api/sync/allocations') >= 0; })[0];
  ok('同一条待推项重试时幂等键不变（不会重复记账）',
    !!(first4 && last4) && first4.body.items[0].idem_key === last4.body.items[0].idem_key,
    (first4 && first4.body.items[0].idem_key) + ' vs ' + (last4 && last4.body.items[0].idem_key));
  await relay4.close();

  section('⑨ 云端空配置不清空本机模型（这是丢过数据的 bug）');
  // 云端从未发布过配置（v0）+ 列表为空 —— 平台还没配模型时就是这个状态。
  // applySnapshot 是整表替换（先 DELETE 再插），无脑下发空快照会把本机配置全清空。
  var relay5 = await startFakeRelay(function(url) {
    if (url.indexOf('/api/sync/version') >= 0) {
      return { json: { code: 200, message: 'ok', data: {
        assign_version: 3, model_config_version: 0,
        is_seat_admin: true, seat_instance: 'class-seat',
        server_time: '2026-10-12 08:00:00'
      } } };
    }
    if (url.indexOf('/api/sync/model-config') >= 0) {
      return { json: { code: 200, message: 'ok', data: {
        model_config_version: 0, models: [], sources: [], meta: {}
      } } };
    }
    return {};
  });
  // 直接验 fetchModelConfig 的判定：先给 ai_models 塞一行「本机已有配置」
  var relay6 = await startFakeRelay(function(url) {
    if (url.indexOf('/api/sync/version') >= 0) {
      return { json: { code: 200, message: 'ok', data: {
        assign_version: 3, model_config_version: 0,
        is_seat_admin: true, seat_instance: 'class-seat',
        server_time: '2026-10-12 08:00:00'
      } } };
    }
    if (url.indexOf('/api/sync/model-config') >= 0) {
      return { json: { code: 200, message: 'ok', data: {
        model_config_version: 0, models: [], sources: [], meta: {}
      } } };
    }
    return {};
  });
  var sync5 = loadSync(baseEnv(relay6.port));
  // 造一个本机模型（走 db 依赖，需要 sync 已加载）
  var dbMod = require(path.join(SERVER_DIR, 'src', 'utils', 'db.js'));
  dbMod.prepare([
    'INSERT OR REPLACE INTO ai_models (id, label, api_url, api_key, model_name, api_style,',
    '  price_in, price_out, price_cache_hit, is_free, enabled, is_default, sort_order, created_at)',
    "VALUES ('keepme', '要保住的模型', 'http://127.0.0.1:9200', 'sk-x', 'keepme', 'openai',",
    '  2000, 8000, 200, 0, 1, 1, 0, ?)'
  ].join('\n')).run('2026-10-12 08:00:00');
  ok('本机先有一个模型', dbMod.prepare('SELECT COUNT(*) AS c FROM ai_models').get().c === 1);

  await sync5.pollOnce(true);
  var kept = dbMod.prepare('SELECT id FROM ai_models').get();
  ok('云端 v0 空配置不会清空本机模型', kept && kept.id === 'keepme',
    '本机现有: ' + JSON.stringify(kept));
  ok('状态里标出云端尚未接管', sync5.getStatus().model_version === 0,
    String(sync5.getStatus().model_version));
  // 清理，别污染后续运行
  dbMod.prepare("DELETE FROM ai_models WHERE id = 'keepme'").run();
  await relay5.close();
  await relay6.close();

  section('⑩ 本机推的版本不再回拉覆盖');
  // 云端那一份就是本机推上去的 → 回拉等于把自己覆盖自己，白折腾且有机会覆盖错
  var relay7 = await startFakeRelay(function(url) {
    if (url.indexOf('/api/sync/version') >= 0) {
      return { json: { code: 200, message: 'ok', data: {
        assign_version: 3, model_config_version: 5,
        is_seat_admin: true, seat_instance: 'class-seat',
        server_time: '2026-10-12 08:00:00'
      } } };
    }
    if (url.indexOf('/api/sync/policy') >= 0) {
      return { json: { code: 200, message: 'ok', data: { model_config_version: 9 } } };
    }
    if (url.indexOf('/api/sync/allocations') >= 0) {
      return { json: { code: 200, message: 'ok', data: { assign_version: 11, applied: 1, skipped: 0 } } };
    }
    if (url.indexOf('/api/sync/model-config') >= 0) {
      return { json: { code: 200, message: 'ok', data: {
        model_config_version: 9, models: [], sources: [], meta: {}
      } } };
    }
    if (url.indexOf('/api/sync/assignments') >= 0) {
      return { json: { code: 200, message: 'ok', data: { assign_version: 11, assignments: [] } } };
    }
    return {};
  });
  var sync7 = loadSync(baseEnv(relay7.port));
  await sync7.pollOnce();
  sync7.markPolicyDirty();
  sync7.queueAllocation('1001', 4242000, 0, '本机推的', '999999');
  await sync7.pushPending('999999');
  var st7 = sync7.getStatus();
  ok('记住本机推的模型版本', st7.self_pushed_model_version === 9, String(st7.self_pushed_model_version));
  ok('记住本机推的额度版本', st7.self_pushed_assign_version === 11, String(st7.self_pushed_assign_version));
  // 云端现在回 v9（就是本机推的），模型列表为空 —— 若无保护就会被清空
  dbMod.prepare([
    'INSERT OR REPLACE INTO ai_models (id, label, api_url, api_key, model_name, api_style,',
    '  price_in, price_out, price_cache_hit, is_free, enabled, is_default, sort_order, created_at)',
    "VALUES ('keepme2', '要保住的模型2', 'http://127.0.0.1:9200', 'sk-x', 'keepme2', 'openai',",
    '  2000, 8000, 200, 0, 1, 1, 0, ?)'
  ].join('\n')).run('2026-10-12 08:00:00');
  await sync7.pollOnce(true);
  var kept2 = dbMod.prepare('SELECT id FROM ai_models').get();
  ok('回拉时跳过自己推的版本，模型保住', kept2 && kept2.id === 'keepme2', JSON.stringify(kept2));
  dbMod.prepare("DELETE FROM ai_models WHERE id = 'keepme2'").run();
  await relay7.close();

  await relay.close();

  console.log('\n========================================');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(function(err) {
  console.error('\n验证异常:', err && err.stack);
  process.exit(1);
});