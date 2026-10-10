// 用真实浏览器验证 Cloud.vue 的「图片加载失败 · 点此重试」兜底。
//
// 为什么需要它（两个坑都被它守住）：
//   1. 图片 <img src> 的请求没法带 Authorization 头，只能靠 cookie 鉴权。
//      —— 所以测试必须在浏览器里登录（会让浏览器保存 Set-Cookie）才真实；
//         若用 Network.setCookie 注入 token，headless 下 <img> 请求拿不到 cookie，
//         all 401，会误判成「图片加载失败」。（真实用户走登录接口，无此问题。）
//   2. 云盘图片是「列表 + <img>」结构，遇 401/404/解码失败，<img> 只会给一个
//      破图加 alt 文本。本页把它换成「图片加载失败 · 点此重试」的人话 + 重试。
//      任何一条路径回归（v-if/v-else-if 写错、onImgError 没触发、retry 没加时间戳）
//      都会让这个测试红灯。
//
// 用法：
//   node scripts/verify-cloud-img.cjs                 # 需要先起好服务端
//   CHROME_PATH=/path/to/chrome node scripts/verify-cloud-img.cjs
// 退出码 0 = 通过。
//
// 依赖：Node 22+（用内置 WebSocket 直连 CDP，不装任何 npm 包）、本机 Chrome、
//       服务端（默认 9101）。测试数据前缀 img-test.png，用后即删。

require('dotenv').config();
var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var os = require('os');

var BASE = require('./lib/target').resolve(process.env.PORT || 9101);
var UID = process.env.VERIFY_UID || '250301';
var PWD = process.env.VERIFY_PWD || 'test1234';

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  var home = os.homedir();
  var candidates = [];
  try {
    (fs.readdirSync(path.join(home, 'AppData/Local/ms-playwright')) || [])
      .filter(function(d) { return /^chromium-\d+$/.test(d); })
      .sort().reverse()
      .forEach(function(d) {
        candidates.push(path.join(home, 'AppData/Local/ms-playwright', d, 'chrome-win64', 'chrome.exe'));
      });
  } catch (e) {}
  candidates.push(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  );
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  return null;
}

function makeCdp(wsUrl) {
  var ws = new WebSocket(wsUrl);
  var id = 0, pending = {}, handlers = {};
  var ready = new Promise(function(res) { ws.onopen = res; });
  ws.onmessage = function(e) {
    var m = JSON.parse(e.data);
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; return; }
    if (m.method && handlers[m.method]) handlers[m.method](m.params || {});
  };
  function send(method, params) {
    return new Promise(function(res) {
      var myId = ++id;
      pending[myId] = res;
      ws.send(JSON.stringify({ id: myId, method: method, params: params || {} }));
    });
  }
  async function ev(expr) {
    var r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: String(r.result.exceptionDetails.text || 'JS 异常') };
    return r.result && r.result.result ? r.result.result.value : null;
  }
  function on(method, fn) { handlers[method] = fn; }
  return { ready: ready, send: send, ev: ev, on: on, close: function() { ws.close(); } };
}

