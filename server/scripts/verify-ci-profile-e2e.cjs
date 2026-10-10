// ============================================================
// 验证脚本：**端到端**确认 CI 画像素材真的进了发给模型的 system prompt
//
// 为什么非要做这一层：单元级断言（buildCiSection 直接调用）只能证明
// "给数据它就拼"，证明不了"turn-runner 真的把数据取出来传下去了"。
// 这里用真实 runStreamTurn + 假上游 AI 抓请求体，把整条链路连上。
//
//   轮 1：缓存还是空的 → prompt 里**不该**有 CI 段（素材晚一轮生效）
//   轮 2：后台刷新已完成 → prompt 里**应该**有 CI 段
//   轮 3：CI 被关掉 → 没有 CI 段，但对话必须照常成功（增强项不该拖垮主链路）
//
// 什么时候跑：改 turn-runner 的上下文组装、或改 ci-bridge / CI 素材段之后。
// 安全：全程只打本地假上游（临时库里其余模型一律停用），不产生任何真实外呼。
//
// 运行（在 Cluss 仓库根下）：
//   export PYTHONPATH=""; unset NODE_OPTIONS; export PATH="/c/Program Files/nodejs:$PATH"
//   node server/scripts/verify-ci-profile-e2e.cjs
// ============================================================
'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var http = require('http');
var EventEmitter = require('events').EventEmitter;

var dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'probe-jwt-secret';

var REAL_DB = path.resolve(__dirname, '..', 'database', 'cluss.db');
var TMP_DB = path.join(os.tmpdir(), 'cluss-probe-e2e-' + Date.now() + '.db');
var USER = '';   // 运行时从库里挑一个 6 位学号（不把某个真实学生硬编码进脚本）

var pass = 0, fail = 0, lines = [];
function ok(name, cond, extra) {
  if (cond) { pass++; lines.push('  PASS  ' + name); }
  else { fail++; lines.push('  FAIL  ' + name + (extra !== undefined ? '  | ' + extra : '')); }
}
function section(t) { lines.push(''); lines.push('== ' + t + ' =='); }
function has(n, h) { return String(h).indexOf(n) !== -1; }

// ------------------------------------------------------------
// mock express response（够 createSseWriter + fail() 用）
// ------------------------------------------------------------
function MockRes() {
  EventEmitter.call(this);
  this.headers = {};
  this.chunks = [];
  this.writableEnded = false;
  this.headersSent = false;
  this.statusCode = 200;
  this.jsonBody = null;
}
MockRes.prototype = Object.create(EventEmitter.prototype);
MockRes.prototype.setHeader = function (k, v) { this.headers[k] = v; return this; };
MockRes.prototype.flushHeaders = function () { this.headersSent = true; };
MockRes.prototype.write = function (s) { this.chunks.push(String(s)); return true; };
MockRes.prototype.end = function () {
  if (!this.writableEnded) { this.writableEnded = true; this.emit('close'); }
  return this;
};
MockRes.prototype.status = function (c) { this.statusCode = c; return this; };
MockRes.prototype.json = function (o) { this.jsonBody = o; this.writableEnded = true; return this; };
MockRes.prototype.body = function () { return this.chunks.join(''); };

// ------------------------------------------------------------
// 假上游 AI：记录请求体，回一段 SSE（含 usage 块）
// ------------------------------------------------------------
var upBodies = [];
var aiServer = http.createServer(function (req, res) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    var body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
    upBodies.push({ url: req.url, body: body });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '你好呀，' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '我在听。' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ usage: { prompt_tokens: 1500, completion_tokens: 12, total_tokens: 1512 }, choices: [] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ------------------------------------------------------------
// 假 ClassIntra 桥
// ------------------------------------------------------------
var ciHits = 0;
var ciServer = http.createServer(function (req, res) {
  if (req.url.indexOf('/api/cluss-bridge/student-profile') === 0) {
    ciHits++;
    var uid = (req.url.split('userId=')[1] || '').split('&')[0];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 200, message: 'ok',
      data: {
        user_id: uid,
        generated_at: new Date().toISOString(),
        signature: '探针签名_来自CI',
        gender: '男',
        level: { exp: 1500, level: 7 },
        login: { streak: 12, max_streak: 30 },
        activity: { messages: 7, comments: 2, posts_posted: 1, shares: 2, daily_logins: 5, likes_received: 3 },
        community: { post_count: 3, likes_received: 18, comments_received: 5, post_types: { forum: 3 }, post_tags: ['棋类', '学习'], post_titles: ['我的象棋心得'] },
        music: { liked_count: 5, favorite_count: 3, top_artists: [{ name: '周杰伦', count: 2 }], sample_titles: ['晴天'], playlists: ['游戏BGM'] },
        games: { chess: 2, gomoku: 1 },
        exams: [{ title: '期末考试', target_date: '2026-01-15' }]
      }
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 404 }));
});

