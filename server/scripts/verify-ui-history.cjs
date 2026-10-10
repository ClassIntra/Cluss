// 用真实浏览器验证「点历史能切换」—— 对话 / 作文 / 拍题三个页面。
//
// 为什么需要它（这是它存在的唯一理由）：
//   这三个页面都是「列表 + 详情」结构，而详情渲染的是**预计算好的 HTML**
//   （m.html / resultHtml / answerHtml），不是原始文本 —— 这么做是为了
//   避免每次重渲染都重新解析整篇 Markdown（见 mixins/streamFrame）。
//   代价是出现了两份状态：原文与它的 HTML。
//   **只要有一条路径只改原文、忘了改 HTML，页面就会"点了没反应"** ——
//   它不报错、接口也正常，只看后端数据完全发现不了。
//   这个 bug 真实发生过：openPiece / openConversation 只写了 result / answer。
//
// 所以必须上真浏览器，断言"点击后正文确实变了、而且是对的"。
//
// 用法：
//   node scripts/verify-ui-history.cjs                 # 需要先起好服务端
//   CHROME_PATH=/path/to/chrome node scripts/verify-ui-history.cjs
// 退出码 0 = 三个页面都正常。
//
// 依赖：Node 22+（用内置 WebSocket 直连 CDP，不装任何 npm 包）
//       本机 Chrome / Chromium / Edge 任一

require('dotenv').config();

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var os = require('os');
var db = require('../src/utils/db');

var BASE = require('./lib/target').resolve(process.env.PORT || 9101);
var UID = process.env.VERIFY_UID || '250301';
var PWD = process.env.VERIFY_PWD || 'test1234';
var MARK = 'tmpverify';   // 测试数据的 id 前缀，清理时按它删

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ---- 找浏览器 ----
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  var home = os.homedir();
  var candidates = [];
  try {
    (fs.readdirSync(path.join(home, 'AppData/Local/ms-playwright')) || [])
      .filter(function(d) { return /^chromium-\d+$/.test(d); })
      .sort().reverse()
      .forEach(function(d) {
        candidates.push(path.join(home, 'AppData/Local/ms-playwright', d, 'chrome-win64', 'chrome.exe'));
      });
  } catch (e) { /* 没有 playwright 缓存 */ }
  candidates.push(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium'
  );
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  return null;
}

// ---- 极简 CDP 客户端（零依赖） ----
function makeCdp(wsUrl) {
  var ws = new WebSocket(wsUrl);
  var id = 0, pending = {};
  var ready = new Promise(function(res) { ws.onopen = res; });
  ws.onmessage = function(e) {
    var m = JSON.parse(e.data);
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
  };
  function send(method, params) {
    return new Promise(function(res) {
      var myId = ++id;
      pending[myId] = res;
      ws.send(JSON.stringify({ id: myId, method: method, params: params || {} }));
    });
  }
  // 求值：返回普通值；JS 抛错时返回 { __err }
  async function ev(expr) {
    var r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.result && r.result.exceptionDetails) return { __err: String(r.result.exceptionDetails.text || 'JS 异常') };
    return r.result && r.result.result ? r.result.result.value : null;
  }
  return { ready: ready, send: send, ev: ev, close: function() { ws.close(); } };
}