async function launchBrowser(port) {
  var bin = findChrome();
  if (!bin) throw new Error('找不到浏览器，请用 CHROME_PATH 指定');
  var profile = path.join(os.tmpdir(), 'cluss-cloudimg-' + Date.now());
  var proc = childProcess.spawn(bin, [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    'about:blank'
  ], { stdio: 'ignore' });
  var wsUrl = null;
  for (var i = 0; i < 50 && !wsUrl; i++) {
    await sleep(300);
    try {
      var list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      var page = list.filter(function(t) { return t.type === 'page'; })[0];
      if (page && page.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) {}
  }
  if (!wsUrl) { proc.kill(); throw new Error('浏览器未就绪'); }
  return { proc: proc, wsUrl: wsUrl, profile: profile };
}

// 生成一张全新的有效 PNG（用 sharp，保证浏览器能解码；每次字节不同 → 新 hash，
// 避免撞上「曾上传又软删」的同内容记录导致 404，见 cloud-store.saveFile 的复活修复）。
async function tinyPng() {
  var sharp = require('sharp');
  var rr = Math.floor(Math.random() * 256);
  return sharp({
    create: { width: 6, height: 6, channels: 3, background: { r: rr, g: 30, b: 30 } }
  }).png().toBuffer();
}

// 删掉测试签名图（img-test.png），保证干净起点/终点
async function cleanupTestFiles(token) {
  try {
    var list = await (await fetch(BASE + '/api/cloud/files?limit=500', { headers: { Authorization: 'Bearer ' + token } })).json();
    var mine = (list.data.files || []).filter(function(f) { return /^img-test\.png$/.test(f.name); });
    for (var i = 0; i < mine.length; i++) {
      await fetch(BASE + '/api/cloud/files/' + mine[i].hash, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    }
    return mine.length;
  } catch (e) { return 0; }
}

(async function() {
  var pass = 0, fail = 0;
  function ok(name, cond, detail) {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
  }

  console.log('\n=== 准备 ===');
  var login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: UID, password: PWD })
  });
  var lj = await login.json();
  if (!lj.data || !lj.data.token) {
    console.error('登录失败（' + UID + '）：' + JSON.stringify(lj).slice(0, 120));
    console.error('可用 VERIFY_UID / VERIFY_PWD 指定测试账号');
    process.exit(1);
  }
  var token = lj.data.token;
  console.log('  账号 ' + UID + ' 登录成功');

  var cleaned = await cleanupTestFiles(token);
  if (cleaned) console.log('  已清理 ' + cleaned + ' 张测试残留图');

  // 上传一张真实小图
  var pngBuf = await tinyPng();
  var form = new FormData();
  form.append('file', new Blob([pngBuf], { type: 'image/png' }), 'img-test.png');
  var up = await fetch(BASE + '/api/cloud/upload', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form
  });
  var uj = await up.json();
  var uploadedHash = (uj.data && uj.data.hash) || '';
  console.log('  已上传图片：' + uploadedHash.slice(0, 12) + '...');

  var br = null, cdp = null;
  var blockedCount = 0;
  try {
    br = await launchBrowser(9339);
    cdp = makeCdp(br.wsUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    // 登录态先就位再进应用。
    // 关键：必须在浏览器里登录一次，让浏览器自己保存 Set-Cookie ——
    //   <img src> 的请求没法带 Authorization 头，只能靠 cookie 鉴权。
    //   若用 Network.setCookie 注入 token，headless 里 <img> 请求拿不到，全 401，
    //   误判成「图片加载失败」。（真实用户走登录接口，cookie 自然种上，本无此问题。）
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(1800);
    var logCfg = JSON.stringify('{"account":"' + UID + '","password":"' + PWD + '"}');
    await cdp.ev("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:" + logCfg + ",credentials:'include'});'ok'");
    await cdp.ev("localStorage.setItem('cluss_token', " + JSON.stringify(token) + "); 'ok'");
    await cdp.send('Page.reload');
    await sleep(3000);

    // ---------- 阶段 1：正常显示 ----------
    console.log('\n=== 阶段1：图片正常显示（不拦截） ===');
    await cdp.send('Page.navigate', { url: BASE + '/#/cloud' });
    await sleep(3500);
    var ok1 = await cdp.ev(
      "(function(){var imgs=[].slice.call(document.querySelectorAll('.card-img'));" +
      "var failed=document.querySelectorAll('.card-img-failed').length;" +
      "var best=imgs.reduce(function(a,b){return b.naturalWidth>a.naturalWidth?b:a;},{naturalWidth:0});" +
      "return {imgCount:imgs.length, failedCount:failed, maxNatural:best.naturalWidth};})()"
    );
    ok('云盘页加载出图片卡片', ok1 && ok1.imgCount > 0, 'imgCount=' + (ok1 && ok1.imgCount));
    ok('图片真实解码成功（naturalWidth>0）', ok1 && ok1.maxNatural > 0, 'maxNatural=' + (ok1 && ok1.maxNatural));
    ok('无失败兜底出现', ok1 && ok1.failedCount === 0, 'failedCount=' + (ok1 && ok1.failedCount));

    // ---------- 阶段 2：拦截该图 → 强制 404 ----------
    console.log('\n=== 阶段2：拦截强制 404，应出现失败兜底 ===');
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*cloud/files/' + uploadedHash + '*', requestStage: 'Request' }]
    });
    cdp.on('Fetch.requestPaused', function(p) {
      blockedCount++;
      cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 404,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
        body: Buffer.from('not found').toString('base64')
      });
    });

    // 重新加载页面，让图片重新发起请求（单纯 navigate 到同一 hash 不会重载，也不会重新请求图片）
    await cdp.send('Page.reload');
    await sleep(4500);

    var ok2 = await cdp.ev(
      "(function(){var f=document.querySelector('.card-img-failed');" +
      "return {failedCount:document.querySelectorAll('.card-img-failed').length," +
      " texts:[].slice.call(document.querySelectorAll('.card-img-failed')).map(function(e){return e.innerText.trim();})," +
      " blocked:" + blockedCount + "};})()"
    );
    ok('拦截后出现失败兜底', ok2 && ok2.failedCount > 0, 'failedCount=' + (ok2 && ok2.failedCount));
    ok('兜底文案为「图片加载失败 · 点此重试」',
      ok2 && ok2.texts.some(function(t) { return t.indexOf('图片加载失败') >= 0 && t.indexOf('重试') >= 0; }),
      JSON.stringify(ok2 && ok2.texts));
    ok('确实拦截到了图片请求', blockedCount > 0, 'blocked=' + blockedCount);

    // ---------- 阶段 3：点重试 → 应再次发请求 + 兜底重新出现 ----------
    console.log('\n=== 阶段3：点重试 ===');
    var beforeBlocked = blockedCount;
    await cdp.ev(
      "(function(){var f=document.querySelector('.card-img-failed');if(f){f.click();return 1;}return 0;})()"
    );
    await sleep(3500);
    var ok3 = await cdp.ev(
      "(function(){return {failedCount:document.querySelectorAll('.card-img-failed').length," +
      " blocked:" + blockedCount + "};})()"
    );
    ok('点重试后再次发起了图片请求', ok3 && ok3.blocked > beforeBlocked, 'blocked=' + (ok3 && ok3.blocked));
    ok('因仍失败，兜底重新出现', ok3 && ok3.failedCount > 0, 'failedCount=' + (ok3 && ok3.failedCount));

    await cdp.send('Fetch.disable');
  } catch (e) {
    fail++;
    console.error('\n[异常] ' + (e.stack || e.message));
  } finally {
    var del = await cleanupTestFiles(token);
    if (del) console.log('\n  已删除测试图片 ' + del + ' 张');
    if (cdp) cdp.close();
    if (br) { br.proc.kill(); try { fs.rmSync(br.profile, { recursive: true, force: true }); } catch (e) {} }
  }

  console.log('\n=== 结果 ===');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exitCode = fail > 0 ? 1 : 0;
})();
