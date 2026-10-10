/**
 * 真实数据规模下的性能巡检
 *
 * 为什么要单独做：空库巡检测的是「理想情况」，而学生用了几个月后
 * localStorage 里有几十篇笔记、localStorage 里存着历史会话。
 * 那些才是真实的卡顿来源 —— 特别是 Notes 的搜索（每次按键全量扫描所有正文）
 * 与 filteredFiles 的排序。
 *
 * 造什么数据：
 *   - Notes：60篇笔记，正文各约 4KB（贴近真实笔记长度）
 *   - 长笔记：1篇 40KB 的，测极端情况
 *   - 会话列表：20条
 *
 * 跑法：node server/scripts/perf-real-data.cjs [baseUrl]
 * 前置：脚本会自动通过 CDP 注入 localStorage（仅测试库，勿对生产用）
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:9041';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9388);
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

function ev(c, expr, aw) {
  return c.send('Runtime.evaluate', { expression: expr, awaitPromise: !!aw, returnByValue: true })
    .then(function (r) { return r.result && r.result.value; });
}

// 造真实规模的笔记数据
const SEED = `
(function(){
  var files = [];
  var body = '这是一段用于性能测试的笔记正文内容。'.repeat(160); // 约 4KB
  for (var i = 0; i < 60; i++) {
    files.push({
      id: 'perf_note_' + i,
      title: '性能测试笔记 ' + i,
      content: body + ' 第' + i + '篇的额外内容',
      tags: ['数学', '复习'],
      folder: '默认',
      updatedAt: Date.now() - i * 60000,
      createdAt: Date.now() - i * 60000,
      versions: [], annotations: []
    });
  }
  // 一篇超长笔记，测极端情况
  files.push({
    id: 'perf_note_long',
    title: '超长笔记压力测试',
    content: '超长内容测试。'.repeat(3500), // 约 40KB
    tags: ['长文'], folder: '默认',
    updatedAt: Date.now(), createdAt: Date.now(),
    versions: [], annotations: []
  });
  var data = {
    files: files,
    privateFiles: [],
    activeFileId: 'perf_note_0',
    viewMode: 'split',
    folders: ['全部', '默认'],
    activeFolder: '全部',
    sortBy: 'updatedAt'
  };
  localStorage.setItem('notes_data', JSON.stringify(data));
  return files.length;
})()
`;

const RESET = `
  window.__lt = []; window.__frames = [];
  if (window.__po) { try { window.__po.disconnect(); } catch(e){} }
  try {
    window.__po = new PerformanceObserver(function(l){
      l.getEntries().forEach(function(e){ window.__lt.push(e.duration); });
    });
    window.__po.observe({ entryTypes: ['longtask'] });
  } catch(e){}
  window.__last = performance.now(); window.__on = true;
  (function tick(){
    if(!window.__on) return;
    var n = performance.now();
    window.__frames.push(n - window.__last); window.__last = n;
    requestAnimationFrame(tick);
  })();
`;
const READ = `
  (function(){
    window.__on = false;
    var lt = window.__lt||[], fr = window.__frames||[];
    var long = lt.filter(function(d){return d>50});
    return JSON.stringify({
      longTasks: long, worst: long.reduce(function(m,d){return Math.max(m,d)},0),
      blocking: long.reduce(function(s,d){return s+(d-50)},0),
      frames: fr.length, jank: fr.filter(function(d){return d>32}).length,
      avgFrame: fr.reduce(function(s,d){return s+d},0)/Math.max(1,fr.length),
      nodes: document.querySelectorAll('*').length
    });
  })()
`;

(async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-real-'));
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
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Performance.enable');

  // 登录
  await c.send('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 3500); });
  const tok = await ev(c,
    "fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:" +
    JSON.stringify(process.env.SETUP_ACCOUNT || 'uitester') + ",password:" +
    JSON.stringify(process.env.SETUP_PASSWORD || 'Test1234') +
    "})}).then(r=>r.json()).then(j=>j&&j.data?j.data.token:'')", true);
  if (!tok) { console.error('登录失败'); chrome.kill(); process.exit(2); }
  await ev(c, "localStorage.setItem('cluss_token'," + JSON.stringify(tok) + ");localStorage.setItem('token'," + JSON.stringify(tok) + ")");

  // 确认 localStorage 的 key 名（Notes.vue 里的 NOTES_STORAGE_KEY）
  const key = await ev(c, "(function(){try{return localStorage.getItem('cluss_notes_data')?'cluss_notes_data':''}catch(e){return ''}})()");
  console.log('（探测存储键：' + (key || '未找到') + '）');

  // 注入数据（未降速，注入本身不耗时）
  await c.send('Page.navigate', { url: BASE + '/' });
  await new Promise(function (r) { setTimeout(r, 2500); });

  // 从构建产物里找真实的 key
  const realKey = await ev(c, "(function(){return Object.keys(localStorage).join(',')})()");
  console.log('localStorage 现有键：' + realKey);

  const NOTES_KEY = 'notes_data';
  const n = await ev(c, SEED.replace(/cluss_notes_data/g, NOTES_KEY));
  console.log('已注入 ' + n + ' 篇笔记（含 1 篇 40KB 超长篇）');

  if (THROTTLE > 1) {
    await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    console.log('CPU ' + THROTTLE + 'x 降速已开启\n');
  }

  // —— 1. 带 61 篇笔记进入笔记页 ——
  console.log('=== 1. 真实数据下进入笔记页 ===');
  await ev(c, RESET);
  await ev(c, "location.hash='#/notes'");
  await new Promise(function (r) { setTimeout(r, 2000); });
  let s = JSON.parse(await ev(c, READ));
  console.log('  长任务 ' + s.longTasks.length + ' 个 | 最长 ' + s.worst.toFixed(0) + 'ms | DOM ' + s.nodes + ' 节点');

  // —— 2. 搜索输入（每次按键全量扫描所有正文）——
  console.log('\n=== 2. 搜索框输入（每次按键应只扫一次）===');
  await ev(c, RESET);
  const inputT = await ev(c, `
    (function(){
      var inputs = Array.prototype.slice.call(document.querySelectorAll('input'));
      var si = inputs.find(function(i){ return (i.placeholder||'').indexOf('搜索') >= 0; });
      if (!si) return null;
      var t0 = performance.now();
      si.focus();
      // Vue 的 v-model 绑在 input 事件上，必须用真实输入方式
      si.value = '性能';
      si.dispatchEvent(new Event('input', { bubbles: true }));
      return performance.now() - t0;
    })()
  `);
  if (inputT === null) console.log('  未找到搜索框');
  else {
    await new Promise(function (r) { setTimeout(r, 900); });
    s = JSON.parse(await ev(c, READ));
    console.log('  单次输入同步耗时 ' + inputT.toFixed(1) + 'ms');
    console.log('  长任务 ' + s.longTasks.length + ' 个 | 最长 ' + s.worst.toFixed(0) + 'ms');
  }

  // —— 3. 逐字输入（真实打字场景）——
  console.log('\n=== 3. 逐字输入 4 个字符（真实打字）===');
  await ev(c, RESET);
  await ev(c, `
    (function(){
      var inputs = Array.prototype.slice.call(document.querySelectorAll('input'));
      var si = inputs.find(function(i){ return (i.placeholder||'').indexOf('搜索') >= 0; });
      if (!si) return 0;
      si.focus(); si.value = '';
      var text = '性能测试笔记';
      for (var i = 0; i < 4; i++) {
        si.value = text.slice(0, i+1);
        si.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return 4;
    })()
  `);
  await new Promise(function (r) { setTimeout(r, 1200); });
  s = JSON.parse(await ev(c, READ));
  console.log('  长任务 ' + s.longTasks.length + ' 个 | 最长 ' + s.worst.toFixed(0) + 'ms | 掉帧 ' + s.jank);

  // —— 4. 打开那篇 40KB 超长笔记（mermaid + markdown 渲染）——
  console.log('\n=== 4. 打开 40KB 超长笔记（渲染压力）===');
  await ev(c, RESET);
  const openT = await ev(c, `
    (function(){
      var items = Array.prototype.slice.call(document.querySelectorAll('.file-item, [class*=file-item]'));
      var target = items.find(function(el){ return (el.textContent||'').indexOf('超长') >= 0; });
      if (!target) return null;
      var t0 = performance.now();
      target.click();
      return performance.now() - t0;
    })()
  `);
  await new Promise(function (r) { setTimeout(r, 2500); });
  s = JSON.parse(await ev(c, READ));
  console.log('  点击同步耗时 ' + (openT !== null ? openT.toFixed(1) : '?') + 'ms');
  console.log('  长任务 ' + s.longTasks.length + ' 个 | 最长 ' + s.worst.toFixed(0) + 'ms | DOM ' + s.nodes);

  // —— 5. 编辑器输入（打字时是否整篇重排）——
  console.log('\n=== 5. 编辑器逐字输入（打字流畅度）===');
  await ev(c, RESET);
  const typeT = await ev(c, `
    (function(){
      var ta = document.querySelector('textarea, [contenteditable="true"]');
      if (!ta) return null;
      ta.focus();
      var t0 = performance.now();
      var text = '的性能测试输入';
      for (var i = 0; i < 5; i++) {
        ta.value = (ta.value||'') + text[i];
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return performance.now() - t0;
    })()
  `);
  await new Promise(function (r) { setTimeout(r, 1200); });
  s = JSON.parse(await ev(c, READ));
  console.log('  5 字同步耗时 ' + (typeT !== null ? typeT.toFixed(1) : '?') + 'ms');
  console.log('  长任务 ' + s.longTasks.length + ' 个 | 最长 ' + s.worst.toFixed(0) + 'ms');

  // —— 汇总 ——
  console.log('\n=== 真实数据下的问题清单 ===');
  var problems = [];
  if (s.worst > 200) problems.push('编辑器输入阻塞 ' + s.worst.toFixed(0) + 'ms');
  console.log(problems.length ? problems.map(function (p) { return '· ' + p; }).join('\n') : '（详见上方各项）');

  c.ws.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(function (e) { console.error('失败:', e.message); process.exit(2); });