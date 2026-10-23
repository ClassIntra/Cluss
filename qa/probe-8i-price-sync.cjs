// 探针：8 班（本班自选档）真机端到端 —— 中枢调价必须到，本班改动必须留
//
// 场景（这就是用户说的「单价什么的也有同步」）：
//   1) 8 班把某个模型的显示名改成「本班改名」→ 该字段归本班
//   2) 中枢随后把这个模型的倍率从 ×1.00 调到 ×1.25
//   3) 8 班下一轮同步后：显示名仍是「本班改名」**且**倍率变成 ×1.25
//      —— 033 那版会整行冻结，倍率永远停在 1.00
//   4) 复原：中枢倍率改回 ×1.00、8 班显示名改回原名
//
// 用法：node qa/probe-8i-price-sync.cjs
var http = require('http');

var NODE_HOST = '100.115.93.90';
var NODE_PORT = 9003;
var HUB = { host: '127.0.0.1', port: 9003 };

var NODE_ACC = '999999';
var NODE_PWD = 'MkN7e3i8N2Ng';
var HUB_ACC = '999999';
var HUB_PWD = '';

var fs = require('fs');
var path = require('path');
var envText = fs.readFileSync(path.resolve(__dirname, '../server/.env'), 'utf8');
HUB_PWD = ((envText.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1] || '').trim();

