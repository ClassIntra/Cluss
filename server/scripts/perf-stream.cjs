/**
 * 流式输出与打字流畅度巡检
 *
 * 为什么单独测：这是学生感知最强的路径 —— AI 一边吐字，页面一边重绘。
 * 任何一帧超过 32ms 都会表现为「卡一下」「一跳一跳」，比切页卡顿更烦人。
 *
 * 测什么：
 *   1. 流式 delta 高频到达时的逐帧间隔（真实 SSE，不是模拟）
 *   2. 长文本渲染时的重排代价
 *   3. 输入框逐字输入的响应
 *   4. 长会话滚动时的掉帧
 *
 * 跑法：node server/scripts/perf-stream.cjs [baseUrl]
 * 前置：需要一个配好上游的实例（用 mock-ai-server 即可，它会持续吐字）
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:9045';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9411);
const THROTTLE = Number(process.env.CPU_THROTTLE || 4);

function get(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      let d = ''; res.on('data', function (c) { d += c; }); res.on('end', function () { resolve(d); });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map(); let id = 0;
  ws.addEventListener('message', function (ev) {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const r = pending.get(m.id); pending.delete(m.id);
      m.error ? r.reject(new Error(m.error.message)) : r.resolve(m.result);
    }
  });
  function send(method, params) {
    const i = ++id;
    return new Promise(function (resolve, reject) {
      const t = setTimeout(function () { pending.delete(i); reject(new Error('CDP 超时: ' + method)); }, 25000);
      pending.set(i, { resolve: function (v) { clearTimeout(t); resolve(v); }, reject: function (e) { clearTimeout(t); reject(e); } });
      ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
    });
  }
  return { ws: ws, send: send, open: new Promise(function (r) { ws.addEventListener('open', r); }) };
}

function E(c, expr, aw) {
  return c.send('Runtime.evaluate', { expression: expr, awaitPromise: !!aw, returnByValue: true })
    .then(function (r) { return r.result && r.result.value; });
}

const FRAME_PROBE = `
  window.__frames = []; window.__lt = [];
  if (window.__fo) cancelAnimationFrame(window.__fo);
  var last = performance.now();
  (function tick(){
    var n = performance.now();
    window.__frames.push(n - last); last = n;
    window.__fo = requestAnimationFrame(tick);
  })();
  if (window.__po) { try { window.__po.disconnect(); } catch(e){} }
  try {
    window.__po = new PerformanceObserver(function(l){
      l.getEntries().forEach(function(e){ window.__lt.push(Math.round(e.duration)); });
    });
    window.__po.observe({ entryTypes: ['longtask'] });
  } catch(e){}
  'ok'
`;
const READ = `
  (function(){
    if (window.__fo) cancelAnimationFrame(window.__fo);
    var f = window.__frames || [];
    var jank = f.filter(function(d){ return d > 32; });
    var worst = f.reduce(function(m,d){ return Math.max(m,d); }, 0);
    var lt = (window.__lt||[]).filter(function(d){ return d > 50; });
    return JSON.stringify({
      frames: f.length, jank: jank.length,
      jankRate: f.length ? jank.length / f.length : 0,
      worst: worst,
      avg: f.reduce(function(s,d){ return s+d; }, 0) / Math.max(1, f.length),
      p95: (function(){
        if (!f.length) return 0;
        var s = f.slice().sort(function(a,b){ return a-b; });
        return s[Math.floor(s.length * 0.95)];
      })(),
      longTasks: lt
    });
  })()
`;

function pct(n, d) { return d ? (n / d * 100).toFixed(1) + '%' : '0%'; }

(async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-stream-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu',
    '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(function (r) { setTimeout(r, 500); });
    try { await get('http://127.0.0.1:' + PORT + '/json/version'); up = true; break; } catch (e) {}
  }
  if (!up) { console.error('Chrome 未就绪'); chrome.kill(); process.exit(2); }

  const targets = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
  const c = connect(targets.find(function (t) { return t.type === 'page'; }).webSocketDebuggerUrl);
  await c.open;
  await c.send('Page.enable'); await c.send('Runtime.enable');

  await c.send('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 3500); });
  const tok = await E(c,
    "fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:" +
    JSON.stringify(process.env.SETUP_ACCOUNT || 'uitester') + ",password:" +
    JSON.stringify(process.env.SETUP_PASSWORD || 'Test1234') + "})}).then(r=>r.json()).then(j=>j&&j.data?j.data.token:'')", true);
  if (!tok) { console.error('登录失败'); chrome.kill(); process.exit(2); }
  await E(c, "localStorage.setItem('cluss_token'," + JSON.stringify(tok) + ");localStorage.setItem('token'," + JSON.stringify(tok) + ")");
  await c.send('Page.navigate', { url: BASE + '/' });
  await new Promise(function (r) { setTimeout(r, 3000); });
  if (THROTTLE > 1) await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  console.log('CPU ' + THROTTLE + 'x 降速已开启\n');

  // ---- 1. 流式输出（真实 SSE）----
  console.log('=== 1. 流式输出（真实 SSE 逐字到达）===');
  await E(c, FRAME_PROBE);
  await E(c, "(function(){var ta=document.querySelector('textarea');if(ta){ta.focus();}return 1})()");
  // 通过真实 UI 路径发消息：填输入框 + 点发送
  const sent = await E(c, `
    (function(){
      var ta = document.querySelector('textarea');
      var btn = Array.prototype.slice.call(document.querySelectorAll('button'))
        .find(function(b){ return (b.textContent||'').indexOf('发送') >= 0; });
      if (!ta || !btn) return 'no-ui';
      ta.value = '请详细讲解二次函数顶点的求法';
      ta.dispatchEvent(new Event('input', {bubbles:true}));
      btn.click();
      return 'sent';
    })()
  `);
  if (sent !== 'sent') {
    console.log('  未找到输入框或发送按钮（跳过）');
  } else {
    // 等生成完成（done 事件）或超时
    for (let i = 0; i < 40; i++) {
      await new Promise(function (r) { setTimeout(r, 500); });
      const done = await E(c, "(document.querySelectorAll('.msg-assistant, [class*=assistant]').length>0 && !document.querySelector('.stop-btn'))?1:0");
      if (done) break;
    }
    const s = JSON.parse(await E(c, READ));
    console.log('  采样帧数    : ' + s.frames);
    console.log('  掉帧(>32ms) : ' + s.jank + ' (' + pct(s.jank, s.frames) + ') ' + (s.jankRate < 0.05 ? '✓' : '✗'));
    console.log('  平均帧      : ' + s.avg.toFixed(1) + ' ms');
    console.log('  P95 帧      : ' + s.p95.toFixed(1) + ' ms');
    console.log('  最差帧      : ' + s.worst.toFixed(1) + ' ms');
    console.log('  长任务      : ' + s.longTasks.length + ' 个 ' + (s.longTasks.length ? '(' + s.longTasks.join(', ') + 'ms)' : '✓'));
  }

  // ---- 2. 输入框逐字打字 ----
  console.log('\n=== 2. 输入框逐字输入（10 字）===');
  await E(c, FRAME_PROBE);
  const typeRes = await E(c, `
    (function(){
      var ta = document.querySelector('textarea');
      if (!ta) return null;
      ta.focus(); ta.value='';
      var text = '帮我讲解这个函数的单调区间';
      var t0 = performance.now();
      for (var i=0;i<text.length;i++){
        ta.value += text[i];
        ta.dispatchEvent(new Event('input',{bubbles:true}));
      }
      return { ms: performance.now()-t0, chars: text.length };
    })()
  `);
  if (typeRes) {
    console.log('  ' + typeRes.chars + ' 字同步耗时: ' + typeRes.ms.toFixed(1) + ' ms');
    await new Promise(function (r) { setTimeout(r, 900); });
    const s2 = JSON.parse(await E(c, READ));
    console.log('  掉帧: ' + s2.jank + ' (' + pct(s2.jank, s2.frames) + ') | 最差帧 ' + s2.worst.toFixed(1) + 'ms');
  }

  // ---- 3. 长消息列表的滚动 ----
  console.log('\n=== 3. 长对话滚动（注入大量历史消息）===');
  await E(c, FRAME_PROBE);
  const scrollRes = await E(c, `
    (function(){
      var c = document.querySelector('.messages, .msg-list, [class*=message]');
      if (!c) return null;
      var last = performance.now();
      var worst = 0, n = 0;
      for (var i=0;i<40;i++){
        var t0 = performance.now();
        c.scrollTop += 120;
        var d = performance.now() - t0;
        if (d > worst) worst = d;
        n++;
      }
      return { worst: worst, steps: n, scrollH: c.scrollHeight };
    })()
  `);
  await new Promise(function (r) { setTimeout(r, 800); });
  const s3 = JSON.parse(await E(c, READ));
  if (scrollRes) {
    console.log('  40 次滚动单步最慢: ' + scrollRes.worst.toFixed(1) + ' ms');
    console.log('  滚动期间掉帧: ' + s3.jank + ' (' + pct(s3.jank, s3.frames) + ') | 最差帧 ' + s3.worst.toFixed(1) + 'ms');
  }

  // ---- 4. 各页切换（对照）----
  console.log('\n=== 4. 各页切入（含真实会话历史）===');
  var pages = [['学习', '/study'], ['作文', '/writing'], ['笔记', '/notes'], ['错题本', '/wrong-book'], ['云盘', '/cloud']];
  for (var p = 0; p < pages.length; p++) {
    await E(c, FRAME_PROBE);
    await E(c, "location.hash='#" + pages[p][1] + "'");
    await new Promise(function (r) { setTimeout(r, 1300); });
    var st = JSON.parse(await E(c, READ));
    console.log('  ' + pages[p][0] + '  掉帧 ' + pct(st.jank, st.frames) +
      ' | 最差帧 ' + st.worst.toFixed(1).padStart(6) + 'ms | 长任务 ' + st.longTasks.length);
  }

  c.ws.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(function (e) { console.error('失败:', e.message); process.exit(2); });