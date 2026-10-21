/**
 * turn-runner 装配路径的真端到端验证（假上游 + 隔离库，零真实花费）
 *
 * 为什么需要它：verify-prompt-engineering / verify-memory-context / verify-output-experience
 * 三个探针都是**直接调模块**（prompt-registry、context-builder、ai）。它们证明不了
 * 「turn-runner 真的把恒定段当 system 发、把变化段拼到 user 末尾、把 max_tokens 传下去」——
 * 而胶水层恰恰是最容易写错、且错了不会报错的地方（症状是"优化好像没生效"）。
 *
 * 做法：
 *   1) 从真实库 online backup 出一个临时库（真实库只读，绝不动它）
 *   2) 在临时库里把默认模型的地址改到本地假上游
 *   3) 起一个假上游，把收到的请求体原样记下来
 *   4) 用真实 turnRunner.runStreamTurn 跑**两轮**同一会话
 *   5) 断言：请求体里的 max_tokens、system 的构成、以及**两轮 system 是否逐字节相同**
 *
 * 最后那条是本轮所有优化的核心前提，只有走完整链路才能验证。
 *
 * 用法：
 *   export PYTHONPATH=""; unset NODE_OPTIONS; export PATH="/c/Program Files/nodejs:$PATH"
 *   cd server && node scripts/verify-turn-assembly.cjs
 */
'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var http = require('http');
var EventEmitter = require('events');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}
function group(t) { console.log('\n== ' + t + ' =='); }

// 源库：默认是仓库内的真实库，但**允许用 DB_PATH 换掉**。
// 为什么：这个脚本只做「复制一份出来改」，源库是什么不影响结论；而直接钉死真实库
// 会让门禁依赖「本机生产库恰好配了默认模型」这种外部状态 —— 换台机器、清过配置就红灯，
// 红的原因还跟被测代码毫无关系。CI / 临时库上跑就该指到临时库。
var REAL_DB = (function() {
  var envPath = String(process.env.DB_PATH || '').trim();
  if (envPath) {
    var resolved = path.isAbsolute(envPath) ? envPath : path.resolve(__dirname, '..', envPath);
    if (fs.existsSync(resolved)) return resolved;
    console.warn('[verify] DB_PATH 指向的库不存在，回落到仓库内数据库：' + envPath);
  }
  return path.resolve(__dirname, '..', 'database', 'cluss.db');
})();
var TMP_DB = path.join(os.tmpdir(), 'cluss-verify-assembly-' + process.pid + '.db');
var FAKE_PORT = 18099;

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ---------------------------------------------------------------------------
// 1) 隔离库
// ---------------------------------------------------------------------------
var Database = require('better-sqlite3');

var captured = [];      // 假上游收到的请求体
var sseChunks = [];     // 服务端吐给"前端"的 SSE 帧

function startFakeUpstream() {
  return new Promise(function (resolve) {
    var srv = http.createServer(function (req, res) {
      var buf = '';
      req.on('data', function (d) { buf += d; });
      req.on('end', function () {
        var body = {};
        try { body = JSON.parse(buf); } catch (e) { /* 记下来以便排障 */ }
        captured.push({ url: req.url, body: body, raw: buf });

        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        // 正常的小回复：两小段正文 + usage + DONE
        var frames = [
          'data: ' + JSON.stringify({ choices: [{ delta: { content: '好' } }] }) + '\n\n',
          'data: ' + JSON.stringify({ choices: [{ delta: { content: '的。' } }] }) + '\n\n',
          'data: ' + JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 }
          }) + '\n\n',
          'data: [DONE]\n\n'
        ];
        frames.forEach(function (f) { res.write(f); });
        res.end();
      });
    });
    srv.listen(FAKE_PORT, '127.0.0.1', function () { resolve(srv); });
  });
}

