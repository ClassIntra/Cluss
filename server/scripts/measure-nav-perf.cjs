/**
 * 导航切换流畅度测量（修复前/修复后对照）
 *
 * 为什么不用 agent-browser：它要下载自己的 Chromium，起不来。
 * 系统已有 Chrome，直接用 CDP 驱动更轻、也更容易拿到逐帧数据。
 *
 * 测什么：
 *   1. 切页期间的**长任务**（>50ms 的主线程阻塞）—— 布局重排会在这里现形
 *   2. 掉帧数与最长连续阻塞
 *   3. 切页各阶段耗时
 *
 * 跑法：node server/scripts/measure-nav-perf.cjs [baseUrl]
 * 需要先起一个 Cluss 实例，并用 SETUP_TOKEN / SETUP_ACCOUNT 登录。
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:9031';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;

// —— 极简 CDP 客户端（只用到 WebSocket + 一点点 JSON-RPC）——
function get(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () { resolve(d); });
    }).on('error', reject);
  });
}

const WebSocket = (function () {
  // Node 22+ 有内置 WebSocket；老版本退回空
  return typeof globalThis.WebSocket !== 'undefined' ? globalThis.WebSocket : null;
})();

let msgId = 0;
function makeClient(ws) {
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', function (ev) {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const r = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) r.reject(new Error(m.error.message));
      else r.resolve(m.result);
    } else if (m.method) {
      listeners.forEach(function (fn) { fn(m); });
    }
  });
  return {
    send: function (method, params) {
      const id = ++msgId;
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      });
    },
    on: function (fn) { listeners.push(fn); }
  };
}

(async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error('找不到 Chrome:', CHROME);
    process.exit(2);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-perf-'));

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--disable-gpu',
    // 模拟目标设备：低端安卓平板的 CPU 降速，让重排的代价真实暴露出来
    '--disable-features=CalculateNativeWinOcclusion',
    'about:blank'
  ], { stdio: 'ignore' });

  // 等 devtools 就绪
  let wsUrl = '';
  for (let i = 0; i < 40; i++) {
    await new Promise(function (r) { setTimeout(r, 500); });
    try {
      const v = await get('http://127.0.0.1:' + PORT + '/json/version');
      const j = JSON.parse(v);
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch (e) { /* 还没起来 */ }
  }
  if (!wsUrl) { console.error('Chrome devtools 未就绪'); chrome.kill(); process.exit(2); }