async function launchBrowser(port) {
  var bin = findChrome();
  if (!bin) throw new Error('找不到浏览器，请用 CHROME_PATH 指定');
  var profile = path.join(os.tmpdir(), 'cluss-ui-verify-' + Date.now());
  var proc = childProcess.spawn(bin, [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    'about:blank'
  ], { stdio: 'ignore' });

  var wsUrl = null;
  for (var i = 0; i < 50 && !wsUrl; i++) {
    await sleep(300);
    try {
      var list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      var page = list.filter(function(t) { return t.type === 'page'; })[0];
      if (page && page.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
  }
  if (!wsUrl) { proc.kill(); throw new Error('浏览器未就绪（CDP 端口无响应）'); }
  return { proc: proc, wsUrl: wsUrl, profile: profile, bin: bin };
}

// ---- 塞测试数据 ----
function seed() {
  var tx = db.transaction(function() {
    ['chat', 'study'].forEach(function(kind) {
      for (var i = 1; i <= 3; i++) {
        var cid = 'c_' + MARK + '_' + kind + '_' + i;
        var mode = kind === 'chat' ? 'daily' : 'study';
        db.prepare('DELETE FROM ai_messages WHERE conversation_id = ?').run(cid);
        db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(cid);
        db.prepare([
          'INSERT INTO ai_conversations (id, user_id, title, model_id, created_at, updated_at, mode, study_style, persona)',
          "VALUES (?, ?, ?, 'ds-v41', ?, ?, ?, 'guided', '')"
        // 标题带上类型：对话页的列表会把两种模式的会话都列出来，
        // 只用同一个前缀的话，选出来的会混着拍题会话，断言就判错了。
        ].join('\n')).run(cid, UID, MARK + '-' + kind + '会话' + i,
          '2026-10-03 17:00:0' + i, '2026-10-03 17:00:0' + i, mode);
        db.prepare([
          'INSERT INTO ai_messages (conversation_id, role, content, model_id, created_at, attachments, source)',
          "VALUES (?, 'user', ?, 'ds-v41', ?, '[]', ?)"
        ].join('\n')).run(cid, MARK + '问题' + i, '2026-10-03 17:00:0' + i, kind);
        db.prepare([
          'INSERT INTO ai_messages (conversation_id, role, content, model_id, created_at, attachments, source)',
          "VALUES (?, 'assistant', ?, 'ds-v41', ?, '[]', ?)"
        ].join('\n')).run(cid,
          '## ' + MARK + '回答' + i + '\n\n唯一标记 ' + MARK.toUpperCase() + '-' + kind.toUpperCase() + '-' + i + '。',
          '2026-10-03 17:00:1' + i, kind);
      }
    });
    // 作文三条
    for (var j = 1; j <= 3; j++) {
      // 删除时把新旧两种命名都带上，免得旧版残留清不掉
      db.prepare('DELETE FROM writing_pieces WHERE topic IN (?, ?)').run(MARK + '-write作文' + j, MARK + '作文' + j);
      db.prepare([
        'INSERT INTO writing_pieces (user_id, mode, language, genre, style, word_limit, topic, outline, content, feedback, image_hashes, created_at, updated_at)',
        "VALUES (?, 'generate', 'zh', '记叙文', '', 600, ?, '', ?, '', '[]', ?, ?)"
      ].join('\n')).run(UID, MARK + '-write作文' + j,
        '## ' + MARK + '作文' + j + '\n\n唯一标记 ' + MARK.toUpperCase() + '-WRITE-' + j + '。',
        '2026-10-03 17:00:0' + j, '2026-10-03 17:00:0' + j);
    }
  });
  tx();
}

function cleanup() {
  var tx = db.transaction(function() {
    ['chat', 'study'].forEach(function(kind) {
      for (var i = 1; i <= 3; i++) {
        var cid = 'c_' + MARK + '_' + kind + '_' + i;
        db.prepare('DELETE FROM ai_messages WHERE conversation_id = ?').run(cid);
        db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(cid);
      }
    });
    for (var j = 1; j <= 3; j++) {
      db.prepare('DELETE FROM writing_pieces WHERE topic IN (?, ?)').run(MARK + '-write作文' + j, MARK + '作文' + j);
    }
  });
  tx();
}

// ---- 一个页面的「点历史 → 正文应跟着变」检查 ----
async function checkPage(cdp, opts) {
  await cdp.ev("location.hash = " + JSON.stringify('#' + opts.route) + "; 'ok'");
  await sleep(2500);

  var itemSel = opts.itemSel;

  // 只点**本脚本自己造的**条目。
  // 不能假设历史里只有测试数据 —— 真实库里必然有学生的既有内容，
  // 早期版本按"前 N 条"点，结果点到别人的数据上，判定必然失败。
  var idxs = null;
  for (var k = 0; k < 15; k++) {
    idxs = await cdp.ev(
      "(function(){var out=[];document.querySelectorAll('" + itemSel + "').forEach(function(e,i){" +
      "if(e.innerText.indexOf(" + JSON.stringify(opts.titleMark) + ")>=0)out.push(i);});return out;})()"
    );
    if (Array.isArray(idxs) && idxs.length >= 3) break;
    await sleep(400);
  }
  if (!Array.isArray(idxs) || idxs.length < 3) {
    return { name: opts.name, ok: false, reason: '只找到 ' + (idxs ? idxs.length : 0) + ' 条测试数据（期望 ≥3）' };
  }

  var seen = [];
  var total = Math.min(idxs.length, 6);
  for (var i = 0; i < total; i++) {
    await cdp.ev("(function(){var a=document.querySelectorAll('" + itemSel + "');" +
      "var e=a[" + idxs[i] + "];if(!e)return 0;e.click();return 1;})()");
    await sleep(1300);
    var text = await cdp.ev("(function(){var e=document.querySelector('" + opts.bodySel + "');" +
      "return e ? e.innerText.replace(/\\s+/g,' ').slice(0,90) : '(空)';})()");
    seen.push(String(text));
  }

  var uniq = seen.filter(function(v, i, a) { return a.indexOf(v) === i; });
  var marks = seen.filter(function(t) { return t.indexOf(opts.markPrefix) >= 0; }).length;
  var ok = uniq.length === seen.length && marks === seen.length;
  return { name: opts.name, ok: ok, total: seen.length, uniq: uniq.length, marks: marks, sample: seen };
}

(async function() {
  var pass = 0, fail = 0;
  var failures = [];
  function ok(name, cond, detail) {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
  }

  console.log('\n=== 准备 ===');
  var r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: UID, password: PWD })
  });
  var lj = await r.json();
  if (!lj.data || !lj.data.token) {
    console.error('登录失败（' + UID + '）：' + JSON.stringify(lj).slice(0, 120));
    console.error('可用 VERIFY_UID / VERIFY_PWD 指定测试账号');
    process.exit(1);
  }
  var token = lj.data.token;
  console.log('  账号 ' + UID + ' 登录成功');

  seed();
  console.log('  已写入测试数据（前缀 ' + MARK + '）');

  var br = null, cdp = null;
  try {
    br = await launchBrowser(9336);
    cdp = makeCdp(br.wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 登录态必须在应用启动前就位：Vuex store 在启动时读一次 localStorage，
    // 之后再写就不生效了（hash 路由变化不会触发重新加载）
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(1800);
    await cdp.ev("localStorage.setItem('cluss_token', " + JSON.stringify(token) + "); 'ok'");
    await cdp.send('Page.reload');
    await sleep(3000);

    console.log('\n=== 点历史能切换（真实浏览器） ===');
    // titleMark：只点标题里带这个串的条目（避免点到库里既有的真实内容）
    // markPrefix：点开后正文里应当出现的唯一标记
    var PAGES = [
      { name: '对话页', route: '/', itemSel: '.conv-item', bodySel: '.msg .md-body',
        titleMark: MARK + '-chat', markPrefix: MARK.toUpperCase() + '-CHAT-' },
      { name: '作文页', route: '/writing', itemSel: '.hist-item', bodySel: '.result-body .md-body',
        titleMark: MARK + '-write', markPrefix: MARK.toUpperCase() + '-WRITE-' },
      { name: '拍题页', route: '/study', itemSel: '.hist-item', bodySel: '.md-body',
        titleMark: MARK + '-study', markPrefix: MARK.toUpperCase() + '-STUDY-' }
    ];

    for (var i = 0; i < PAGES.length; i++) {
      var res = await checkPage(cdp, PAGES[i]);
      ok(res.name + '点历史能正确切换', res.ok,
        res.ok ? (res.total + ' 条各不相同，标记全对')
               : (res.reason || ('点了 ' + res.total + ' 条只得到 ' + res.uniq + ' 种正文，命中标记 ' + res.marks + ' 条')));
    }
  } catch (e) {
    fail++;
    failures.push('执行异常 — ' + e.message);
    console.error('\n[异常] ' + e.message);
  } finally {
    if (cdp) cdp.close();
    if (br) { br.proc.kill(); try { fs.rmSync(br.profile, { recursive: true, force: true }); } catch (e) {} }
    cleanup();
    console.log('\n（测试数据已清理）');
  }

  console.log('\n=== 结果 ===');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failures.length) { console.log('失败项：'); failures.forEach(function(f) { console.log('  - ' + f); }); }
  process.exitCode = fail > 0 ? 1 : 0;
})();
