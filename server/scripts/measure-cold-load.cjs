/**
 * 冷加载首屏测量（LCP / FCP / 关键路径）
 *
 * 为什么必须冷加载测：
 *   之前那套性能巡检是**反复导航同一页**，资源全在缓存里，
 *   测的是热缓存路径。而学生第一次打开某页是冷加载 ——
 *   要下载 HTML、解析 JS、按需拉 chunk、再请求数据。
 *   两者能差出好几倍。开发者工具报的 LCP 2.76s 来自冷加载，
 *   用热缓存测是测不出来的。
 *
 * 测什么：
 *   1. FCP / LCP（真实数据，不靠猜）
 *   2. LCP 元素是谁 —— 它往往就是「最后才渲染出来的那块」
 *   3. 关键路径上各阶段耗时：文档 → JS → chunk → 数据
 *
 * 跑法：node server/scripts/measure-cold-load.cjs [baseUrl] [path]
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:9055';
const PAGE = process.argv[3] || '/';
const PORT = Number(process.env.CDP_PORT || 9450);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const THROTTLE = Number(process.env.CPU_THROTTLE || 4);

function get(u) {
  return new Promise(function (res, rej) {
    http.get(u, function (r) { let d = ''; r.on('data', function (c) { d += c; }); r.on('end', function () { res(d); }); }).on('error', rej);
  });
}
function conn(u) {
  const ws = new WebSocket(u); const P = new Map(); let id = 0;
  ws.addEventListener('message', function (ev) {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && P.has(m.id)) { const r = P.get(m.id); P.delete(m.id); m.error ? r.reject(new Error(m.message)) : r.resolve(m.result); }
  });
  function send(me, pa) {
    const i = ++id;
    return new Promise(function (res, rej) {
      const t = setTimeout(function () { P.delete(i); rej(new Error('CDP 超时 ' + me)); }, 40000);
      P.set(i, { resolve: function (v) { clearTimeout(t); res(v); }, reject: function (e) { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id: i, method: me, params: pa || {} }));
    });
  }
  return { ws: ws, send: send, open: new Promise(function (r) { ws.addEventListener('open', r); }) };
}

(async function () {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-'));
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
  await c.send('Cache.enable').catch(function () {});
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });   // ← 冷加载的关键
  await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  function E(e, a) {
    return c.send('Runtime.evaluate', { expression: e, awaitPromise: !!a, returnByValue: true })
      .then(function (r) { return r.result && r.result.value; });
  }

  // 登录（放在被测页面之前，不计入它的关键路径）
  await c.send('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 3500); });
  var acct = process.env.SETUP_ACCOUNT || 'uitester';
  var pwd = process.env.SETUP_PASSWORD || 'Test1234';
  var tok = await E("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:" + JSON.stringify(acct) + ",password:" + JSON.stringify(pwd) + "})}).then(r=>r.json()).then(j=>j&&j.data?j.data.token:'')", true);
  if (!tok || String(tok).length < 100) {
    console.error('登录失败（token 长度 ' + String(tok).length + '）');
    console.error('  注意 awaitPromise 必须为 true，否则拿到的是未决值。');
    process.exit(2);
  }
  // ⚠️ 必须连 user 一起写：isAdmin getter 读的是 state.user.is_admin
  //   （store/auth.js:20），而 store 初始化时 user 从 localStorage 的
  //   cluss_user 读。只存 token 的话 is_admin 判定为 false，
  //   /admin 会被守卫重定向到 Chat —— 测出来的是首页，不是管理台。
  var userJson = await E("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:" + JSON.stringify(acct) + ",password:" + JSON.stringify(pwd) + "})}).then(r=>r.json()).then(j=>JSON.stringify(j.data.user_info))", true);
  await E("localStorage.setItem('cluss_token'," + JSON.stringify(tok) + ");localStorage.setItem('token'," + JSON.stringify(tok) + ");localStorage.setItem('cluss_user'," + JSON.stringify(userJson) + ")");

  // 收集资源时序
  var res_ = [];
  c.ws.addEventListener('message', function (ev) {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Network.responseReceived') {
      var r = m.params.response;
      res_.push({ url: r.url.split('/').pop().substring(0, 40), type: m.params.type, size: r.encodedDataLength, status: r.status });
    }
  });

  console.log('冷加载测量（禁用缓存 + CPU ' + THROTTLE + 'x 降速 ≈ 中端平板）');
  console.log('页面：' + BASE + PAGE + '\n');

  // ★ LCP 必须用 PerformanceObserver 现场观察 ——
  //   performance.getEntriesByType('largest-contentful-paint') 在部分内核上
  //   始终返回空数组（实测 headless Chrome 154 就是），于是会误报「LCP 良好」。
  //   所以在**导航之前**就注册观察器，把每次 LCP 候选记下来。
  var lcpSeen = [];
  var lcpEval = [
    "(function(){",
    " window.__lcpList = window.__lcpList || [];",
    " if (!window.__lcpObs) {",
    "   window.__lcpObs = true;",
    "   try {",
    "     new PerformanceObserver(function(list){",
    "       list.getEntries().forEach(function(e){",
    "         window.__lcpList.push({ t: e.startTime, size: e.size, url: e.url || '',",
    "           tag: e.element ? e.element.tagName.toLowerCase() : '',",
    "           cls: e.element && e.element.className ? String(e.element.className) : '',",
    "           w: e.element ? Math.round(e.element.getBoundingClientRect().width) : 0,",
    "           h: e.element ? Math.round(e.element.getBoundingClientRect().height) : 0 });",
    "       });",
    "     }).observe({ type: 'largest-contentful-paint', buffered: true });",
    "   } catch(err) { window.__lcpErr = err.message; }",
    " }",
    " return 1;",
    "})()"
  ].join('\n');

  // ★ 关键：用全新标签页打开被测页，避免任何缓存
  await c.send('Page.navigate', { url: 'about:blank' });
  await new Promise(function (r) { setTimeout(r, 500); });
  res_ = [];

  // 观察器要在导航前注入，否则会漏掉首个候选
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: '(function(){' + lcpEval + '})();' });
  await c.send('Page.navigate', { url: BASE + PAGE });
  await new Promise(function (r) { setTimeout(r, 9000); });

  var detail = await E([
    "(function(){",
    " var nav = performance.getEntriesByType('navigation')[0];",
    " var fcp = 0;",
    " performance.getEntriesByType('paint').forEach(function(p){",
    "   if (p.name === 'first-contentful-paint') fcp = p.startTime;",
    " });",
    // LCP 取观察器收集的**最后一个**候选（那是最终认定的那次）
    " var list = window.__lcpList || [];",
    " var lcp = 0, lcpEl = '', lcpSize = '';",
    " if (list.length) {",
    "   var last = list[list.length - 1];",
    "   lcp = Math.round(last.t);",
    "   lcpEl = last.tag + (last.cls ? '.' + last.cls.split(' ').join('.') : '') + (last.url ? '  ← ' + last.url.split('/').pop() : '');",
    "   lcpSize = last.w + 'x' + last.h + '  (' + Math.round(last.size) + 'px²)';",
    " }",
    " var res = performance.getEntriesByType('resource').map(function(r){",
    "   return { name: r.name.split('/').pop().substring(0,42), start: Math.round(r.startTime),",
    "            dur: Math.round(r.duration), size: r.encodedDataLength || 0, type: r.initiatorType };",
    " });",
    " return JSON.stringify({",
    "   fcp: Math.round(fcp), lcp: lcp, lcpEl: lcpEl, lcpSize: lcpSize,",
    "   lcpCandidates: list.length,",
    "   domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,",
    "   loadEnd: nav ? Math.round(nav.loadEventEnd) : 0,",
    "   resources: res",
    " });",
    "})()"
  ].join('\n'));

  var d = JSON.parse(detail);
  console.log('=== 核心指标 ===');
  console.log('  FCP 首次内容绘制 : ' + d.fcp + ' ms');
  console.log('  LCP 最大内容绘制 : ' + (d.lcp ? d.lcp + ' ms' : '未捕获') +
    '   ' + (d.lcp === 0 ? '✗ 未取到' : d.lcp > 2500 ? '✗ 超过 2.5s 红线' : d.lcp > 1800 ? '△ 需改善' : '✓ 良好'));
  console.log('  LCP 候选次数     : ' + d.lcpCandidates);
  console.log('  LCP 元素         : ' + (d.lcpEl || '(未捕获)'));
  if (d.lcpSize) console.log('  LCP 元素尺寸     : ' + d.lcpSize);
  console.log('  DOMContentLoaded : ' + d.domContentLoaded + ' ms');
  console.log('  load 完成        : ' + d.loadEnd + ' ms');

  console.log('\n=== 资源关键路径（按开始时间）===');
  d.resources.sort(function (a, b) { return a.start - b.start; }).slice(0, 14).forEach(function (r) {
    console.log('  ' + String(r.start).padStart(5) + 'ms → +' + String(r.dur).padStart(5) + 'ms  ' +
      String(Math.round(r.size / 1024)).padStart(5) + 'KB  ' + r.name);
  });

  console.log('\n=== LCP 之前完成的脚本（主线程累计占用）===');
  var blocking = d.resources.filter(function (r) { return d.lcp > 0 && r.start < d.lcp; });
  var totalBlock = blocking.reduce(function (s, r) { return s + r.dur; }, 0);
  console.log('  共 ' + blocking.length + ' 个，累计 ' + Math.round(totalBlock) + 'ms');
  blocking.sort(function (a, b) { return b.dur - a.dur; }).slice(0, 8).forEach(function (r) {
    console.log('  ' + String(Math.round(r.dur)).padStart(5) + 'ms  ' +
      String(Math.round(r.size / 1024)).padStart(4) + 'KB  ' + r.name);
  });

  c.ws.close(); ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(function (e) { console.error('失败:', e.message); process.exit(2); });