function listen(srv) {
  return new Promise(function (resolve) { srv.listen(0, '127.0.0.1', function () { resolve(srv.address().port); }); });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
(async function main() {
  var Database = require('better-sqlite3');

  // 1) 备份真实库 → 临时库（online backup，避免读到半写的 WAL）
  var real = new Database(REAL_DB, { readonly: true, fileMustExist: true });
  try { await real.backup(TMP_DB); } finally { real.close(); }

  var aiPort = await listen(aiServer);
  var ciPort = await listen(ciServer);
  var AI_URL = 'http://127.0.0.1:' + aiPort;
  var CI_URL = 'http://127.0.0.1:' + ciPort;

  // 2) 临时库里只留一个我们自己的模型（其余全停用，杜绝任何真实外呼）
  var t = new Database(TMP_DB);
  t.pragma('foreign_keys = OFF');
  t.prepare('UPDATE ai_models SET enabled = 0, is_default = 0').run();
  t.prepare('DELETE FROM ai_models WHERE id = ?').run('probe-model');
  t.prepare([
    'INSERT INTO ai_models (id, label, api_url, api_key, model_name, api_style,',
    '  supports_stream, price_in, price_out, price_cache_hit, is_free, enabled, is_default,',
    '  sort_order, source_id, has_offpeak, offpeak_peak_windows, offpeak_discount_bp)',
    "VALUES ('probe-model','探针模型',?,'probe-key','probe','openai',",
    "  1, 1000, 2000, 0, 1, 1, 0, 1, '', 0, '', 0)"
  ].join('\n')).run(AI_URL);
  t.prepare('DELETE FROM ai_model_health WHERE model_id = ?').run('probe-model');
  // 挑一个 6 位学号当被测用户：假 CI 桥那边会对 userId 做同样的 6 位校验。
  // （有 credit 行更好，但本例模型 is_free=1 已绕过额度闸门，不依赖余额。）
  var pick = t.prepare('SELECT user_id FROM users WHERE length(user_id) = 6 ORDER BY id LIMIT 1').get();
  USER = pick ? String(pick.user_id) : '';
  t.close();

  ok('临时库里能挑到 6 位学号', !!USER, USER);

  // 3) 指向临时库 + 把 CI 指到假桥（必须在 require 业务模块前设好 DB_PATH）
  process.env.DB_PATH = TMP_DB;
  var config = require('../src/config');
  config.ci.bridgeUrl = CI_URL;
  config.ci.secret = 'probe-secret';

  var ciBridge = require('../src/services/ci-bridge');
  var runner = require('../src/services/turn-runner');

  ciBridge._clearProfileCache();

  // ---------- 轮 1：缓存为空 → 不该有 CI 段，但对话必须成功 ----------
  section('轮 1：缓存为空（素材晚一轮生效）');
  upBodies.length = 0;
  var res1 = new MockRes();
  await runner.runStreamTurn({
    userId: USER, req: {}, res: res1,
    content: '你好，最近有点累，随便聊聊',
    modelId: 'probe-model',
    conversation: { mode: 'daily' },
    source: 'chat'
  });

  ok('轮 1 向假上游发了 1 次请求', upBodies.length === 1, upBodies.length);
  var sys1 = upBodies[0] && upBodies[0].body && upBodies[0].body.messages[0];
  ok('轮 1 system 是第一条消息', !!(sys1 && sys1.role === 'system'));
  ok('轮 1 system 不含 CI 段', !has('【他在校园社区里的活动】', sys1 && sys1.content));
  ok('轮 1 对话正常收尾（有 done 事件）', has('event: done', res1.body()));
  ok('轮 1 没有 error 事件', !has('event: error', res1.body()));
  ok('轮 1 上游收到的是「日常」场景（含人格/日常段）', has('日常', String(sys1 && sys1.content)));
  ok('轮 1 已触发后台刷新（假 CI 被访问）', ciHits >= 1, ciHits);

  // 等后台刷新落地
  await sleep(400);
  ok('轮 1 之后缓存里已有素材', !!ciBridge.getCachedStudentProfile(USER));

  // ---------- 轮 2：缓存命中 → system prompt 里必须有 CI 段 ----------
  section('轮 2：缓存命中（CI 素材进入 system prompt）');
  upBodies.length = 0;
  var res2 = new MockRes();
  await runner.runStreamTurn({
    userId: USER, req: {}, res: res2,
    content: '我最近想找点有意思的事做',
    modelId: 'probe-model',
    conversation: { mode: 'daily' },
    source: 'chat'
  });

  ok('轮 2 向假上游发了 1 次请求', upBodies.length === 1, upBodies.length);
  var sys2 = String((upBodies[0] && upBodies[0].body.messages[0] || {}).content || '');
  ok('轮 2 system **含** CI 段标题', has('【他在校园社区里的活动】', sys2));
  ok('轮 2 含 CI 里的个性签名', has('探针签名_来自CI', sys2));
  ok('轮 2 含 CI 里的学业倒计时', has('期末考试', sys2));
  ok('轮 2 含 CI 里的音乐口味', has('周杰伦', sys2));
  ok('轮 2 含 CI 里的棋类', has('国际象棋', sys2));
  ok('轮 2 含「绝对不要主动提起」护栏', has('绝对不要主动提起这些内容', sys2));
  ok('轮 2 对话正常收尾', has('event: done', res2.body()));

  // 位置：CI 段必须在 system 的末尾区（否则每轮都会打掉上游前缀缓存）
  var iCi = sys2.indexOf('【他在校园社区里的活动】');
  ok('CI 段位于 system 末尾区（> 60% 处）', iCi > sys2.length * 0.6, iCi + '/' + sys2.length);

  // 反向对照：CI 段里的素材不该出现在**用户消息**里（只给模型看，不进对话记录）
  var userMsgs = (upBodies[0].body.messages || []).filter(function (m) { return m.role === 'user'; });
  var userText = userMsgs.map(function (m) { return String(m.content); }).join('\n');
  ok('CI 素材没有污染用户消息', !has('探针签名_来自CI', userText) && !has('我的象棋心得', userText));

  // ---------- 轮 3：CI 完全关掉 → 没有 CI 段，但对话仍必须成功 ----------
  section('轮 3：CI 不可用（增强项不该拖垮主链路）');
  config.ci.bridgeUrl = '';
  config.ci.secret = '';
  ciBridge._clearProfileCache();

  upBodies.length = 0;
  var res3 = new MockRes();
  var threw = false;
  try {
    await runner.runStreamTurn({
      userId: USER, req: {}, res: res3,
      content: '再随便说点什么',
      modelId: 'probe-model',
      conversation: { mode: 'daily' },
      source: 'chat'
    });
  } catch (e) { threw = true; lines.push('    （异常：' + e.message + '）'); }

  ok('轮 3 不抛异常', !threw);
  ok('轮 3 仍向上游发出请求', upBodies.length === 1, upBodies.length);
  var sys3 = String((upBodies[0] && upBodies[0].body.messages[0] || {}).content || '');
  ok('轮 3 system **不含** CI 段', !has('【他在校园社区里的活动】', sys3));
  ok('轮 3 system 仍正常（含日常场景段）', has('日常', sys3));
  ok('轮 3 对话正常收尾（有 done 事件）', has('event: done', res3.body()));
  ok('轮 3 没有 error 事件', !has('event: error', res3.body()));

  // ---------- 收尾：确认没有真实外呼 ----------
  section('安全兜底');
  var allUrls = upBodies.map(function (b) { return b.url; });
  ok('所有上游请求都打到假上游', allUrls.every(function (u) { return !!u; }), JSON.stringify(allUrls));
  var hosts = upBodies.map(function (b) { return String(b.body && b.body.model); });
  ok('上游 model 名都是 probe', hosts.every(function (m) { return m === 'probe'; }), JSON.stringify(hosts));

  console.log(lines.join('\n'));
  console.log('');
  console.log('RESULT: PASS ' + pass + ' / FAIL ' + fail + ' (共 ' + (pass + fail) + ' 项)');

  try { aiServer.close(); } catch (e) {}
  try { ciServer.close(); } catch (e) {}
  try { fs.unlinkSync(TMP_DB); } catch (e) {}
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch (e) {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('探针自身异常:', e && e.stack || e);
  try { fs.unlinkSync(TMP_DB); } catch (e2) {}
  process.exit(2);
});