var TARGET = 'glm-5.3-flash';
var LOCAL_LABEL = '本班改名-' + Date.now().toString().slice(-5);

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ('  → ' + JSON.stringify(extra)))); }
}
function req(where, method, p, body, token) {
  return new Promise(function(resolve) {
    var data = body ? JSON.stringify(body) : null;
    var headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (token) headers.Authorization = 'Bearer ' + token;
    var r = http.request({
      host: where.host, port: where.port, path: p, method: method, headers: headers, timeout: 15000
    }, function(res) {
      var b = '';
      res.on('data', function(d) { b += d; });
      res.on('end', function() {
        try { var j = JSON.parse(b); j.__status = res.statusCode; resolve(j); }
        catch (e) { resolve({ __status: res.statusCode, raw: b.slice(0, 300) }); }
      });
    });
    r.on('error', function(e) { resolve({ error: e.message }); });
    r.on('timeout', function() { r.destroy(); resolve({ error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function findModel(list, id) {
  for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i];
  return null;
}

(async function main() {
  console.log('=== 8 班真机：中枢调价下发 vs 本班改动保留 ===\n');

  var hubLogin = await req(HUB, 'POST', '/api/auth/login', { account: HUB_ACC, password: HUB_PWD });
  var hubToken = (hubLogin.data && hubLogin.data.token) || '';
  if (!hubToken) { console.log('中枢登录失败'); process.exit(1); }

  var nodeLogin = await req({ host: NODE_HOST, port: NODE_PORT }, 'POST', '/api/auth/login',
    { account: NODE_ACC, password: NODE_PWD });
  var nodeToken = (nodeLogin.data && nodeLogin.data.token) || '';
  if (!nodeToken) { console.log('8 班登录失败: ' + JSON.stringify(nodeLogin).slice(0, 200)); process.exit(1); }

  var nodeBase = { host: NODE_HOST, port: NODE_PORT };

  // ---- 0. 基线 ----
  var nm = await req(nodeBase, 'GET', '/api/admin/models', null, nodeToken);
  var nd = nm.data || {};
  ok('8 班 model_sync = 2（本班自选）', Number(nd.model_sync) === 2, nd.model_sync);
  ok('8 班 local_only = true', nd.local_only === true, nd.local_only);
  var m0 = findModel(nd.models, TARGET);
  ok('目标模型存在：' + TARGET, !!m0);
  if (!m0) process.exit(1);
  console.log('    基线：label=' + m0.label + '  倍率=×' + m0.price_multiplier + '  origin=' + m0.origin);

  var hubM0 = findModel((await req(HUB, 'GET', '/api/admin/models', null, hubToken)).data.models, TARGET);
  var hubMult0 = hubM0.price_multiplier;
  var origLabel = m0.label;
  console.log('    中枢基线倍率 = ×' + hubMult0);

  try {
    // ---- 1. 8 班改显示名（本班字段）----
    var e1 = await req(nodeBase, 'PUT', '/api/admin/models/' + encodeURIComponent(TARGET),
      { label: LOCAL_LABEL }, nodeToken);
    ok('8 班改显示名成功', e1.__status === 200, [e1.__status, e1.message]);
    await sleep(600);
    var after1 = findModel((await req(nodeBase, 'GET', '/api/admin/models', null, nodeToken)).data.models, TARGET);
    ok('8 班本地已生效', after1.label === LOCAL_LABEL, after1.label);
    ok('该行标成本班所有（origin=local）', after1.origin === 'local', after1.origin);
    ok('偏离字段 = 1 项', after1.local_change_count === 1, after1.local_change_count);

    // ---- 2. 中枢调倍率（单价类字段）----
    var newMult = Math.abs(Number(hubMult0) - 1.25) < 0.001 ? 1.5 : 1.25;
    var e2 = await req(HUB, 'PUT', '/api/admin/models/' + encodeURIComponent(TARGET),
      { price_multiplier: newMult }, hubToken);
    ok('中枢调倍率为 ×' + newMult + ' 成功', e2.__status === 200, [e2.__status, e2.message]);

    // ---- 3. 等 8 班下一轮同步（≤75s）----
    console.log('    等待 8 班同步（最多 80 秒）…');
    var got = null;
    for (var i = 0; i < 16; i++) {
      await sleep(5000);
      var cur = findModel((await req(nodeBase, 'GET', '/api/admin/models', null, nodeToken)).data.models, TARGET);
      if (cur && Math.abs(Number(cur.price_multiplier) - newMult) < 0.001) { got = cur; break; }
      process.stdout.write('    · ' + (i + 1) * 5 + 's 倍率仍为 ×' + (cur ? cur.price_multiplier : '?') + '\n');
    }

    ok('中枢的新倍率已下发到 8 班（×' + newMult + '）', !!got, got && got.price_multiplier);
    if (got) {
      ok('本班改过的显示名没有被冲掉', got.label === LOCAL_LABEL, got.label);
      ok('仍未跟中枢的只有 label 一项', got.local_change_count === 1
        && got.local_fields.length === 1 && got.local_fields[0] === 'label', got.local_fields);
    }

    // ---- 4. 恢复跟随：整行回到中枢 ----
    var e4 = await req(nodeBase, 'POST', '/api/admin/models/' + encodeURIComponent(TARGET) + '/follow', {}, nodeToken);
    ok('8 班「恢复跟随」调用成功', e4.__status === 200, [e4.__status, e4.message]);

    console.log('    等待恢复跟随生效（最多 60 秒）…');
    var back = null;
    for (var j = 0; j < 12; j++) {
      await sleep(5000);
      var c2 = findModel((await req(nodeBase, 'GET', '/api/admin/models', null, nodeToken)).data.models, TARGET);
      if (c2 && c2.label !== LOCAL_LABEL) { back = c2; break; }
    }
    ok('恢复跟随把显示名改回中枢的「' + origLabel + '」', !!back, back && back.label);
    if (back) ok('恢复后偏离清零', back.local_change_count === 0, back.local_change_count);

  } finally {
    // ---- 5. 复原中枢倍率（无论上面成败都要还原）----
    var rev = await req(HUB, 'PUT', '/api/admin/models/' + encodeURIComponent(TARGET),
      { price_multiplier: hubMult0 }, hubToken);
    ok('中枢倍率已还原 ×' + hubMult0, rev.__status === 200, [rev.__status, rev.message]);
  }

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
