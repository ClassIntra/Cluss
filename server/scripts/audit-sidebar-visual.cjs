/**
 * 笔记侧栏与其他页面的视觉一致性对照
 *
 * 为什么用测量而不是看截图：「怪」是主观的，但可以拆成可测的属性 ——
 * 有没有卡片底、有没有圆角、有没有边框、内边距、层级对比度。
 * 读完数据就知道差在哪，而不是靠感觉来回猜。
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = Number(process.env.CDP_PORT || 9430);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:9052';

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

(async function () {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-cmp-'));
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

  function E(e, a) {
    return c.send('Runtime.evaluate', { expression: e, awaitPromise: !!a, returnByValue: true })
      .then(function (r) { return r.result && r.result.value; });
  }

  await c.send('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 3500); });
  const tok = await E("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'uitester',password:'Test1234'})}).then(r=>r.json()).then(j=>j&&j.data?j.data.token:'')", true);
  await E("localStorage.setItem('cluss_token'," + JSON.stringify(tok) + ");localStorage.setItem('token'," + JSON.stringify(tok) + ")");
  // ⚠️ 必须**整页重新加载**：store 在 main.js 初始化时就把 token 读进内存了
  //   （store/auth.js:6），之后再写 localStorage 不会同步到 Vuex，
  //   路由守卫只看内存里的值 → 仍然判定未登录。
  //   之前两次都栽在这里：一次是改 hash 触发守卫，一次是 navigate 到 #/。
  await c.send('Page.reload');
  await new Promise(function (r) { setTimeout(r, 3500); });
  var onPage = await E("JSON.stringify({hash:location.hash, conv:!!document.querySelector('.conv-panel')})");
  console.log('登录后落地：' + onPage);
  if (JSON.parse(onPage).hash.indexOf('login') >= 0) {
    console.error('仍未登录，后续测量无意义');
    c.ws.close(); ch.kill();
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
    process.exit(2);
  }
  console.log('');

  // 注入一些笔记，否则文件栏是空的测不出东西
  await E("localStorage.setItem('notes_data', JSON.stringify({files:[{id:'n1',title:'二次函数求最值',content:'内容示例内容。'.repeat(60),tags:['数学'],folder:'默认',updatedAt:Date.now(),versions:[],annotations:[]},{id:'n2',title:'英语听力笔记',content:'内容示例内容。'.repeat(40),tags:[],folder:'默认',updatedAt:Date.now()-86400000,versions:[],annotations:[]},{id:'n3',title:'物理受力分析',content:'内容示例内容。'.repeat(80),tags:['物理','复习'],folder:'默认',updatedAt:Date.now()-172800000,versions:[],annotations:[]}],privateFiles:[],activeFileId:'n1',viewMode:'split',folders:['全部','默认'],activeFolder:'全部',sortBy:'updatedAt'}))");

  // 侧栏的视觉属性：每一项都要能量出来
  var PROBE = `
    (function(){
      function desc(sel){
        var el = document.querySelector(sel);
        if (!el) return null;
        var cs = getComputedStyle(el);
        var r = el.getBoundingClientRect();
        return {
          sel: sel,
          bg: cs.backgroundColor,
          bgImage: cs.backgroundImage === 'none' ? '' : 'has-gradient',
          radius: cs.borderRadius,
          border: cs.borderTopWidth + ' ' + cs.borderTopColor,
          shadow: cs.boxShadow === 'none' ? '' : 'yes',
          blur: cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : '',
          pad: cs.padding,
          gap: cs.gap,
          radiusBox: Math.round(r.width) + 'x' + Math.round(r.height)
        };
      }
      var side = document.querySelector('.app-sidebar-drawer');
      var out = { sideWidth: side ? Math.round(side.getBoundingClientRect().width) : 0, items: [], sideCls: '' };
      // ⚠️ 必须确认取到的确实是**当前页可见的**侧栏。
      //   querySelector 取第一个匹配 —— 若页面里有隐藏的抽屉副本，
      //   就会把别页（或本页隐藏态）的结构当成当前页，测出「两页一样」的假结论。
      if (side) {
        var sr = side.getBoundingClientRect();
        var cs0 = getComputedStyle(side);
        var visible = sr.width > 0 && sr.height > 0 &&
          cs0.display !== 'none' && cs0.visibility !== 'hidden';
        out.sideCls = side.className;
        out.sideVisible = visible;
        out.sideRect = Math.round(sr.width) + 'x' + Math.round(sr.height);
        if (!visible) out.warn = '侧栏不可见 —— 测量结果不可信';
      }
      // 侧栏里所有直接子块（= 视觉分层的基本单位）
      if (side) {
        var kids = Array.prototype.slice.call(side.children);
        kids.forEach(function(k){
          var cs = getComputedStyle(k);
          out.items.push({
            cls: k.className || k.tagName,
            bg: cs.backgroundColor,
            radius: cs.borderRadius,
            shadow: cs.boxShadow === 'none' ? '' : 'yes',
            pad: cs.padding
          });
        });
      }
      return JSON.stringify(out);
    })()
  `;

var results = {};
  for (const p of [['对话', '/'], ['笔记', '/notes']]) {
    // 用整页加载而非改 hash：hash 切换会复用同一个应用实例，
    // 组件可能来不及重建（实测第一次就因为这个把登录页当成了笔记页）。
    await c.send('Page.navigate', { url: BASE + '/#' + p[1] });
    await c.send('Page.reload');
    await new Promise(function (r) { setTimeout(r, 3200); });
    var where = await E("JSON.stringify({hash:location.hash, notes:!!document.querySelector('.notes-sidebar'), conv:!!document.querySelector('.conv-panel')})");
    var w = JSON.parse(where);
    var expected = p[0] === '笔记' ? w.notes : w.conv;
    console.log('→ 切到' + p[0] + '：hash=' + w.hash + '  ' + (expected ? '✓ 已切换' : '✗ 未切换，结果不可信'));
    results[p[0]] = JSON.parse(await E(PROBE));
  }
  console.log('');

  console.log('侧栏视觉对照（1440×900 横屏）\n');
  ['对话', '笔记'].forEach(function (name) {
    const r = results[name];
    console.log('【' + name + '】侧栏宽 ' + r.sideWidth + 'px  class="' + r.sideCls + '"' +
      (r.sideVisible === false ? '  ⚠ 不可见，结论不可信' : '') + (r.warn ? '  ' + r.warn : ''));
    if (!r.items.length) { console.log('  （无子元素）\n'); return; }
    console.log('  ' + '子块'.padEnd(6) + '底色'.padEnd(26) + '圆角'.padEnd(10) + '阴影  内边距');
    r.items.forEach(function (it) {
      console.log('  ' + String(it.cls).substring(0, 22).padEnd(24) +
        String(it.bg).substring(0, 24).padEnd(26) +
        String(it.radius).substring(0, 8).padEnd(10) +
        String(it.shadow || '-').padEnd(6) + it.pad);
    });
    console.log('');
  });

  // 差异总结
  var chat = results['对话'], notes = results['笔记'];
  function hasCard(x) { return x.items.some(function (i) { return i.bg !== 'rgba(0, 0, 0, 0)' && i.bg !== 'transparent'; }); }
  function radiusOn(x) { return x.items.some(function (i) { return parseFloat(i.radius) > 0; }); }
  function shadowOn(x) { return x.items.some(function (i) { return i.shadow === 'yes'; }); }

  console.log('=== 差异判定 ===');
  [['卡片底色', hasCard], ['圆角', radiusOn], ['阴影', shadowOn]].forEach(function (pair) {
    var a = pair[1](chat), b = pair[1](notes);
    var mark = a === b ? '✓ 一致' : '✗ 不一致';
    console.log('  ' + pair[0].padEnd(8) + '对话页=' + (a ? '有' : '无') + '  笔记页=' + (b ? '有' : '无') + '  ' + mark);
  });

  c.ws.close(); ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(function (e) { console.error('失败:', e.message); process.exit(2); });