// 假的 Express res：turn-runner 只用到这几个面
function mockRes() {
  var res = new EventEmitter();
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.chunks = [];
  res.headers = {};
  res.setHeader = function (k, v) { res.headers[k] = v; };
  res.flushHeaders = function () { res.headersSent = true; };
  res.writeHead = function (c) { res.statusCode = c; res.headersSent = true; return res; };
  res.write = function (s) { res.chunks.push(String(s)); return true; };
  res.end = function () { res.writableEnded = true; return res; };
  res.status = function (c) { res.statusCode = c; return res; };
  res.json = function (o) { res.body = o; res.end(); return res; };
  res.flush = function () {};
  return res;
}

var fakeSrv = null;

(async function () {
  // 备份真实库 → 临时库
  var real = new Database(REAL_DB, { readonly: true, fileMustExist: true });
  await real.backup(TMP_DB);
  real.close();

  // ⚠️ 必须在 require 业务模块**之前**改 DB_PATH：
  //    init-db 在 require 时就把连接建好，之后再改环境变量是没用的。
  process.env.DB_PATH = TMP_DB;
  var tmp = new Database(TMP_DB);
  // 把默认模型指到假上游；顺便设成免费，绕开额度闸门（免费用量闸门不放行）
  var defRow = tmp.prepare('SELECT id FROM ai_models WHERE is_default = 1 LIMIT 1').get();
  ok('临时库里有默认模型（前置条件）', !!(defRow && defRow.id), JSON.stringify(defRow));
  if (!defRow) { tmp.close(); throw new Error('临时库缺少默认模型，无法继续'); }

  tmp.prepare(
    'UPDATE ai_models SET api_url = ?, api_key = ?, source_id = ?, is_free = 1, enabled = 1, supports_stream = 1 WHERE id = ?'
  ).run('http://127.0.0.1:' + FAKE_PORT + '/v1', 'fake-key', '', defRow.id);

  // 挑一个有会话历史的用户，保证"变化段"真的非空（有画像/记忆可注入）
  var userRow = tmp.prepare(
    'SELECT user_id, COUNT(*) c FROM ai_conversations GROUP BY user_id ORDER BY c DESC LIMIT 1'
  ).get();
  ok('临时库里有可用用户（前置条件）', !!(userRow && userRow.user_id), JSON.stringify(userRow));
  if (!userRow) { tmp.close(); throw new Error('临时库缺少用户，无法继续'); }
  var userId = userRow.user_id;
  tmp.close();

  fakeSrv = await startFakeUpstream();

  // ---------------------------------------------------------------------------
  // 2) 跑真实装配路径
  // ---------------------------------------------------------------------------
  var turnRunner = require('../src/services/turn-runner');

  async function runTurn(convId, text) {
    var res = mockRes();
    var req = new EventEmitter();
    req.headers = {};
    req.body = {};
    var conv = { id: convId || '' };
    await turnRunner.runStreamTurn({
      req: req, res: res, userId: userId,
      content: text,
      modelId: '',
      thinking: false,
      conversation: conv,
      attachmentHashes: [],
      noteIds: [],
      task: { kind: '' },
      source: 'chat'
    });
    var all = res.chunks.join('');
    var m = /event: done\ndata: (.+)\n/.exec(all);
    var done = null;
    try { done = m ? JSON.parse(m[1]) : null; } catch (e) { done = null; }
    return { res: res, sse: all, done: done };
  }

  console.log('\n（跑第一轮…）');
  var t1 = await runTurn('', '第一轮的问题');
  var convId = t1.done && t1.done.conversation_id;
  ok('第一轮拿到 conversation_id', !!convId, JSON.stringify(t1.done).slice(0, 200));

  console.log('（跑第二轮，同一会话…）');
  var t2 = await runTurn(convId, '第二轮的问题');

  // ---------------------------------------------------------------------------
  // 3) 断言
  // ---------------------------------------------------------------------------
  group('① 请求体：max_tokens 真的下发（防跑飞的上界）');

  ok('假上游收到 2 次请求', captured.length === 2, '收到 ' + captured.length + ' 次');
  var b1 = captured[0] && captured[0].body;
  var b2 = captured[1] && captured[1].body;
  ok('第 1 轮请求体存在', !!b1, captured[0] && captured[0].raw ? captured[0].raw.slice(0, 150) : 'no body');
  ok('第 1 轮 max_tokens = 3072（聊天档）', b1 && b1.max_tokens === 3072, b1 && String(b1.max_tokens));
  ok('第 2 轮 max_tokens = 3072', b2 && b2.max_tokens === 3072, b2 && String(b2.max_tokens));
  ok('带上了 stream=true', b1 && b1.stream === true);

  group('② 恒定段 / 变化段的分投位置');

  var sys1 = b1 && b1.messages[0] && b1.messages[0].content;
  ok('第 1 条消息是 system', b1 && b1.messages[0].role === 'system');
  ok('system 非空', !!sys1 && sys1.length > 1000, 'len=' + (sys1 ? sys1.length : 0));

  var H_PROFILE = '【关于这个学生】（系统根据';
  var H_MEM = '【关于这个学生的长期记忆】';
  ok('system 里没有画像段', !!sys1 && sys1.indexOf(H_PROFILE) === -1);
  ok('system 里没有记忆段', !!sys1 && sys1.indexOf(H_MEM) === -1);
  ok('system 里有情感段（恒定段该有的还在）', !!sys1 && sys1.indexOf('【学生表达情感或情绪时】') !== -1);
  ok('system 里有背景块授权声明（BASE 第 15 条）', !!sys1 && sys1.indexOf('系统注入的背景块') !== -1);

  // 本轮用户消息（最后一条）应带末尾背景块
  var last1 = b1 && b1.messages[b1.messages.length - 1];
  var userText1 = typeof last1.content === 'string'
    ? last1.content
    : (Array.isArray(last1.content) ? last1.content.map(function (p) { return p.text || ''; }).join('') : '');
  ok('最后一条是 user', last1 && last1.role === 'user');
  ok('用户消息里带上了[当前时间]（变化段确实拼进来了）', /\[当前时间\] \d{4}-/.test(userText1),
    userText1.slice(-120));

  group('③ 两轮之间 system 逐字节相同（本轮全部优化的前提）');

  var sys2 = b2 && b2.messages[0] && b2.messages[0].content;
  ok('两轮 system 完全相同', !!sys1 && sys1 === sys2,
    'len ' + (sys1 ? sys1.length : 0) + ' vs ' + (sys2 ? sys2.length : 0));
  // 反向对照：如果两轮 system 本来就一样（比如都是空串），上面的断言毫无意义。
  ok('反向对照：system 长度 > 2000（排除"两边都是空串"的假通过）', !!sys1 && sys1.length > 2000,
    'len=' + (sys1 ? sys1.length : 0));
  // 反向对照：历史确实在增长（证明第二轮发的是"同一会话 + 更长历史"，不是同一个请求重发）
  ok('反向对照：第 2 轮消息数多于第 1 轮（历史在累积）',
    b2.messages.length > b1.messages.length,
    b1.messages.length + ' → ' + b2.messages.length);

  group('④ 服务端自身行为正常（链路没被改坏）');

  ok('第 1 轮吐出了 delta 事件', /event: delta/.test(t1.sse));
  ok('第 1 轮吐出了 done 事件', /event: done/.test(t1.sse));
  ok('第 2 轮吐出了 done 事件', /event: done/.test(t2.sse));
  ok('没有 HTTP 失败（未走到 fail 分支）', t1.res.statusCode === 200 && !t1.res.body,
    'status=' + t1.res.statusCode + ' body=' + JSON.stringify(t1.res.body || null).slice(0, 120));

  console.log('\nRESULT: PASS ' + pass + ' / FAIL ' + fail + ' (共 ' + (pass + fail) + ' 项)');
})()
  .catch(function (e) {
    console.error('\n脚本异常：' + (e && e.stack || e));
    fail++;
  })
  .then(function () {
    if (fakeSrv) fakeSrv.close();
    try { fs.unlinkSync(TMP_DB); } catch (e) {}
    try { fs.unlinkSync(TMP_DB + '-wal'); } catch (e) {}
    try { fs.unlinkSync(TMP_DB + '-shm'); } catch (e) {}
    process.exit(fail ? 1 : 0);
  });
