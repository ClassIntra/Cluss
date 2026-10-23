// UI 探针：8 班（本班自选档）的「本班改过 N 项」徽标与「恢复跟随」按钮
//
// 前置：中枢侧已开 ssh -L 19120:127.0.0.1:9003 cideploy@100.115.93.90
// （headless Chrome 对非 localhost 的非安全上下文会白屏，必须走本地回环）
var http = require('http');
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var os = require('os');

var HOST = '127.0.0.1', PORT_APP = 19120;
var ACC = '999999', PWD = 'MkN7e3i8N2Ng';
var TARGET = 'glm-5.3-flash';

var CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
var CDP_PORT = 9371;
var PROFILE = path.join(os.tmpdir(), 'cluss-cdp-8i034-' + Date.now());

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
    var r = http.request({ host: HOST, port: PORT_APP, path: p, method: method, headers: headers, timeout: 15000 }, function(res) {
      var b = '';
      res.on('data', function(d) { b += d; });
      res.on('end', function() { try { resolve(JSON.parse(b)); } catch (e) { resolve({ raw: b.slice(0, 200) }); } });
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
  this.id = 0; this.pending = {};
  this.ws = new WebSocket(wsUrl);
  this.ready = new Promise(function(resolve, reject) {
    self.ws.addEventListener('open', function() { resolve(); });
    self.ws.addEventListener('error', function() { reject(new Error('ws error')); });
  });
  this.ws.addEventListener('message', function(ev) {
    var msg = JSON.parse(ev.data);
    if (msg.id && self.pending[msg.id]) { var cb = self.pending[msg.id]; delete self.pending[msg.id]; cb(msg.result || { __error: msg.error }); }
  });
}
CDP.prototype.send = function(method, params) {
  var self = this; var id = ++this.id;
  return new Promise(function(resolve) { self.pending[id] = resolve; self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); });
};

(async function main() {
  console.log('=== 8 班「模型与单价」页：本班改过徽标 + 恢复跟随 ===\n');

  var login = await api('POST', '/api/auth/login', { account: ACC, password: PWD });
  var token = (login.data && login.data.token) || '';
  var user = (login.data && login.data.user_info) || {};
  if (!token) { console.log('8 班登录失败: ' + JSON.stringify(login).slice(0, 200)); process.exit(1); }

  var before = await api('GET', '/api/admin/models', null, token);
  var target0 = (before.data.models || []).filter(function(m) { return m.id === TARGET; })[0];
  console.log('    当前 ' + TARGET + ': 偏离 ' + (target0 ? target0.local_change_count : '?') + ' 项');

  var child = cp.spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server', '--proxy-bypass-list=*',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE, '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore', detached: false });

  var ver = null;
  for (var i = 0; i < 25; i++) { await sleep(400); try { ver = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/version'); break; } catch (e) {} }
  if (!ver) { console.log('Chrome 未就绪'); child.kill(); process.exit(1); }

  var tab = await new Promise(function(resolve, reject) {
    var r = http.request({ host: '127.0.0.1', port: CDP_PORT, path: '/json/new?about:blank', method: 'PUT' }, function(res) {
      var b = ''; res.on('data', function(d) { b += d; }); res.on('end', function() { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.end();
  });

  var cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  var ORIGIN = 'http://127.0.0.1:' + PORT_APP;
  await cdp.send('Page.navigate', { url: ORIGIN + '/' });
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
  // 每次都带一个变化的 query：同一个 URL（含 hash）的 Page.navigate 会被当成
  // 同文档跳转，**不会重新加载**，于是页面还是改之前那份数据 —— 断言看着失败，
  // 其实只是没刷新（实测踩到）。
  async function gotoTab(nonce) {
    await cdp.send('Page.navigate', { url: ORIGIN + '/?hb034=' + nonce + '#/admin' });
    await sleep(4500);
    var clicked = await evaluate([
      '(function(){var bs=document.querySelectorAll("button,.tab");',
      'for(var i=0;i<bs.length;i++){var t=(bs[i].textContent||"").trim();if(t==="模型与单价"){bs[i].click();return t;}}',
      'return "NOT_FOUND";})()'
    ].join(''));
    await sleep(2500);
    return clicked;
  }
  // 只看**模型表**（页面第一个 .table）：
  // 8 班的 Zen-gate 源上有一把自己的 Key（本班真实存在的历史改动），
  // 它会让「源」表出现一个「本班改过 1 项」徽标 —— 那是正确的，不该算进模型表断言。
  function scanExpr() {
    return [
      '(function(){',
      'var tables=document.querySelectorAll(".table");',
      'var t0=tables[0];',
      'if(!t0) return {rows:0,warn:[],follow:[],tip:""};',
      'var rows=t0.querySelectorAll("tbody tr");',
      'var warn=[], tip="", follow=[];',
      'var badges=t0.querySelectorAll(".badge-warning");',
      'for(var i=0;i<badges.length;i++){var tx=(badges[i].textContent||"").trim();',
      '  if(tx.indexOf("本班改过")>=0){warn.push(tx); if(!tip) tip=badges[i].getAttribute("title")||"";}}',
      'var bs=t0.querySelectorAll("button");',
      'for(var j=0;j<bs.length;j++){if((bs[j].textContent||"").trim()==="恢复跟随")follow.push(1);}',
      'return {rows:rows.length,warn:warn,follow:follow,tip:tip};',
      '})()'
    ].join('');
  }

  // ---- A. 当前没有本班改动：不该出现徽标 ----
  var clicked = await gotoTab("a1");
  check('切到「模型与单价」tab', clicked, '模型与单价');
  var stA = await evaluate(scanExpr());
  truthy('表格有行（' + (stA && stA.rows) + '）', stA && stA.rows > 0);
  check('无本班改动时不显示「本班改过」', stA && stA.warn.length, 0);
  check('无本班改动时不显示「恢复跟随」', stA && stA.follow.length, 0);

  // ---- B. 造一个本班改动，再看徽标与按钮 ----
  var LOCAL_LABEL = '本班改名UI-' + Date.now().toString().slice(-4);
  await api('PUT', '/api/admin/models/' + encodeURIComponent(TARGET), { label: LOCAL_LABEL }, token);
  await sleep(800);

  await gotoTab("b1" + Date.now().toString().slice(-4));
  var stB = await evaluate(scanExpr());
  check('改过后出现「本班改过 N 项」徽标', stB && stB.warn.length, 1);
  console.log('    徽标文案：' + (stB && stB.warn[0]));
  check('出现「恢复跟随」按钮', stB && stB.follow.length, 1);

  var tip = (stB && stB.tip) || '';
  truthy('徽标 tooltip 说明了改过的字段名', tip.indexOf('显示名') >= 0, tip);

  var s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  var p = path.resolve(__dirname, '8i-034-local-badge.png');
  fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log('    截图 → ' + path.basename(p));

  // ---- C. 还原 ----
  var list = await api('GET', '/api/admin/models', null, token);
  var t2 = (list.data.models || []).filter(function(m) { return m.id === TARGET; })[0];
  await api('POST', '/api/admin/models/' + encodeURIComponent(TARGET) + '/follow', {}, token);
  console.log('    （已调用恢复跟随，' + TARGET + ' 回到中枢版本；改名前 label=' + (t2 && t2.label) + '）');

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  try { child.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
