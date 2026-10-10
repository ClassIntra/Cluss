/**
 * 全系统性能巡检（CDP 驱动，无头 Chrome）
 *
 * 为什么要有这个：「丝滑」不是感觉，是一组可测的数字。
 * 之前只测了切页，漏掉了首屏、各页首次进入、点击反馈这些真正影响体感的环节。
 *
 * 测什么：
 *   A. 首屏：导航开始 → 首个有意义内容渲染
 *   B. 各页首次进入 / 二次进入（区分「一次性进入成本」与「日常切换成本」）
 *   C. 点击到下一帧的反馈延迟（交互是否即时）
 *   D. 全程长任务与掉帧
 *
 * 判据（模拟中端平板，CPU 4x降速）：
 *   交互反馈≤ 100ms（点下去要立刻有反应）
 *   二次进入     ≤ 100ms（日常来回切必须无感）
 *   长任务       0 个超过 200ms
 *   掉帧率       < 5%
 *
 * 跑法：node server/scripts/perf-audit.cjs [baseUrl]
 * 环境：SETUP_ACCOUNT / SETUP_PASSWORD / CPU_THROTTLE（默认 4）
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:9031';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9377);
const THROTTLE = Number(process.env.CPU_THROTTLE || 4);

const BUDGET = {
  interactionMs: 100,   // 点击 → 下一帧
  revisitMs: 100,      // 二次进入
  longTaskMs: 200,     // 单次阻塞上限
  jankRate: 0.05       // 掉帧率上限
};

function get(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () { resolve(d); });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener('message', function (ev) {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const r = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) r.reject(new Error(m.error.message));
      else r.resolve(m.result);
    }
  });
  function send(method, params) {
    const i = ++id;
    return new Promise(function (resolve, reject) {
      const t = setTimeout(function () {
        pending.delete(i);
        reject(new Error('CDP 超时: ' + method));
      }, 25000);
      pending.set(i, {
        resolve: function (v) { clearTimeout(t); resolve(v); },
        reject: function (e) { clearTimeout(t); reject(e); }
      });
      ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
    });
  }
  return { ws: ws, send: send, open: new Promise(function (r) { ws.addEventListener('open', r); }) };
}

// 在页面里跑一段代码并拿回值
function evaluate(c, expr, awaitPromise) {
  return c.send('Runtime.evaluate', {
    expression: expr, awaitPromise: !!awaitPromise, returnByValue: true
  }).then(function (r) { return r.result && r.result.value; });
}

const RESET_OBS = `
  window.__lt = [];
  window.__frames = [];
  if (window.__po) { try { window.__po.disconnect(); } catch(e){} }
  try {
    window.__po = new PerformanceObserver(function(list){
      list.getEntries().forEach(function(e){ window.__lt.push(e.duration); });
    });
    window.__po.observe({ entryTypes: ['longtask'] });
  } catch(e) { window.__ltErr = e.message; }
  window.__lastFrame = performance.now();
  window.__frameOn = true;
  (function tick(){
    if (!window.__frameOn) return;
    var now = performance.now();
    window.__frames.push(now - window.__lastFrame);
    window.__lastFrame = now;
    requestAnimationFrame(tick);
  })();
`;

const READ_OBS = `
  (function(){
    window.__frameOn = false;
    var lt = window.__lt || [], fr = window.__frames || [];
    var long = lt.filter(function(d){ return d > 50; });
    return JSON.stringify({
      longTasks: long,
      worst: long.reduce(function(m,d){ return Math.max(m,d); }, 0),
      blocking: long.reduce(function(s,d){ return s + (d-50); }, 0),
      frames: fr.length,
      jank: fr.filter(function(d){ return d > 32; }).length,
      avgFrame: fr.reduce(function(s,d){ return s+d; }, 0) / Math.max(1, fr.length),
      worstFrame: fr.reduce(function(m,d){ return Math.max(m,d); }, 0),
      nodes: document.querySelectorAll('*').length
    });
  })()
`;

const PAGES = [
  { name: '对话', url: '/' },
  { name: '学习', url: '/study' },
  { name: '作文', url: '/writing' },
  { name: '记录', url: '/records' },
  { name: '笔记', url: '/notes' },
  { name: '错题本', url: '/wrong-book' },
  { name: '云盘', url: '/cloud' }
];

(async function main() {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome'); process.exit(2); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-audit-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu',
    '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore' });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(function (r) { setTimeout(r, 500); });
    try { await get('http://127.0.0.1:' + PORT + '/json/version'); up = true; break; } catch (e) {}
  }
  if (!up) { console.error('Chrome 未就绪'); chrome.kill(); process.exit(2); }

  const targets = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
  const pageTarget = targets.find(function (t) { return t.type === 'page'; });
  const c = connect(pageTarget.webSocketDebuggerUrl);
  await c.open;

  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Performance.enable');
  // 关掉浏览器的节流与后台优化，否则测出来的数比真实设备乐观
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(function () {});

  // —— 登录（降速前）——
  await c.send('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 3500); });
  const acct = process.env.SETUP_ACCOUNT || 'uitester';
  const pwd = process.env.SETUP_PASSWORD || 'Test1234';
  const tok = await evaluate(c,
    "fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:" +
    JSON.stringify(acct) + ",password:" + JSON.stringify(pwd) +
    "})}).then(r=>r.json()).then(j=>j&&j.data?j.data.token:'')", true);
  if (!tok) { console.error('登录失败'); chrome.kill(); process.exit(2); }
  await evaluate(c, "localStorage.setItem('cluss_token'," + JSON.stringify(tok) + ");localStorage.setItem('token'," + JSON.stringify(tok) + ")");

  // —— A. 首屏（未降速，反映真实用户）——
  console.log('=== A. 首屏加载（未降速）===');
  await c.send('Performance.enable');
  const navStart = Date.now();
  await c.send('Page.navigate', { url: BASE + '/' });
  // 等首屏真正有内容（不是白屏）
  let firstPaint = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(function (r) { setTimeout(r, 200); });
    const ready = await evaluate(c, "(document.querySelector('#app-root')&&document.querySelectorAll('#app-root *').length>50)?1:0");
    if (ready) { firstPaint = Date.now() - navStart; break; }
  }
  const fcp = await evaluate(c, "(()=>{var e=performance.getEntriesByType('paint').find(x=>x.name==='first-contentful-paint');return e?Math.round(e.startTime):null})()");
  console.log('  DOM 就绪      : ' + (firstPaint !== null ? firstPaint + ' ms' : '超时'));
  console.log('  FCP 首次内容  : ' + (fcp !== null ? fcp + ' ms' : '无数据'));
  const nav = await evaluate(c, "(()=>{var e=performance.getEntriesByType('navigation')[0];return e?JSON.stringify({domContentLoaded:Math.round(e.domContentLoadedEventEnd),load:Math.round(e.loadEventEnd)}):''})()");
  if (nav) { const n = JSON.parse(nav); console.log('  DOMContentLoaded: ' + n.domContentLoaded + ' ms'); console.log('  load 完成       : ' + n.load + ' ms'); }

  await new Promise(function (r) { setTimeout(r, 2000); });
  if (THROTTLE > 1) {
    await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    console.log('\n（后续测量已开启 CPU ' + THROTTLE + 'x 降速，模拟中端平板）');
  }

  // —— B. 各页首次进入 ——
  console.log('\n=== B. 首次进入各页（含下载与初始化）===');
  const first = [];
  for (const p of PAGES) {
    await evaluate(c, RESET_OBS);
    await evaluate(c, "location.hash='" + p.url + "'");
    await new Promise(function (r) { setTimeout(r, 1500); });
    const stat = JSON.parse(await evaluate(c, READ_OBS));
    first.push({ name: p.name, stat: stat });
    console.log('  ' + pad(p.name, 6) + ' 长任务 ' + String(stat.longTasks.length).padStart(2) +
      ' 个 | 最长 ' + stat.worst.toFixed(0).padStart(4) + 'ms | 掉帧 ' + stat.jank +
      ' | DOM ' + stat.nodes);
  }

  // 等预取完成
  console.log('\n（等待页面预取完成…）');
  await new Promise(function (r) { setTimeout(r, 7000); });

  // —— C. 二次进入（日常来回切的真实成本）——
  console.log('\n=== C. 二次进入（预取后，日常来回切）===');
  const second = [];
  for (const p of PAGES) {
    await evaluate(c, RESET_OBS);
    await evaluate(c, "location.hash='" + p.url + "'");
    await new Promise(function (r) { setTimeout(r, 1200); });
    const stat = JSON.parse(await evaluate(c, READ_OBS));
    second.push({ name: p.name, stat: stat });
  }
  // 来回切两轮，取最差的一轮作为代表
  for (const p of PAGES) {
    await evaluate(c, RESET_OBS);
    await evaluate(c, "location.hash='#/'");
    await new Promise(function (r) { setTimeout(r, 700); });
    await evaluate(c, RESET_OBS);
    await evaluate(c, "location.hash='" + p.url + "'");
    await new Promise(function (r) { setTimeout(r, 1200); });
    const stat = JSON.parse(await evaluate(c, READ_OBS));
    const prev = second.find(function (x) { return x.name === p.name; });
    // 取两轮中较差的一次
    if (prev.stat.worst < stat.worst) { prev.stat = stat; }
  }
  second.forEach(function (x) {
    const s = x.stat;
    const flag = s.worst > BUDGET.revisitMs ? ' ✗' : ' ✓';
    console.log('  ' + pad(x.name, 6) + ' 长任务 ' + String(s.longTasks.length).padStart(2) +
      ' 个 | 最长 ' + s.worst.toFixed(0).padStart(4) + 'ms | 掉帧 ' + String(s.jank).padStart(2) +
      ' (' + (s.frames ? (s.jank / s.frames * 100).toFixed(1) : '0') + '%)' + flag);
  });

  // —— D. 交互反馈延迟 ——
  console.log('\n=== D. 交互反馈（点一下到下一帧）===');
  await evaluate(c, "location.hash='#/'");
  await new Promise(function (r) { setTimeout(r, 1500); });
  const interactive = await evaluate(c,
    "(function(){" +
    "var btn = document.querySelector('.tabbar-item, .app-nav-item, [class*=nav-item]');" +
    "if (!btn) return null;" +
    "var t0 = performance.now();" +
    "btn.click();" +
    "return new Promise(function(res){" +
    "requestAnimationFrame(function(){ requestAnimationFrame(function(){" +
    "res(performance.now() - t0);" +
    "});});" +
    "});" +
    "})()", true);
  if (interactive === null) console.log('  未找到导航元素（跳过）');
  else console.log('  点击 → 下一帧: ' + interactive.toFixed(1) + ' ms ' +
    (interactive <= BUDGET.interactionMs ? '✓' : '✗ 偏慢'));

  // —— 汇总 ——
  const allFirst = first.reduce(function (a, x) { return a + x.stat.worst; }, 0);
  const allSecond = second.reduce(function (a, x) { return a + x.stat.worst; }, 0);
  const maxFirst = Math.max.apply(null, first.map(function (x) { return x.stat.worst; }));
  const maxSecond = Math.max.apply(null, second.map(function (x) { return x.stat.worst; }));
  const maxBlock = Math.max.apply(null, second.map(function (x) { return x.stat.blocking; }));
  const totalJank = second.reduce(function (a, x) { return a + x.stat.jank; }, 0);
  const totalFrames = second.reduce(function (a, x) { return a + x.stat.frames; }, 0);

  console.log('\n=== 汇总（阈值：二次进入≤' + BUDGET.revisitMs + 'ms，长任务≤' + BUDGET.longTaskMs + 'ms，掉帧<5%）===');
  console.log('  首次进入最差      : ' + maxFirst.toFixed(0) + ' ms');
  console.log('  二次进入最差      : ' + maxSecond.toFixed(0) + ' ms ' + (maxSecond <= BUDGET.revisitMs ? '✓' : '✗'));
  console.log('  二次进入总阻塞    : ' + maxBlock.toFixed(0) + ' ms');
  console.log('  二次进入掉帧率    : ' + (totalFrames ? (totalJank / totalFrames * 100).toFixed(1) : '0') + '% ' +
    (totalFrames && totalJank / totalFrames < BUDGET.jankRate ? '✓' : '✗'));
  console.log('\n  逐页问题清单（按严重度）:');
  var issues = 0;
  second.concat(first).forEach(function (x) {
    if (x.stat.worst > BUDGET.longTaskMs) {
      issues++;
      console.log('    · ' + x.name + ': 最长阻塞 ' + x.stat.worst.toFixed(0) + 'ms');
    }
  });
  if (!issues) console.log('    无');

  c.ws.close();
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(function (e) {
  console.error('巡检失败:', e.message);
  process.exit(2);
});

function pad(s, n) {
  var w = 0;
  for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 255 ? 2 : 1;
  var sp = n - w;
  return s + new Array(Math.max(0, sp) + 1).join(' ');
}