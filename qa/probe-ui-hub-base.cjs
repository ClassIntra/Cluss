// UI 探针：中枢「模型与单价」页在迁移 034 后没有回归
//
// 中枢本机不是节点：不该出现「本班改过 N 项」徽标、也不该有「恢复跟随」按钮。
// 这些元素在 8 班（本班自选档）才该出现 —— 那边的断言由 8i 侧探针负责。
var http = require('http');
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var os = require('os');

var SERVER_DIR = path.resolve(__dirname, '..', 'server');
var envText = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
var ACC = ((envText.match(/^ADMIN_USER_ID=(.*)$/m) || [])[1] || '999999').trim();
var PWD = ((envText.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1] || '').trim();

var CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
var PORT = 9361;
var PROFILE = path.join(os.tmpdir(), 'cluss-cdp-hub034-' + Date.now());

var pass = 0, fail = 0;
function check(name, actual, expected) {
  var ok = String(actual) === String(expected);
  if (ok) { pass++; console.log('  ✓ ' + name + ' = ' + actual); }
  else { fail++; console.log('  ✗ ' + name + ' 期望 ' + expected + '，实际 ' + actual); }
}
function truthy(name, v) {
  if (v) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + ' → ' + JSON.stringify(v)); }
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
      res.on('end', function() { try { resolve(JSON.parse(b)); } catch (e) { resolve({ raw: b }); } });
    });
    r.on('error', function(e) { resolve({ error: e.message }); });
    if (data) r.write(data);
    r.end();
  });
}
function getJson(url) {
  return new Promise(function(resolve, reject) {
    http.get(url, function(res) {
      var b = '';
      res.on('data', function(d) { b += d; });
      res.on('end', function() { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function CDP(wsUrl) {
  var self = this;
  this.id = 0;
  this.pending = {};
  this.ws = new WebSocket(wsUrl);
  this.ready = new Promise(function(resolve, reject) {
    self.ws.addEventListener('open', function() { resolve(); });
    self.ws.addEventListener('error', function() { reject(new Error('ws error')); });
  });
  this.ws.addEventListener('message', function(ev) {
    var msg = JSON.parse(ev.data);
    if (msg.id && self.pending[msg.id]) {
      var cb = self.pending[msg.id];
      delete self.pending[msg.id];
      cb(msg.result || { __error: msg.error });
    }
  });
}
CDP.prototype.send = function(method, params) {
  var self = this;
  var id = ++this.id;
  return new Promise(function(resolve) {
    self.pending[id] = resolve;
    self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
};

(async function main() {
  console.log('=== 中枢「模型与单价」页（迁移 034 后无回归）===\n');

  var login = await api('POST', '/api/auth/login', { account: ACC, password: PWD });
  var token = (login.data && login.data.token) || '';
  var user = (login.data && login.data.user_info) || {};
  if (!token) { console.log('登录失败'); process.exit(1); }

  var child = cp.spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server',
    '--proxy-bypass-list=*',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  var ver = null;
  for (var i = 0; i < 25; i++) {
    await sleep(400);
    try { ver = await getJson('http://127.0.0.1:' + PORT + '/json/version'); break; } catch (e) {}
  }
  if (!ver) { console.log('Chrome 未就绪'); child.kill(); process.exit(1); }

  var tab = await new Promise(function(resolve, reject) {
    var r = http.request({ host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' }, function(res) {
      var b = ''; res.on('data', function(d) { b += d; }); res.on('end', function() { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.end();
  });

  var cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:9003/' });
  await sleep(2000);
  await cdp.send('Runtime.evaluate', {
    expression: 'localStorage.setItem("cluss_token", ' + JSON.stringify(token) + ');' +
      'localStorage.setItem("cluss_user", ' + JSON.stringify(JSON.stringify(user)) + ');',
    returnByValue: true
  });

  async function evaluate(expr) {
    var r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (!r || r.__error) { console.log('    [CDP 错误] ' + JSON.stringify(r).slice(0, 200)); return undefined; }
    if (r.exceptionDetails) { console.log('    [JS 异常] ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return undefined; }
    return r.result ? r.result.value : undefined;
  }

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:9003/?hb034=1#/admin' });
  await sleep(4500);

  var clicked = await evaluate([
    '(function(){',
    'var bs = document.querySelectorAll("button, .tab");',
    'for (var i=0;i<bs.length;i++){',
    '  var t=(bs[i].textContent||"").trim();',
    '  if (t==="模型与单价"){ bs[i].click(); return t; }',
    '}',
    'return "NOT_FOUND";',
    '})()'
  ].join(''));
  check('切到「模型与单价」tab', clicked, '模型与单价');
  await sleep(2500);

  var st = await evaluate([
    '(function(){',
    'var rows = document.querySelectorAll(".table tbody tr");',
    'var warn = [], follow = [];',
    'var badges = document.querySelectorAll(".badge-warning");',
    'for (var i=0;i<badges.length;i++){ var t=(badges[i].textContent||"").trim(); if (t.indexOf("本班改过")>=0) warn.push(t); }',
    'var bs = document.querySelectorAll("button");',
    'for (var j=0;j<bs.length;j++){',
    '  var tx=(bs[j].textContent||"").trim();',
    '  if (tx==="恢复跟随" || tx.indexOf("全部恢复跟随中枢")>=0) follow.push(tx);',
    '}',
    'return {rows: rows.length, warn: warn, follow: follow,',
    '        title: (document.querySelector(".panel-title")||{}).textContent || "",',
    '        bodyLen: (document.body.innerText||"").length};',
    '})()'
  ].join(''));

  truthy('模型表格有行（' + (st && st.rows) + '）', st && st.rows > 0);
  check('中枢不显示「本班改过」徽标', st && st.warn.length, 0);
  check('中枢不显示「恢复跟随」按钮', st && st.follow.length, 0);
  truthy('页面有内容（非白屏）', st && st.bodyLen > 200);

  var s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  var p = path.resolve(__dirname, 'hub-034-models.png');
  fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log('    截图 → ' + path.basename(p));

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  try { child.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
