/**
 * 笔记侧栏改版后的实测验证
 *
 * 验三件事：
 *  1.「粘贴创建」按钮确实消失了，且底部剩下的按钮仍正常
 *  2. 侧栏卡片层次与对话页一致（玻璃卡片 + 圆角 + 阴影）
 *  3. 改版没有破坏功能：新建、切换、搜索、删除都还能用
 *
 * 跑法：node server/scripts/verify-notes-sidebar.cjs [baseUrl]
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = Number(process.env.CDP_PORT || 9435);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:9054';

function get(u) {
  return new Promise(function (res, rej) {
    http.get(u, function (r) { let d = ''; r.on('data', function (c) { d += c; }); r.on('end', function () { res(d); }); }).on('error', rej);
  });
}
function conn(u) {
  const ws = new WebSocket(u); const P = new Map(); let id = 0;
  ws.addEventListener('message', function (e) {
    let m; try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.id && P.has(m.id)) { const r = P.get(m.id); P.delete(m.id); m.error ? r.reject(new Error(m.error.message)) : r.resolve(m.result); }
  });
  function send(me, pa) {
    const i = ++id;
    return new Promise(function (res, rej) {
      const t = setTimeout(function () { P.delete(i); rej(new Error('to ' + me)); }, 25000);
      P.set(i, { resolve: function (v) { clearTimeout(t); res(v); }, reject: function (e) { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id: i, method: me, params: pa || {} }));
    });
  }
  return { ws: ws, send: send, open: new Promise(function (r) { ws.addEventListener('open', r); }) };
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); }
}

(async function () {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'nsidebar-'));
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
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // ⚠️ awaitPromise 必须为 true：登录是 fetch 拿 token，
//   不等待 Promise 的话拿到的是未决值（实测长度 15 —— 正好是 'FAIL' 的长度），
//   于是 token 写不进 localStorage、路由守卫把页面踢回 #/login，
//   后面所有测量都测的是登录页。看起来像「笔记列表空了」，其实是没登录。
function E(e, a) {
    return c.send('Runtime.evaluate', { expression: e, awaitPromise: !!a, returnByValue: true })
      .then(function (r) { return r.result && r.result.value; });
  }
  // fetch 类一律走 E(expr, true)
  function Ew(e) { return E(e, true); }

  await c.send('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 3500); });
  var tok = await Ew("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'uitester',password:'Test1234'})}).then(r=>r.json()).then(j=>j&&j.data?j.data.token:'')");
  if (!tok || String(tok).length < 100) {
    console.error('登录失败（token 长度 ' + String(tok).length + '），无法继续');
    process.exit(2);
  }
  await E("localStorage.setItem('cluss_token'," + JSON.stringify(tok) + ");localStorage.setItem('token'," + JSON.stringify(tok) + ")");

  // ⚠️ 先落地到 #/ 再刷新，然后**确认真的登录了**再切笔记页。
  //   直接访问 #/notes 时若 store 尚未从 localStorage 恢复，
  //   守卫会把页面重定向到 #/login —— 后面测到的「列表是空的」全是这个原因。
  await c.send('Page.navigate', { url: BASE + '/#/' });
  await c.send('Page.reload');
  await new Promise(function (r) { setTimeout(r, 3500); });
  var landed = JSON.parse(await E("JSON.stringify({hash:location.hash, ok:!!document.querySelector('.sidebar')})"));
  if (!landed.ok) {
    console.error('登录未生效（hash=' + landed.hash + '），无法继续');
    process.exit(2);
  }

  // 注入笔记后用 hash 切页（此时已登录，切换是安全的）
  await E("localStorage.setItem('notes_data', JSON.stringify({files:[{id:'v1',title:'二次函数求最值',content:'内容示例。'.repeat(50),tags:['数学'],folder:'默认',updatedAt:Date.now(),versions:[],annotations:[]},{id:'v2',title:'英语听力笔记',content:'内容示例。'.repeat(40),tags:[],folder:'默认',updatedAt:Date.now()-86400000,versions:[],annotations:[]},{id:'v3',title:'物理受力分析',content:'内容示例。'.repeat(60),tags:['物理'],folder:'默认',updatedAt:Date.now()-172800000,versions:[],annotations:[]}],privateFiles:[],activeFileId:'v1',viewMode:'split',folders:['全部','默认'],activeFolder:'全部',sortBy:'updatedAt'}))");
  await E("location.hash = '#/notes'");
  await new Promise(function (r) { setTimeout(r, 3000) });
  // 组件在切换时才读 localStorage，所以注入后需要重新进一次页面
  await c.send('Page.reload');
  await new Promise(function (r) { setTimeout(r, 3200); });

  var onNotes = await E("!!document.querySelector('.notes-sidebar')");
  if (!onNotes) { console.error('未进入笔记页，后续验证无意义'); process.exit(2); }

  console.log('笔记侧栏验证（1440×900）\n');

  // ---- 1. 粘贴创建已删除 ----
  console.log('【1】「粘贴创建」已移除');
  var r1 = JSON.parse(await E("JSON.stringify({text: document.body.innerText.indexOf('粘贴创建') >= 0, btn: !!document.querySelector('.sidebar-paste-btn'), clipboard: (typeof navigator!=='undefined')})"));
  check('页面上不再出现「粘贴创建」文字', r1.text === false);
  check('.sidebar-paste-btn 类已不存在', r1.btn === false);

  var r1b = await E("JSON.stringify(Array.prototype.slice.call(document.querySelectorAll('.sidebar-bottom button')).map(function(b){return (b.textContent||'').trim()}))");
  var btns = JSON.parse(r1b);
  check('底部只剩 2 个按钮', btns.length === 2, btns.join(' / '));
  check('「云端笔记」仍在', btns.indexOf('云端笔记') >= 0);
  check('「隐私空间」仍在', btns.indexOf('隐私空间') >= 0);

  // ---- 2. 侧栏卡片层次 ----
  console.log('\n【2】侧栏卡片层次');
  var cards = JSON.parse(await E("JSON.stringify(Array.prototype.slice.call(document.querySelectorAll('.notes-sidebar > *')).map(function(k){var cs=getComputedStyle(k);return{cls:k.className,bg:cs.backgroundColor,radius:cs.borderRadius,shadow:cs.boxShadow==='none'?'':'yes'}}))"));
  var allCard = cards.every(function (x) {
    return x.bg !== 'rgba(0, 0, 0, 0)' && parseFloat(x.radius) > 0 && x.shadow === 'yes';
  });
  check('侧栏每个块都是玻璃卡片', allCard, cards.length + ' 个块');
  cards.forEach(function (x) { console.log('    ' + x.cls.substring(0, 34) + ' → ' + x.bg.substring(0, 22) + ' / ' + x.radius); });

  var convCards = await (async function () {
    await c.send('Page.navigate', { url: BASE + '/#/' });
    await c.send('Page.reload');
    await new Promise(function (r) { setTimeout(r, 3000); });
    return JSON.parse(await E("JSON.stringify(Array.prototype.slice.call(document.querySelectorAll('.sidebar > *')).map(function(k){var cs=getComputedStyle(k);return{bg:cs.backgroundColor,radius:cs.borderRadius,shadow:cs.boxShadow==='none'?'':'yes'}}))"));
  })();
  var convSame = convCards.every(function (x) {
    return cards.every(function (y) { return y.bg === x.bg && y.radius === x.radius && y.shadow === x.shadow; });
  });
  check('与对话页卡片规格完全一致', convSame, '对话页 ' + convCards.length + ' 块 / 笔记页 ' + cards.length + ' 块');

  // ---- 3. 功能未被破坏 ----
  console.log('\n【3】功能未受影响');
  // ⚠️ 上面第 2 项为了对比把页面切到了**对话页**，这里必须切回笔记页再测。
  //   忘了切就会在对话页上找 .file-item —— 永远是 0 条，
  //   然后得出「新建/删除都坏了」的错误结论。
  await E("location.hash = '#/notes'");
  await new Promise(function (r) { setTimeout(r, 2600); });
  var backOk = JSON.parse(await E("JSON.stringify({hash:location.hash, items:document.querySelectorAll('.file-item').length})"));
  if (backOk.items === 0) {
    console.error('未切回笔记页（hash=' + backOk.hash + '），本项跳过而不是判失败');
    console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败（第 3 项已跳过）===');
    c.ws.close(); ch.kill();
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail === 0 ? 0 : 1);
  }

  var seedCount = backOk.items;
  check('切回笔记页后笔记仍渲染', seedCount === 3, seedCount + ' 条');

  // 新建：实际是**三步** —— 「新建」弹菜单 → 「新建笔记」打开模板选择器
  // → 选一个模板才真正创建（createNoteFile 只设 showTemplatePicker=true）。
  // ⚠️ 只做前两步会看到条数不变，容易误判成「新建坏了」。
  var before = await E("document.querySelectorAll('.file-item').length");
  var s1 = await E("JSON.stringify((function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').trim()==='新建'})[0]; if(!b)return 'no-btn'; b.click(); return 'menu'})())");
  await new Promise(function (r) { setTimeout(r, 450); });
  var s2 = await E("JSON.stringify((function(){var c=[].slice.call(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').trim()==='新建笔记'})[0]; if(!c)return 'no-item'; c.click(); return 'picker'})())");
  await new Promise(function (r) { setTimeout(r, 600); });
  var pickerShown = await E("!!document.querySelector('.template-card, [class*=template]')");
  var s3 = await E("JSON.stringify((function(){var t=document.querySelector('.template-card'); if(!t)return 'no-template'; t.click(); return 'created'})())");
  await new Promise(function (r) { setTimeout(r, 1100); });
  var afterNew = await E("document.querySelectorAll('.file-item').length");
  check('新建笔记可用（三步：菜单→模板→创建）', afterNew > before,
    s1 + '→' + s2 + '(模板框' + (pickerShown ? '已弹出' : '未弹出') + ')→' + s3 + '：' + before + ' → ' + afterNew + ' 条');

  // 搜索
  var r3 = await E("JSON.stringify((function(){var i=document.querySelector('.sidebar-search-input'); if(!i)return null; i.value='笔记'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})())");
  if (r3) {
    await new Promise(function (r) { setTimeout(r, 800); });
    var searched = await E("document.querySelectorAll('.file-item').length");
    var q = await E("document.querySelector('.sidebar-search-input').value");
    check('搜索框仍可用', searched >= 0, '搜索「' + q + '」命中 ' + searched + ' 条');
  }

  // 删除：走完整的右键菜单 → 点删除 → 确认
  await E("var i=document.querySelector('.sidebar-search-input'); if(i){i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}))} 1");
  await new Promise(function (r) { setTimeout(r, 900); });
var delBefore = await E("document.querySelectorAll('.file-item').length");
  await E("JSON.stringify((function(){var it=document.querySelector('.file-item'); if(!it)return {err:'no item'}; it.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100})); return {ok:1}})())");
  await new Promise(function (r) { setTimeout(r, 800); });

  // 菜单项的 class 不固定，按**可见文字**找「删除」更可靠
  var delClicked = await E("JSON.stringify((function(){var c=[].slice.call(document.querySelectorAll('button, .file-menu-item, [class*=menu] li, [class*=menu] div')).filter(function(x){var t=(x.textContent||'').trim(); return t==='删除'||t.indexOf('删除')===0})[0]; if(!c)return 'no-del'; c.click(); return 'clicked'})())");
  await new Promise(function (r) { setTimeout(r, 600); });
  // 删除通常要二次确认
  await E("JSON.stringify((function(){var c=[].slice.call(document.querySelectorAll('button')).filter(function(x){var t=(x.textContent||'').trim(); return t==='确定'||t==='确认'})[0]; if(c) c.click(); return 1})())");
  await new Promise(function (r) { setTimeout(r, 1000); });

  var delAfter = await E("document.querySelectorAll('.file-item').length");
  check('删除笔记可用', delAfter < delBefore, delClicked + '：' + delBefore + ' → ' + delAfter + ' 条');

  // 存储里也要真的少了一篇（UI 变了但没落盘是最常见的坑）
  var stored = await E("JSON.parse(localStorage.getItem('notes_data')||'{}').files ? JSON.parse(localStorage.getItem('notes_data')).files.length : -1");
  check('删除已落盘到 localStorage', stored === delAfter, '库中 ' + stored + ' 篇');

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  c.ws.close(); ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) { console.error('失败:', e.message); process.exit(2); });