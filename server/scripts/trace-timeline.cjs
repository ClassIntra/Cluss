/**
 * 冷加载完整时间线：LCP 到底在等什么
 *
 * 背景：用户实测 LCP 2.74s（本地）。我修掉了主线程占用（-91%），
 * 但 LCP 纹丝不动 —— 说明瓶颈根本不在主线程，在别处。
 * 猜是没用的，把所有事件摆到同一条时间轴上看。
 *
 * 采什么：
 *   - 网络事件（请求发起 / 响应头 / 响应体完成），带 CDP 单调时间戳
 *   - FCP / LCP（PerformanceObserver）
 *   - DOMContentLoaded / load
 * 输出：按时间排序的事件表 + 「LCP 在等谁」的判定。
 *
 * 跑法：node server/scripts/trace-timeline.cjs [baseUrl] [hashPath]
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:9058';
const PAGE = process.argv[3] || '#/';
const PORT = Number(process.env.CDP_PORT || 9460);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const THROTTLE = Number(process.env.CPU_THROTTLE || 0);  // 默认不降速：对齐用户的实测条件

function get(u) {
  return new Promise(function (res, rej) {
    http.get(u, function (r) { let d = ''; r.on('data', function (c) { d += c; }); r.on('end', function () { res(d); }); }).on('error', rej);
  });
}
function conn(u) {
  const ws = new WebSocket(u); const P = new Map(); let id = 0;
  ws.addEventListener('message', function (ev) {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && P.has(m.id)) { const r = P.get(m.id); P.delete(m.id); m.error ? r.reject(new Error(m.error.message)) : r.resolve(m.result); }
    else if (m.method) { if (onEvent) onEvent(m); }
  });
  let onEvent = null;
  function send(me, pa) {
    const i = ++id;
    return new Promise(function (res, rej) {
      const t = setTimeout(function () { P.delete(i); rej(new Error('CDP 超时 ' + me)); }, 40000);
      P.set(i, { resolve: function (v) { clearTimeout(t); res(v); }, reject: function (e) { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id: i, method: me, params: pa || {} }));
    });
  }
  return {
    ws: ws, send: send,
    set onEvent(fn) { onEvent = fn; },
    open: new Promise(function (r) { ws.addEventListener('open', r); })
  };
}

(async function () {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await new Promise(function (r) { setTimeout(r, 500); });
    try { await get('http://127.0.0.1:' + PORT + '/json/version'); break; } catch (e) {}
  }
  const ts = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
  const c = conn(ts.find(function (t) { return t.type === 'page'; }).webSocketDebuggerUrl);
  await c.open;
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (THROTTLE > 1) await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  // ---- 收集网络事件（CDP 的 timestamp 是单调秒，与 performance.now 同源近似）----
  var netEvents = [];
  var urlNames = {};
  c.onEvent = function (m) {
    var p = m.params || {};
    if (m.method === 'Network.requestWillBeSent') {
      urlNames[p.requestId] = (p.request.url || '').replace(BASE, '');
      netEvents.push({ ts: p.timestamp, kind: 'req', id: p.requestId, url: urlNames[p.requestId], type: p.type || '' });
    } else if (m.method === 'Network.responseReceived') {
      netEvents.push({ ts: p.timestamp, kind: 'resp', id: p.requestId, url: urlNames[p.requestId], status: p.response.status, type: p.type || '' });
    } else if (m.method === 'Network.loadingFinished') {
      netEvents.push({ ts: p.timestamp, kind: 'done', id: p.requestId, url: urlNames[p.requestId] });
    }
  };

  // 登录（在被测页之前，另开一次导航）
  await c.send('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 3200); });
  function E(e, a) {
    return c.send('Runtime.evaluate', { expression: e, awaitPromise: !!a, returnByValue: true })
      .then(function (r) { return r.result && r.result.value; });
  }
  var acct = process.env.SETUP_ACCOUNT || 'uitester';
  var tok = await E("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:" + JSON.stringify(acct) + ",password:'Test1234'})}).then(r=>r.json()).then(j=>j&&j.data?j.data.token:'')", true);
  if (!tok || String(tok).length < 100) {
    console.error('登录失败（token 长度 ' + String(tok).length + '），无法继续');
    c.ws.close(); ch.kill();
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
    process.exit(2);
  }
  var userJson = await E("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:" + JSON.stringify(acct) + ",password:'Test1234'})}).then(r=>r.json()).then(j=>JSON.stringify(j.data.user_info))", true);
  await E("localStorage.setItem('cluss_token'," + JSON.stringify(tok) + ");localStorage.setItem('token'," + JSON.stringify(tok) + ");localStorage.setItem('cluss_user'," + JSON.stringify(userJson) + ")");

  // LCP / FCP 观察器：导航前注入
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: [
    "(function(){",
    " window.__marks = [];",
    " try { new PerformanceObserver(function(l){",
    "   l.getEntries().forEach(function(e){",
    "     window.__marks.push({kind:'LCP', t:e.startTime, tag:(e.element?(e.element.tagName+'.'+String(e.element.className).split(' ').slice(0,2).join('.')):'')});",
    "   });",
    " }).observe({type:'largest-contentful-paint', buffered:true}); } catch(e){}",
    " try { new PerformanceObserver(function(l){",
    "   l.getEntries().forEach(function(e){ if(e.name==='first-contentful-paint') window.__marks.push({kind:'FCP', t:e.startTime}); });",
    " }).observe({type:'paint', buffered:true}); } catch(e){}",
    "})"
  ].join('\n') });

  // ★ 全新导航（冷）
  await c.send('Page.navigate', { url: 'about:blank' });
  await new Promise(function (r) { setTimeout(r, 400); });
  netEvents = [];
  var t0Sec = null;
  c.onEvent = function (m) {
    var p = m.params || {};
    if (t0Sec === null && m.method === 'Network.requestWillBeSent') t0Sec = p.timestamp;
    if (m.method === 'Network.requestWillBeSent') {
      urlNames[p.requestId] = (p.request.url || '').replace(BASE, '');
      netEvents.push({ ts: p.timestamp, kind: 'req', id: p.requestId, url: urlNames[p.requestId], type: p.type || '' });
    } else if (m.method === 'Network.responseReceived') {
      netEvents.push({ ts: p.timestamp, kind: 'resp', id: p.requestId, url: urlNames[p.requestId], status: p.response.status, type: p.type || '' });
    } else if (m.method === 'Network.loadingFinished') {
      netEvents.push({ ts: p.timestamp, kind: 'done', id: p.requestId, url: urlNames[p.requestId] });
    }
  };

  // ⚠️ URL 拼接：PAGE 以 # 开头，直接 BASE + PAGE ——
  //   之前写成 BASE + '/' + PAGE 会得到 `...:9058//#/`，
  //   在某些路径下行为与预期不符，且难以察觉。
  await c.send('Page.navigate', { url: BASE + PAGE });
  // LCP 观察器在导航**之后**立刻注入也能拿到全部历史条目 ——
  // buffered:true 会把注册前发生的条目一并交出来，
  // 这比 addScriptToEvaluateOnNewDocument 可靠（实测后者在本次场景没触发）。
  await new Promise(function (r) { setTimeout(r, 60); });
  await E([
    "(function(){",
    " window.__marks = []; window.__lcpErr='';",
    " try { new PerformanceObserver(function(l){",
    "   l.getEntries().forEach(function(e){",
    "     window.__marks.push({kind:'LCP', t:e.startTime, tag:(e.element?(e.element.tagName+'.'+String(e.element.className).split(' ').slice(0,2).join('.')):'')});",
    "   });",
    " }).observe({type:'largest-contentful-paint', buffered:true}); } catch(e){ window.__lcpErr = e.message; }",
    " try { new PerformanceObserver(function(l){",
    "   l.getEntries().forEach(function(e){ if(e.name==='first-contentful-paint') window.__marks.push({kind:'FCP', t:e.startTime}); });",
    " }).observe({type:'paint', buffered:true}); } catch(e){ window.__lcpErr += ' paint:' + e.message; }",
    " return 1;",
    "})()"
  ].join('\n'));
  await new Promise(function (r) { setTimeout(r, 9000); });

  // ⚠️ 必须确认落在**已登录的目标页**：
  //   上一轮 token 没写成功，页面停在登录页，测出来的「时间线」全是登录页的，
  //   而且毫无提示 —— 看起来像一次正常的测量。
  var landed = JSON.parse(await E("JSON.stringify({hash:location.hash, loggedIn:!!document.querySelector('.sidebar')||!!document.querySelector('.notes-sidebar'), login:location.hash.indexOf('login')>=0})"));
  if (landed.login || !landed.loggedIn) {
    console.error('✗ 落在登录页（hash=' + landed.hash + '）—— token 未生效，测量结果无效');
    console.error('  tok 长度=' + String(tok).length + '（<100 即登录失败）');
    c.ws.close(); ch.kill();
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
    process.exit(2);
  }

  // 页面内的时间轴标记（performance.now 时基）与 CDP 时基对齐：
  // 用「页面 navigationStart」近似 t0 —— CDP 的 t0Sec 就是首个请求。
  var marks = JSON.parse(await E("JSON.stringify(window.__marks||[])"));
  var nav = JSON.parse(await E("JSON.stringify((function(){var n=performance.getEntriesByType('navigation')[0];return {domContentLoaded:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd)}})())"));

  var t0 = t0Sec || 0;
  function rel(ts) { return Math.round((ts - t0) * 1000); }

  console.log('=== 冷加载时间线（0 = 首个请求发出）===');
  console.log('环境：缓存禁用' + (THROTTLE > 1 ? ' + CPU ' + THROTTLE + 'x' : '（不降速）') + '  页面 ' + PAGE + '\n');

  // 渲染事件
  var events = [];
  marks.forEach(function (m) { events.push({ t: Math.round(m.t), kind: m.kind, what: m.tag || '' }); });
  events.push({ t: nav.domContentLoaded, kind: 'DCL', what: '' });
  events.push({ t: nav.load, kind: 'load', what: '' });

  // 网络事件（合并成「请求 → 完成」区间）
  var byId = {};
  netEvents.forEach(function (e) {
    byId[e.id] = byId[e.id] || {};
    byId[e.id][e.kind] = e;
    if (e.url) byId[e.id].url = e.url;
    if (e.type) byId[e.id].type = e.type;
  });
  Object.keys(byId).forEach(function (id) {
    var e = byId[id];
    var start = e.req ? rel(e.req.ts) : -1;
    var end = e.done ? rel(e.done.ts) : (e.resp ? rel(e.resp.ts) : -1);
    var shortUrl = (e.url || '').split('?')[0];
    if (shortUrl.length > 46) shortUrl = shortUrl.substring(0, 43) + '...';
    events.push({ t: start, kind: 'net', what: shortUrl + '  [' + (e.type || '?') + ']' + (end >= 0 ? ' 完成@' + end + 'ms' : '') });
  });

  events.sort(function (a, b) { return a.t - b.t; });
  var lcpT = 0;
  events.forEach(function (e) { if (e.kind === 'LCP') lcpT = e.t; });

  events.forEach(function (e) {
    var tag = String(e.t).padStart(5) + 'ms';
    var icon = e.kind === 'LCP' ? '★' : e.kind === 'FCP' ? '◇' : e.kind === 'net' ? ' ' : '·';
    if (e.kind === 'LCP') console.log('  ' + tag + '  ★ LCP: ' + e.what);
    else if (e.kind === 'FCP') console.log('  ' + tag + '  ◇ FCP');
    else if (e.kind === 'DCL' || e.kind === 'load') console.log('  ' + tag + '  · ' + e.kind);
    else console.log('  ' + tag + '    ' + e.what);
  });

  // 判定：LCP 前最后完成的 API 是谁
  var apis = events.filter(function (e) { return e.kind === 'net' && e.what.indexOf('/api/') >= 0; });
  var lastApiBeforeLcp = null;
  apis.forEach(function (e) { if (e.t <= lcpT) lastApiBeforeLcp = e; });
  console.log('\n=== 判定 ===');
  console.log('  LCP 时刻: ' + lcpT + 'ms');
  if (lastApiBeforeLcp) console.log('  LCP 前最后一个完成的 API: ' + lastApiBeforeLcp.what);
  var apiCount = apis.length;
  console.log('  /api/ 请求总数: ' + apiCount);

  c.ws.close(); ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(function (e) { console.error('失败:', e.message); process.exit(2); });