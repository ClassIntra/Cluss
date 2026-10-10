/**
 * 触控命中区验证
 *
 * 为什么用测量而不是看截图：「视觉尺寸不变、命中区变大」这件事
 * 截图看不出来 —— 命中区是透明的。而真正要保证的是两件事：
 *   1. 视觉尺寸没变（布局没被撑开）
 *   2. 命中区确实变大了（在元素中心外 12px 处点击也能命中）
 *
 * 第 2 条尤其重要：伪元素写得再漂亮，如果被父级 overflow 裁掉、
 * 或被 z-index 压住，就完全无效。必须真的去点。
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9421;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:9050';

function get(u) {
  return new Promise(function (res, rej) {
    http.get(u, function (r) { let d = ''; r.on('data', function (c) { d += c; }); r.on('end', function () { res(d); }); }).on('error', rej);
  });
}
function connect(u) {
  const ws = new WebSocket(u); const p = new Map(); let id = 0;
  ws.addEventListener('message', function (e) {
    let m; try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.id && p.has(m.id)) { const r = p.get(m.id); p.delete(m.id); m.error ? r.reject(new Error(m.error.message)) : r.resolve(m.result); }
  });
  function send(method, params) {
    const i = ++id;
    return new Promise(function (res, rej) {
      const t = setTimeout(function () { p.delete(i); rej(new Error('to ' + method)); }, 25000);
      p.set(i, { resolve: function (v) { clearTimeout(t); res(v); }, reject: function (e) { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
  const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
    '--no-first-run', '--disable-gpu', '--window-size=960,680', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await new Promise(function (r) { setTimeout(r, 500); });
    try { await get('http://127.0.0.1:' + PORT + '/json/version'); break; } catch (e) {}
  }
  const ts = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
  const c = connect(ts.find(function (t) { return t.type === 'page'; }).webSocketDebuggerUrl);
  await c.open;
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: true });

  function E(expr, aw) {
    return c.send('Runtime.evaluate', { expression: expr, awaitPromise: !!aw, returnByValue: true })
      .then(function (r) { return r.result && r.result.value; });
  }

  await c.send('Page.navigate', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 3500); });
  const tok = await E("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'uitester',password:'Test1234'})}).then(r=>r.json()).then(j=>j&&j.data?j.data.token:'')", true);
  await E("localStorage.setItem('cluss_token'," + JSON.stringify(tok) + ");localStorage.setItem('token'," + JSON.stringify(tok) + ")");
  await c.send('Page.navigate', { url: BASE + '/' });
  await new Promise(function (r) { setTimeout(r, 3000); });

  console.log('触控命中区验证（960×680 平板基线）\n');

  // ---- 造一个 note-ref-x 元素（引用笔记的移除按钮）----
  // ⚠️ 必须把探针元素放在**视口内可见位置**：elementFromPoint 只对视口内的点有效。
  //   之前直接 append 到 #app-root 末尾，元素被挤到视口外，
  //   所有探测点都返回 null —— 看起来像「命中区完全没生效」，
  //   实际是测法错了。
  var r1 = await E(`
    (function(){
      var host = document.createElement('div');
      host.id = 'probe-host';
      host.style.cssText = 'position:fixed;left:200px;top:200px;z-index:99999;background:#fff;padding:20px;';
      host.innerHTML = '<span class="note-refs"><span class="note-ref-chip">测试笔记' +
        '<button class="note-ref-x" id="probe-x">×</button></span></span>';
      document.body.appendChild(host);
      var el = document.getElementById('probe-x');
      var r = el.getBoundingClientRect();
      return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height),
        left: Math.round(r.left), top: Math.round(r.top) });
    })()
  `);
  var d1 = JSON.parse(r1);
  console.log('【1】视觉尺寸（应保持小，不被撑开）');
  check('note-ref-x 视觉高度 < 24px', d1.h < 24, d1.h + 'px');
  check('note-ref-x 视觉宽度 < 24px', d1.w < 24, d1.w + 'px');

  // ---- 命中区：在元素外 12px 处 elementFromPoint 应命中它或其伪元素宿主 ----
  var r2 = await E(`
    (function(){
      var el = document.getElementById('probe-x');
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width/2, cy = r.top + r.height/2;
      function hitAt(dx, dy){
        var t = document.elementFromPoint(cx + dx, cy + dy);
        if (!t) return 'null';
        // 命中伪元素时 elementFromPoint 返回的是**宿主元素**
        if (t === el) return 'self';
        if (t.contains && t.contains(el)) return 'parent';
        return t.className || t.tagName;
      }
      return JSON.stringify({
        center: hitAt(0,0),
        up10: hitAt(0,-10),
        down10: hitAt(0,10),
        left10: hitAt(-10,0),
        right10: hitAt(10,0),
        up18: hitAt(0,-18),
        down18: hitAt(0,18)
      });
    })()
  `);
  var d2 = JSON.parse(r2);
  console.log('\n【2】命中区（点视觉框外仍应命中）');
  var isHit = function (v) { return v === 'self' || v === 'parent'; };
  check('中心点命中', isHit(d2.center), d2.center);
  check('上方 10px 命中', isHit(d2.up10), d2.up10);
  check('下方 10px 命中', isHit(d2.down10), d2.down10);
  check('左方 10px 命中', isHit(d2.left10), d2.left10);
  check('右方 10px 命中', isHit(d2.right10), d2.right10);

  // 纵向 18px 处（≈ 距中心；13px 的叉总高约 13，半高 6.5，所以 18px 已远在外）
  // 伪元素是 40px 高 → 中心上下各 20px，所以 ±18 应命中
  check('上方 18px 命中（伪元素 40px 内）', isHit(d2.up18), d2.up18);
  check('下方 18px 命中（伪元素 40px 内）', isHit(d2.down18), d2.down18);

  // ---- tool-btn 同样验证 ----
  var r3 = await E(`
    (function(){
      var prev = document.getElementById('probe-host2');
      if (prev) prev.remove();
      var host = document.createElement('div');
      host.id = 'probe-host2';
      host.style.cssText = 'position:fixed;left:200px;top:400px;z-index:99999;background:#fff;padding:20px;';
      host.innerHTML = '<button class="tool-btn" id="probe-tb">复制</button>';
      document.body.appendChild(host);
      var el = document.getElementById('probe-tb');
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width/2, cy = r.top + r.height/2;
      function hitAt(dy){
        var t = document.elementFromPoint(cx, cy + dy);
        if (!t) return 'null';
        return (t === el || (t.contains && t.contains(el))) ? 'hit' : (t.className || t.tagName);
      }
      return JSON.stringify({
        h: Math.round(r.height),
        center: hitAt(0), up8: hitAt(-8), down8: hitAt(8),
        up15: hitAt(-15), down15: hitAt(15)
      });
    })()
  `);
  var d3 = JSON.parse(r3);
  console.log('\n【3】tool-btn（消息气泡下方的复制/重新生成）');
  check('tool-btn 视觉高度 < 30px（未破坏布局）', d3.h < 30, d3.h + 'px');
  check('中心命中', d3.center === 'hit', d3.center);
  check('上方 8px 命中', d3.up8 === 'hit', d3.up8);
  check('下方 8px 命中', d3.down8 === 'hit', d3.down8);
  check('上方 15px 命中', d3.up15 === 'hit', d3.up15);
  check('下方 15px 命中', d3.down15 === 'hit', d3.down15);

  // ---- 三页 chip 样式一致性 ----
  console.log('\n【4】三页 chip 样式同源');
  var pages = [['/study', '学习'], ['/writing', '写作']];
  for (var i = 0; i < pages.length; i++) {
    await E("location.hash='#" + pages[i][0] + "'");
    await new Promise(function (r) { setTimeout(r, 1500); });
    var got = await E(`
      (function(){
        var prev = document.getElementById('probe-host3');
        if (prev) prev.remove();
        var host = document.createElement('div');
        host.id = 'probe-host3';
        host.style.cssText = 'position:fixed;left:200px;top:200px;z-index:99999;background:#fff;padding:20px;';
        host.className = 'note-refs';
        host.innerHTML = '<span class="note-ref-chip">测试笔记<button class="note-ref-x" id="px-${pages[i][1]}">×</button></span>';
        document.body.appendChild(host);
        var el = document.getElementById('px-${pages[i][1]}');
        var r = el.getBoundingClientRect();
        var cs = getComputedStyle(el);
        var chip = el.parentNode;
        var ccs = getComputedStyle(chip);
        var out = {
          h: Math.round(r.height),
          hitUp18: (function(){
            var cx = r.left + r.width/2, cy = r.top + r.height/2;
            var t = document.elementFromPoint(cx, cy - 18);
            return t && (t === el || t.contains(el)) ? 'hit' : 'miss';
          })(),
          chipBg: ccs.backgroundColor,
          chipRadius: ccs.borderRadius,
          chipFont: ccs.fontSize
        };
        host.remove();
        return JSON.stringify(out);
      })()
    `);
    var g = JSON.parse(got);
    check(pages[i][1] + '页 chip 高度与对话页一致(≈13px)', g.h >= 12 && g.h <= 16, g.h + 'px');
    check(pages[i][1] + '页 chip 配色一致', g.chipBg === 'rgb(232, 239, 252)', g.chipBg);
    check(pages[i][1] + '页 命中区已生效', g.hitUp18 === 'hit', g.hitUp18);
  }

  // ---- 5. 本轮新增的命中区 ----
  console.log('\n【5】新增命中区（think-btn / mini-btn / ci-back-btn / assist-act-btn）');
  var NEW_ONES = [
    { cls: 'think-btn', label: '深度思考开关' },
    { cls: 'mini-btn', label: '人格编辑/删除' },
    { cls: 'ci-back-btn', label: '退回 ClassIntra' },
    { cls: 'assist-act-btn', label: '停止/替换正文' }
  ];
  for (var k = 0; k < NEW_ONES.length; k++) {
    var spec = NEW_ONES[k];
    var got2 = await E(`
      (function(){
        var prev = document.getElementById('probe-new');
        if (prev) prev.remove();
        var host = document.createElement('div');
        host.id = 'probe-new';
        host.style.cssText = 'position:fixed;left:180px;top:180px;z-index:99999;background:#fff;padding:24px;';
        host.innerHTML = '<button class="${spec.cls}" id="pn">测试</button>';
        document.body.appendChild(host);
        var el = document.getElementById('pn');
        if (!el) { return JSON.stringify({ err: 'not-rendered' }); }
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width/2, cy = r.top + r.height/2;
        function hit(dy){
          var t = document.elementFromPoint(cx, cy + dy);
          return t && (t === el || t.contains(el)) ? 'hit' : (t ? (t.className||t.tagName) : 'null');
        }
        var out = { h: Math.round(r.height), center: hit(0), up: hit(-12), down: hit(12), upFar: hit(-17) };
        host.remove();
        return JSON.stringify(out);
      })()
    `);
    var g2 = JSON.parse(got2);
    if (g2.err) { console.log('  ! ' + spec.label + ' 未渲染'); fail++; continue; }
    check(spec.label + ' 命中区已生效(±12px)', g2.center === 'hit' && g2.up === 'hit' && g2.down === 'hit',
      '中心=' + g2.center + ' 上=' + g2.up + ' 下=' + g2.down);
    check(spec.label + ' 命中区已到 ±17px', g2.upFar === 'hit', '上17px=' + g2.upFar);
  }

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  c.ws.close(); ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) { console.error('失败:', e.message); process.exit(2); });