const ws = new WebSocket(wsUrl);
  await new Promise(function (r) { ws.addEventListener('open', r); });

  // 直接连「页面」target 的 WebSocket，而不是 browser 端 + flatten 会话。
  // 后者要额外处理 sessionId 路由，事件回传也更容易踩坑，收益为零。
  const targets = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
  const page = targets.find(function (t) { return t.type === 'page'; });
  if (!page) { console.error('找不到 page target'); process.exit(2); }

  const pws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (r) { pws.addEventListener('open', r); });

  let msgId = 0;
  const pending = new Map();
  pws.addEventListener('message', function (ev) {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const r = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) r.reject(new Error(m.error.message));
      else r.resolve(m.result);
    }
  });

  function sess(method, params) {
    const id = ++msgId;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error('CDP 超时: ' + method));
      }, 20000);
      pending.set(id, {
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      });
      pws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }

  await sess('Page.enable');
  await sess('Runtime.enable');
  await sess('Performance.enable');
  // CPU 降速：1 = 不降速。用环境变量控制，默认 4x（≈ 中端平板）。
  // 登录走的是网络请求，降速下会明显变慢，所以登录**在降速之前**完成。
  const THROTTLE = Number(process.env.CPU_THROTTLE || 4);

  // —— 收集长任务 ——
  await sess('Performance.enable');
  const metrics = [];
  ws.addEventListener('message', function (m) {
    if (m.method === 'Performance.metrics' && m.params && m.params.metrics) {
      metrics.push(m.params.metrics);
    }
  });

  console.log('打开 ' + BASE + ' …');
  await sess('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 4000); });

  // 登录（用环境变量传入的凭据）
  const acct = process.env.SETUP_ACCOUNT || 'uitester';
  const pwd = process.env.SETUP_PASSWORD || 'Test1234';
  const token = await sess('Runtime.evaluate', {
    expression: `
      fetch('/api/auth/login', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({account:${JSON.stringify(acct)}, password:${JSON.stringify(pwd)}})
      }).then(r=>r.json()).then(j=>j && j.data ? j.data.token : '')
    `,
    awaitPromise: true, returnByValue: true
  });
  const tok = token.result && token.result.value;
  if (!tok) {
    console.error('登录失败，无法继续测量');
    chrome.kill();
    process.exit(2);
  }
  console.log('登录成功');

  await sess('Runtime.evaluate', {
    expression: `
      localStorage.setItem('cluss_token', ${JSON.stringify(tok)});
      localStorage.setItem('token', ${JSON.stringify(tok)});
    `
  });
  await sess('Page.navigate', { url: BASE + '/' });
  await new Promise(function (r) { setTimeout(r, 3500); });

  // 登录完成后再开降速：降速会让 fetch 显著变慢，放在前面容易超时
  if (THROTTLE > 1) {
    await sess('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    console.log('CPU 降速 ' + THROTTLE + 'x 已开启（模拟中端平板）');
  }

  // 观察器：抓长任务
  const results = [];
  const observe = `
    window.__longTasks = [];
    window.__frames = [];
    if (!window.__obsInstalled) {
      window.__obsInstalled = true;
      try {
        new PerformanceObserver(function(list){
          list.getEntries().forEach(function(e){
            window.__longTasks.push({ start: e.startTime, dur: e.duration, name: e.name });
          });
        }).observe({ entryTypes: ['longtask'] });
      } catch(e){ window.__obsErr = e.message; }
      var last = performance.now(), count = 0;
      function tick(){
        var now = performance.now();
        count++;
        window.__frames.push(now - last);
        last = now;
        if (count < 600) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }
  `;
  await sess('Runtime.evaluate', { expression: observe });

  // 逐个切页
  const pages = [
    { name: '学习', url: '/study' },
    { name: '作文', url: '/writing' },
    { name: '笔记', url: '/notes' },
    { name: '错题本', url: '/wrong-book' },
    { name: '云盘', url: '/cloud' },
    { name: '记录', url: '/records' },
    { name: '对话', url: '/' }
  ];

  console.log('\n开始逐页测量（CPU 4x 降速，模拟中端平板）…');
  for (const p of pages) {
    // 只改 hash，触发前端路由，不做整页刷新
    const t0 = Date.now();
    await sess('Runtime.evaluate', {
      expression: `location.hash = '#${p.url}';`
    });
    await new Promise(function (r) { setTimeout(r, 1400); });
    results.push({ page: p.name, wall: Date.now() - t0 });
  }

  // 读取观察结果
  const obs = await sess('Runtime.evaluate', {
    expression: `
      (function(){
        var lt = window.__longTasks || [];
        var fr = window.__frames || [];
        var long = lt.filter(function(t){ return t.dur > 50; });
        var jank = fr.filter(function(d){ return d > 32; });
        return JSON.stringify({
          longTaskCount: long.length,
          longestTask: long.reduce(function(m,t){ return Math.max(m, t.dur); }, 0),
          totalBlockingMs: long.reduce(function(s,t){ return s + (t.dur - 50); }, 0),
          framesSampled: fr.length,
          jankyFrames: jank.length,
          avgFrameMs: fr.reduce(function(s,d){ return s + d; }, 0) / Math.max(1, fr.length),
          worstFrameMs: fr.reduce(function(m,d){ return Math.max(m, d); }, 0),
          obsErr: window.__obsErr || null
        });
      })()
    `,
    returnByValue: true
  });

  const stat = JSON.parse(obs.result.value);

  console.log('\n=== 测量结果 ===');
  console.log('长任务(>50ms) 次数 : ' + stat.longTaskCount);
  console.log('最长单次阻塞      : ' + stat.longestTask.toFixed(1) + ' ms');
  console.log('总阻塞时长        : ' + stat.totalBlockingMs.toFixed(1) + ' ms');
  console.log('采样帧数          : ' + stat.framesSampled);
  console.log('掉帧(>32ms)       : ' + stat.jankyFrames +
              ' (' + (stat.framesSampled ? (stat.jankyFrames / stat.framesSampled * 100).toFixed(1) : '0') + '%)');
  console.log('平均帧            : ' + stat.avgFrameMs.toFixed(1) + ' ms');
  console.log('最差帧            : ' + stat.worstFrameMs.toFixed(1) + ' ms');
  if (stat.obsErr) console.log('(观察器不可用: ' + stat.obsErr + ')');

  pws.close();
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(function (e) {
  console.error('测量失败:', e.message);
  process.exit(2);
});