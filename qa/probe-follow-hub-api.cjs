// 探针：迁移 034 的接口面（中枢侧）
//
// 只读为主：GET /admin/models 必须带出 local_fields / has_hub_base，
// 且「恢复跟随」在中枢本机要被明确拒绝（它自己就是权威源）。
var http = require('http');
var fs = require('fs');
var path = require('path');

var SERVER_DIR = path.resolve(__dirname, '..', 'server');
var envText = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
var ACC = ((envText.match(/^ADMIN_USER_ID=(.*)$/m) || [])[1] || '999999').trim();
var PWD = ((envText.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1] || '').trim();

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ('  → ' + JSON.stringify(extra)))); }
}
function api(method, p, body, token) {
  return new Promise(function(resolve) {
    var data = body ? JSON.stringify(body) : null;
    var headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (token) headers.Authorization = 'Bearer ' + token;
    var r = http.request({ host: '127.0.0.1', port: 9003, path: p, method: method, headers: headers }, function(res) {
      var b = '';
      res.on('data', function(d) { b += d; });
      res.on('end', function() {
        try { var j = JSON.parse(b); j.__status = res.statusCode; resolve(j); }
        catch (e) { resolve({ __status: res.statusCode, raw: b.slice(0, 200) }); }
      });
    });
    r.on('error', function(e) { resolve({ error: e.message }); });
    if (data) r.write(data);
    r.end();
  });
}

(async function main() {
  console.log('=== 中枢侧接口面（迁移 034）===\n');

  var login = await api('POST', '/api/auth/login', { account: ACC, password: PWD });
  var token = (login.data && login.data.token) || '';
  if (!token) { console.log('登录失败: ' + JSON.stringify(login).slice(0, 200)); process.exit(1); }

  var m = await api('GET', '/api/admin/models', null, token);
  var d = m.data || {};
  ok('GET /admin/models 200', m.__status === 200, m.__status);
  ok('中枢 model_sync = 1', Number(d.model_sync) === 1, d.model_sync);
  ok('中枢 local_only = false（本机就是权威）', d.local_only === false, d.local_only);
  ok('模型带 local_fields 数组', Array.isArray(d.models) && Array.isArray(d.models[0].local_fields), d.models && d.models[0]);
  ok('模型带 has_hub_base 布尔', typeof (d.models[0] || {}).has_hub_base === 'boolean', (d.models[0] || {}).has_hub_base);
  ok('源带 local_fields', Array.isArray((d.sources[0] || {}).local_fields), d.sources && d.sources[0]);
  ok('base_model 三档单价齐全', !!d.base_model
    && d.base_model.price_in !== undefined && d.base_model.price_out !== undefined
    && d.base_model.price_cache_hit !== undefined, d.base_model);

  // 中枢本机不该有「恢复跟随」—— 它没有上游
  var id = d.models && d.models[0] && d.models[0].id;
  var f1 = await api('POST', '/api/admin/models/' + encodeURIComponent(id) + '/follow', {}, token);
  ok('中枢上「恢复跟随」被拒（400）', f1.__status === 400, [f1.__status, f1.message]);
  var f2 = await api('POST', '/api/admin/model-config/follow-all', {}, token);
  ok('中枢上「全部恢复」被拒（400）', f2.__status === 400, [f2.__status, f2.message]);

  // 不存在的 id（node 模式才走到 404；中枢上会先被 400 拦下）
  var f3 = await api('POST', '/api/admin/models/__nope__/follow', {}, token);
  ok('不存在的模型不会 200', f3.__status === 400 || f3.__status === 404, f3.__status);

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
