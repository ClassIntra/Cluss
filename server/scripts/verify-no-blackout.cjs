/**
 * 切页黑屏回归检查：离场页是否仍在视口内
 *
 * 为什么不测像素：试了三轮都对不上（详见本文件末尾的记录）。
 * 改测**可判定的中间状态**：离场页在动画期间是否还在视口内。
 * 它若被移出视口（margin-top:-10000px 那版就是这样），画面上就只剩
 * html 底色 —— 深色模式下即「黑屏」，浅色下即「闪白」。
 * 这条因果链是确定的，不需要靠像素去猜。
 *
 * 判据：切换过程中，存在某一帧里「所有页面根容器的 top 都 < -100px」
 *       → 离场页被移出视口 → 黑屏。
 *
 * 跑法：node server/scripts/verify-no-blackout.cjs [baseUrl]
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:9061';
const PORT = Number(process.env.CDP_PORT || 9485);
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
    if (m.id && P.has(m.id)) { const r = P.get(m.id); P.delete(m.id); m.error ? r.reject(new Error(m.error.message)) : r.resolve(m.result); }
  });
  function send(me, pa) {
    const i = ++id;
    return new Promise(function (res, rej) {
      const t = setTimeout(function () { P.delete(i); rej(new Error('CDP 超时 ' + me)); }, 30000);
      P.set(i, { resolve: function (v) { clearTimeout(t); res(v); }, reject: function (e) { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id: i, method: me, params: pa || {} }));
    });
  }
  return { ws: ws, send: send, open: new Promise(function (r) { ws.addEventListener('open', r); }) };
}

(async function () {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-'));
  const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await new Promise(function (r) { setTimeout(r, 500); });
    try { await get('http://127.0.0.1:' + PORT + '/json/version'); break; } catch (e) {}
  }
  const ts = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
  const c = conn(ts.find(function (t) { return t.type === 'page'; }).webSocketDebuggerUrl);
  await c.open;
  await c.send('Page.enable'); await c.send('Runtime.enable');

  function E(e, a) {
    return c.send('Runtime.evaluate', { expression: e, awaitPromise: !!a, returnByValue: true })
      .then(function (r) { return r.result && r.result.value; });
  }

  await c.send('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 3500); });
  var acct = process.env.SETUP_ACCOUNT || 'uitester';
  var tok = await E("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:" + JSON.stringify(acct) + ",password:'Test1234'})}).then(r=>r.json()).then(j=>j&&j.data?j.data.token:'')", true);
  if (!tok || String(tok).length < 100) {
    console.error('✗ 登录失败（token 长度 ' + String(tok).length + '）');
    process.exit(2);
  }
  await E("localStorage.setItem('cluss_token'," + JSON.stringify(tok) + ");localStorage.setItem('token'," + JSON.stringify(tok) + ")");
  // ⚠️ 必须 reload：Vuex store 在 main.js 启动时就把 token 读进内存了，
  //   之后写 localStorage 不同步 —— 不 reload 路由守卫仍判定未登录。
  //   这已是第四次栽在「没落到已登录页面」上，所以这里**必须校验**：
  //   静默停在登录页会让后续所有测量变成「在登录页上量切页」，
  //   结果看起来正常（全 0 黑屏帧）却毫无意义。
  await c.send('Page.navigate', { url: BASE + '/#/' });
  await c.send('Page.reload');
  await new Promise(function (r) { setTimeout(r, 3500); });
  var landed = await E("JSON.stringify({hash: location.hash, chat: !!document.querySelector('.chat-page')})");
  var st = JSON.parse(landed);
  if (!st.chat) {
    console.error('✗ 未落到对话页（hash=' + st.hash + '），测量无意义');
    process.exit(2);
  }
  if (THROTTLE > 1) await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  // 采样器：每帧记录「所有页面根容器的 top」。留空 = 页面不在视口内。
  const SAMPLER = [
    "(function(){",
    " if (window.__nb) return 'already';",
    " window.__nb = { frames: [], on: false };",
    " var raf;",
    " var SEL = '.chat-page, .study-page, .writing-page, .notes-page, .wrong-page, .records-page, .cloud-page';",
    " function tick(){",
    "   if (!window.__nb.on) return;",
    "   var tops = [];",
    "   var els = document.querySelectorAll(SEL);",
    "   for (var i=0;i<els.length;i++){",
    "     var r = els[i].getBoundingClientRect();",
    "     if (r.height > 40) tops.push(Math.round(r.top));",
    "   }",
    "   window.__nb.frames.push({ t: Math.round(performance.now()), tops: tops, n: tops.length });",
    "   raf = requestAnimationFrame(tick);",
    " }",
    " window.__nb.start = function(){ window.__nb.frames=[]; window.__nb.on=true; raf=requestAnimationFrame(tick); };",
    " window.__nb.stop = function(){ window.__nb.on=false; if(raf)cancelAnimationFrame(raf); return window.__nb.frames; };",
    " return 'ok';",
    "})()"
  ].join('\n');
  await E(SAMPLER);

  const PAGES = [['学习', '/study'], ['作文', '/writing'], ['记录', '/records'], ['笔记', '/notes'], ['错题本', '/wrong-book'], ['云盘', '/cloud'], ['对话', '/']];

  console.log('切页黑屏回归检查（离场页是否被移出视口）');
  console.log('CPU ' + THROTTLE + 'x\n');

  var problems = 0;
  for (const p of PAGES) {
    await E("location.hash = '#/'");
    await new Promise(function (r) { setTimeout(r, 900); });

    await E("window.__nb.start(); location.hash = '#" + p[1] + "';");
    await new Promise(function (r) { setTimeout(r, 1200); });
    var frames = JSON.parse(await E("JSON.stringify(window.__nb.stop())"));

// 黑屏判据：**离场页被推到视口外**（top ≤ -100px）。
  //
  // ⚠️ 不能只判「视口里一个页面都没有」—— 修复前实测正是这种情况：
  //   离场页 top=-10000px、进入页 top=0，**进入页确实在视口内**，
  //   可画面上它的 opacity 是 0（还没淡入），于是整个视口只有 html 底色。
  //   「有没有节点在视口内」答不了这个问题，要看**有没有可见的页面**。
  //
  // 正确判据：切换期间存在某一帧，全部页面根容器的 top 都 ≤ -100px
  //   → 所有页面都被移出视口 → 画面只剩底色 → 黑屏。
  var minTopAll = Infinity;
  frames.forEach(function (f) { f.tops.forEach(function (t) { if (t < minTopAll) minTopAll = t; }); });
  var allOut = minTopAll <= -100;
  var bad = allOut;
  if (bad) problems++;
  console.log('  ' + p[0].padEnd(5) +
    '采样 ' + String(frames.length).padStart(3) + ' 帧' +
    ' 最低 top ' + String(minTopAll).padStart(8) + 'px' +
    (bad ? '  ← 离场页被移出视口（黑屏）' : '  ✓始终有页面留在视口内'));
  }

  console.log('\n=== 结论 ===');
  if (problems === 0) {
    console.log('  ✓ 七个页面切换全程都有页面留在视口内 —— 不会黑屏');
  } else {
    console.log('  ✗ ' + problems + ' 个页面检出「离场页被移出视口」，画面会只剩 html 底色');
  }
  console.log('\n注：本脚本只判「离场页是否被移出视口」，不测像素。');
  console.log('    像素口径试过三轮都测不准（见 measure-blackout 的取舍记录）。');

  c.ws.close(); ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(problems === 0 ? 0 : 1);
})().catch(function (e) { console.error('失败:', e.message); process.exit(2); });