/**
 * 性能门槛检查（CI 用）
 *
 * 为什么要有这个：性能数字如果只是「测一次看看」，下一个人改坏也没人知道。
 * 商业级的要求是**回归必须能被自动拦住**，而不是靠人记得手测。
 *
 * 门槛值全部来自实测（见 perf-baseline.json），不是拍的。
 * 环境：headless Chrome + CDP，CPU 降速 4 倍模拟中端平板。
 *
 * 跑法：
 *   node server/scripts/perf-gate.cjs [baseUrl]
 * 退出码：0 = 全部达标；1 = 有项超标（CI 应据此失败）
 *
 * 前置：需要一个跑着的实例，且已配好可用模型（流式那一项需要真SSE）。
 * 环境变量：SETUP_ACCOUNT / SETUP_PASSWORD / CPU_THROTTLE / PERF_SKIP_STREAM
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BASE = process.argv[2] || process.env.PERF_BASE || 'http://127.0.0.1:9046';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9415);
const THROTTLE = Number(process.env.CPU_THROTTLE || 4);
const SKIP_STREAM = process.env.PERF_SKIP_STREAM === '1';

const cfgPath = path.join(__dirname, 'perf-baseline.json');
if (!fs.existsSync(cfgPath)) {
  console.error('找不到 perf-baseline.json，门槛无从谈起');
  process.exit(2);
}
const CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const T = CFG['阈值'];

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

const PROBE = `
  window.__f=[];window.__lt=[];
  if(window.__fo)cancelAnimationFrame(window.__fo);
  var last=performance.now();
  (function t(){var n=performance.now();window.__f.push(n-last);last=n;window.__fo=requestAnimationFrame(t)})();
  if(window.__po){try{window.__po.disconnect()}catch(e){}}
  try{window.__po=new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt.push(Math.round(e.duration))})});window.__po.observe({entryTypes:['longtask']})}catch(e){}
  1`;
const READ = `
  (function(){
    if(window.__fo)cancelAnimationFrame(window.__fo);
    var f=window.__f||[];var lt=(window.__lt||[]).filter(function(d){return d>50});
    return JSON.stringify({jank:f.filter(function(d){return d>32}).length,frames:f.length,
      worst:f.reduce(function(m,d){return Math.max(m,d)},0),
      p95:(function(){if(!f.length)return 0;var s=f.slice().sort(function(a,b){return a-b});return s[Math.floor(s.length*.95)]})(),
      lt:lt,nodes:document.querySelectorAll('*').length});
  })()`;

let pass = 0, fail = 0;
function check(name, value, limit, unit, lowerIsBetter) {
  const ok = lowerIsBetter === false ? value >= limit : value <= limit;
  if (ok) { pass++; console.log('  ✓ ' + pad(name, 30) + fmt(value) + (unit || '') + '  (门槛 ' + (limit) + (unit || '') + ')'); }
  else {
    fail++;
    console.log('  ✗ ' + pad(name, 30) + fmt(value) + (unit || '') + '  ** 超过门槛 ' + limit + (unit || '') + ' **');
  }
  return ok;
}
function fmt(v) { return typeof v === 'number' ? (Math.round(v * 10) / 10).toString() : String(v); }
function pad(s, n) {
  var w = 0; for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 255 ? 2 : 1;
  return s + new Array(Math.max(0, n - w) + 1).join(' ');
}

const PAGES = [['学习', '/study'], ['作文', '/writing'], ['笔记', '/notes'], ['错题本', '/wrong-book'], ['云盘', '/cloud'], ['记录', '/records']];

(async function main() {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome，跳过（不等于通过）'); process.exit(2); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-gate-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

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

  console.log('性能门槛检查（CPU ' + THROTTLE + 'x 降速 ≈ 中端平板）');
  console.log('目标：' + BASE + '\n');

  // 登录
  await c.send('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 3500); });
  const tok = await E(c,
    "fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:" +
    JSON.stringify(process.env.SETUP_ACCOUNT || 'uitester') + ",password:" +
    JSON.stringify(process.env.SETUP_PASSWORD || 'Test1234') + "})}).then(r=>r.json()).then(j=>j&&j.data?j.data.token:'')", true);
  if (!tok) { console.error('登录失败，无法巡检'); chrome.kill(); process.exit(2); }
  await E(c, "localStorage.setItem('cluss_token'," + JSON.stringify(tok) + ");localStorage.setItem('token'," + JSON.stringify(tok) + ")");
  await c.send('Page.navigate', { url: BASE + '/' });
  await new Promise(function (r) { setTimeout(r, 3000); });
  await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  // 预热：每页进一遍让 prefetch 生效 —— 门槛衡量的是**日常使用**而非首次冷启
  for (const p of PAGES) { await E(c, "location.hash='#" + p[1] + "'"); await new Promise(function (r) { setTimeout(r, 1000); }); }
  await new Promise(function (r) { setTimeout(r, 6000); });

  // ---- 1. 交互反馈 ----
  console.log('【1】交互反馈');
  // ⚠️ 必须点**非当前页**的导航项：
  //   原实现取 querySelector 的第一个匹配项，那恰好是 `.router-link-active`
  //   （当前所在页）。点它等于「点已经在的页」，路由不切换、什么都不做 ——
  //   实测第 3~5 次只有 1.0ms，而第一次却要 96ms，
  //   同一个指标在 1ms 与 96ms 之间跳，门槛完全没有意义。
  //
  // 另外只测**第一个 rAF**：点击后浏览器需要先跑完事件处理与样式重算，
  // 才会在下一帧绘制。再等一个 rAF 测的是「两帧」，
  // 数值几乎是前者的两倍，与「点下去多久有反应」的体感不对应。
  var itSamples = [];
  var itFail = null;
  for (var itRound = 0; itRound < 5; itRound++) {
    // 先回到对话页，保证每次点的都是别的页
    await E(c, "location.hash='#/'");
    await new Promise(function (r) { setTimeout(r, 700); });
    var r = await E(c,
      "(function(){" +
      "var items = Array.prototype.slice.call(document.querySelectorAll('.tabbar-item, .app-nav-item, [class*=nav-item]'));" +
      "var b = items.find(function(x){ return !x.className.match(/router-link-active/); });" +
      "if (!b) return null;" +
      "var t0 = performance.now(); b.click();" +
      "return new Promise(function(res){ requestAnimationFrame(function(){ res(performance.now() - t0); }); });" +
      "})()", true);
    if (r === null) { itFail = '未找到非当前页的导航项'; break; }
    itSamples.push(r);
  }
  if (itFail) {
    console.log('  ! ' + itFail + '，本项记为不通过');
    fail++;
  } else {
    // 取中位数：单次采样会被 GC 与后台任务污染，中位数比均值更能反映常态
    var sorted = itSamples.slice().sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    check('点击 → 下一帧(中位数)', median, T['交互反馈_ms'], 'ms');
  }

  // ---- 2. 各页切入 ----
  console.log('\n【2】各页切入（预热后）');
  var worstAll = 0, p95All = 0, jankSum = 0, frameSum = 0, ltSum = 0;
  for (const p of PAGES) {
    var w = 0, p95 = 0, lt = 0, jk = 0, fr = 0;
    for (let round = 0; round < 2; round++) {
      await E(c, "location.hash='#/'"); await new Promise(function (r) { setTimeout(r, 650); });
      await E(c, PROBE);
      await E(c, "location.hash='#" + p[1] + "'");
      await new Promise(function (r) { setTimeout(r, 1200); });
      var s = JSON.parse(await E(c, READ));
      if (s.worst > w) w = s.worst;
      if (s.p95 > p95) p95 = s.p95;
      lt += s.lt.length; jk += s.jank; fr += s.frames;
    }
    worstAll = Math.max(worstAll, w); p95All = Math.max(p95All, p95);
    jankSum += jk; frameSum += fr; ltSum += lt;
  }
  check('切页最差帧', worstAll, T['切页最差帧_ms'], 'ms');
  check('切页 P95 帧', p95All, T['切页_P95帧_ms'], 'ms');
  check('切页掉帧率', frameSum ? jankSum / frameSum : 0, T['切页掉帧率'], '');
  check('切页长任务数', ltSum, T['切页长任务数'], ' 个');

  // ---- 3. 笔记页 DOM规模 ----
  console.log('\n【3】笔记页 DOM 规模');
  // ⚠️ 必须先造数据再测：库里没笔记时列表是空的，DOM 节点数与渲染条目数
  //   都接近 0，门槛形同虚设 —— 实测就出现过「0 个条目通过门槛」这种假通过。
  var seeded = await E(c, `
    (function(){
      var files = [];
      var body = '性能门槛测试用正文。'.repeat(160);
      for (var i = 0; i < 60; i++) {
        files.push({
          id: 'gate_note_' + i,
          title: '门槛测试笔记 ' + i,
          content: body + ' 第' + i + '篇',
          tags: i % 2 ? ['数学', '复习'] : [],
          folder: '默认',
          updatedAt: Date.now() - i * 60000,
          createdAt: Date.now() - i * 60000,
          versions: [], annotations: []
        });
      }
      localStorage.setItem('notes_data', JSON.stringify({
        files: files, privateFiles: [], activeFileId: 'gate_note_0',
        viewMode: 'split', folders: ['全部', '默认'],
        activeFolder: '全部', sortBy: 'updatedAt'
      }));
      return files.length;
    })()
  `);
  await c.send('Page.navigate', { url: BASE + '/#/notes' });
  await new Promise(function (r) { setTimeout(r, 2500); });

  var lis = await E(c, "document.querySelectorAll('.file-item').length");
  if (!seeded || lis === 0) {
    console.log('  ! 笔记数据注入失败（渲染条目 ' + lis + '），本项记为不通过 —— 空列表会让门槛形同虚设');
    fail += 3;
  } else {
    console.log('  （已注入 ' + seeded + ' 篇笔记）');
    check('笔记列表渲染条目', lis, 40, ' 个');
    await E(c, "location.hash='#/'");
    await new Promise(function (r) { setTimeout(r, 900); });
    await E(c, PROBE);
    await E(c, "location.hash='#/notes'");
    await new Promise(function (r) { setTimeout(r, 1400); });
    var ns = JSON.parse(await E(c, READ));
    check('笔记页 DOM 节点', ns.nodes, T['笔记页DOM节点'], ' 个');
    check('笔记页切入长任务', ns.lt.length, T['笔记页切入长任务数'], ' 个');
    check('笔记页切入最差帧', ns.worst, T['笔记页切入最差帧_ms'], 'ms');
  }

  // ---- 4. 流式输出 ----
  if (SKIP_STREAM) {
    console.log('\n【4】流式输出 —— 已按 PERF_SKIP_STREAM=1 跳过');
  } else {
    console.log('\n【4】流式输出（真实 SSE）');
    await E(c, "location.hash='#/'");
    await new Promise(function (r) { setTimeout(r, 1500); });
    await E(c, PROBE);
    var sent = await E(c,
      "(function(){var ta=document.querySelector('textarea');" +
      "var b=Array.prototype.slice.call(document.querySelectorAll('button')).find(function(x){return (x.textContent||'').indexOf('发送')>=0});" +
      "if(!ta||!b)return 'no';ta.value='讲解二次函数顶点';ta.dispatchEvent(new Event('input',{bubbles:true}));b.click();return 'ok'})()");
    if (sent !== 'ok') {
      console.log('  ! 未找到输入框/发送按钮，流式项记为不通过');
      fail++;
    } else {
      for (var i = 0; i < 40; i++) {
        await new Promise(function (r) { setTimeout(r, 500); });
        var done = await E(c, "(document.querySelectorAll('[class*=assistant]').length>0 && !document.querySelector('.stop-btn'))?1:0");
        if (done) break;
      }
      var ss = JSON.parse(await E(c, READ));
      check('流式 P95 帧', ss.p95, T['流式_P95帧_ms'], 'ms');
      check('流式掉帧率', ss.frames ? ss.jank / ss.frames : 0, T['流式掉帧率'], '');
      check('流式长任务数', ss.lt.length, T['流式长任务数'], ' 个');
    }
  }

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (fail > 0) {
    console.log('\n有性能项超标。若确认是环境差异（如 CI 机器更慢）而非代码退化，');
    console.log('可调整 CPU_THROTTLE 后重跑；**不要**为了让 CI 变绿而放宽 perf-baseline.json。');
  }

  c.ws.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('门槛检查失败:', e.message);
  process.exit(2);
});