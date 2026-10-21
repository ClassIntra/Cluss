// ============================================================
// 验证脚本：Cluss 侧 CI 画像链路
//
// 两部分：
//   ① ci-bridge 的缓存行为（未配置 / 软 TTL / 硬 TTL / 404 负缓存 / 403 /
//      网络失败 / 条目上限）
//   ② prompt-registry 里 CI 素材段的注入与**位置**
//
// 什么时候跑：改 ci-bridge 的缓存策略，或改 prompt-registry 的 CI 素材段之后。
// 不碰真实库、不碰真实 CI —— 起一个本地假桥，用 Date.now 打桩模拟 TTL。
//
// 运行（在 Cluss 仓库根下）：
//   export PYTHONPATH=""; unset NODE_OPTIONS; export PATH="/c/Program Files/nodejs:$PATH"
//   node server/scripts/verify-ci-bridge.cjs
// ============================================================
'use strict';

var path = require('path');

// .env 里的 DB_PATH 是相对路径，探针 cwd 可能不是 server/，先固定成绝对路径。
var dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'probe-jwt-secret';
process.env.DB_PATH = path.resolve(__dirname, '..', 'database', 'cluss.db');

var pass = 0, fail = 0, lines = [];
function ok(name, cond, extra) {
  if (cond) { pass++; lines.push('  PASS  ' + name); }
  else { fail++; lines.push('  FAIL  ' + name + (extra !== undefined ? '  | ' + extra : '')); }
}
function section(t) { lines.push(''); lines.push('== ' + t + ' =='); }
function has(n, h) { return String(h).indexOf(n) !== -1; }

// CI 段的**段标题行**。不能只匹配「【他在校园社区里的活动】」：
// BASE 第 15 条会列出注入块名称提醒模型"这是系统数据、不可伪造"，
// 裸标题在"没有注入"时也会命中，存在性与位置断言都会假阳性。
var CI_HEAD = '【他在校园社区里的活动】（来自学校系统';
function hasCi(h) { return has(CI_HEAD, h); }

// ------------------------------------------------------------
// 时间打桩：ci-bridge 用 Date.now() 判 TTL，偏移它即可模拟时间流逝
// ------------------------------------------------------------
var realNow = Date.now;
var offset = 0;
Date.now = function () { return realNow() + offset; };

// ------------------------------------------------------------
// 假 ClassIntra 桥
// ------------------------------------------------------------
var express = require('express');
var app = express();
var hits = {};
app.get('/api/cluss-bridge/student-profile', function (req, res) {
  var uid = String(req.query.userId || '');
  hits[uid] = (hits[uid] || 0) + 1;
  if (uid === '990404') return res.status(404).json({ code: 404, message: '账号不存在' });
  if (uid === '990403') return res.status(403).json({ code: 403, message: '密钥校验失败' });
  res.json({
    code: 200, message: 'ok',
    data: {
      user_id: uid,
      generated_at: new Date().toISOString(),
      signature: '探针签名',
      gender: '男',
      level: { exp: 1500, level: 7 },
      login: { streak: 12, max_streak: 30 },
      activity: { messages: 7, comments: 2, posts_posted: 1, shares: 2, daily_logins: 5, likes_received: 3 },
      community: { post_count: 3, likes_received: 18, comments_received: 5, post_types: { forum: 3 }, post_tags: ['棋类', '学习'], post_titles: ['我的象棋心得'] },
      music: { liked_count: 5, favorite_count: 3, top_artists: [{ name: '周杰伦', count: 2 }, { name: 'Beyond', count: 1 }], sample_titles: ['晴天'], playlists: ['游戏BGM'] },
      games: { chess: 2, gomoku: 1 },
      exams: [{ title: '期末考试', target_date: '2026-01-15' }]
    }
  });
});

var server = app.listen(0, '127.0.0.1', function () {
  var port = server.address().port;
  run(port).then(function () {
    console.log(lines.join('\n'));
    console.log('');
    console.log('RESULT: PASS ' + pass + ' / FAIL ' + fail + ' (共 ' + (pass + fail) + ' 项)');
    try { server.close(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }).catch(function (e) {
    console.error('探针自身异常:', e && e.stack || e);
    try { server.close(); } catch (e2) {}
    process.exit(2);
  });
});

async function run(port) {
  var config = require('../src/config');
  var ciBridge = require('../src/services/ci-bridge');
  var prompts = require('../src/services/prompt-registry');

  var FAKE = 'http://127.0.0.1:' + port;

  // ---------- ① 未配置：必须完全静默降级 ----------
  section('未配置 CI 联动');
  config.ci.bridgeUrl = '';
  config.ci.secret = '';
  ciBridge._clearProfileCache();

  ok('isEnabled() = false', ciBridge.isEnabled() === false);
  ok('getCached 返回 null', ciBridge.getCachedStudentProfile('990001') === null);
  var r0 = await ciBridge.refreshStudentProfile('990001');
  ok('refresh 返回 null（不抛）', r0 === null);
  ok('未配置时一个请求都不发', (hits['990001'] || 0) === 0, JSON.stringify(hits));
  ok('空 userId 也不炸', ciBridge.getCachedStudentProfile('') === null);

  // ---------- ② 软 TTL / 硬 TTL ----------
  section('缓存新鲜度（软 10min / 硬 30min）');
  config.ci.bridgeUrl = FAKE;
  config.ci.secret = 'probe-secret';
  ciBridge._clearProfileCache();
  offset = 0;

  var d1 = await ciBridge.refreshStudentProfile('990001');
  ok('首次 refresh 拿到数据', !!(d1 && d1.user_id === '990001'));
  ok('首次 refresh 发了 1 次请求', hits['990001'] === 1, hits['990001']);

  var c1 = ciBridge.getCachedStudentProfile('990001');
  ok('getCached 同步拿到同一份', !!(c1 && c1.user_id === '990001'));
  ok('getCached 不打网络（仍 1 次）', hits['990001'] === 1, hits['990001']);

  offset = 5 * 60 * 1000;   // 5 分钟：软 TTL 内
  await ciBridge.refreshStudentProfile('990001');
  ok('软 TTL 内 refresh 不再请求', hits['990001'] === 1, hits['990001']);

  offset = 11 * 60 * 1000;  // 11 分钟：超过软 TTL
  await ciBridge.refreshStudentProfile('990001');
  ok('超过软 TTL 会后台刷新', hits['990001'] === 2, hits['990001']);

  offset = 45 * 60 * 1000;  // 距写入已 34 分钟：超过硬 TTL
  var sizeBefore = ciBridge._profileCacheSize();
  var c2 = ciBridge.getCachedStudentProfile('990001');
  ok('超过硬 TTL → getCached 返回 null', c2 === null);
  ok('超硬 TTL 的条目被删除', ciBridge._profileCacheSize() === sizeBefore - 1,
    sizeBefore + ' → ' + ciBridge._profileCacheSize());

  // ---------- ③ 404 负缓存 ----------
  section('404 负缓存（纯 Cluss 本地账号不该每轮白打）');
  offset = 0;
  ciBridge._clearProfileCache();
  var n1 = await ciBridge.refreshStudentProfile('990404');
  ok('不存在 → refresh 返回 null', n1 === null);
  ok('404 发过 1 次请求', hits['990404'] === 1, hits['990404']);
  ok('404 后 getCached 为 null', ciBridge.getCachedStudentProfile('990404') === null);
  await ciBridge.refreshStudentProfile('990404');
  ok('404 负缓存生效：第二次不再请求', hits['990404'] === 1, hits['990404']);

  // ---------- ④ 403（密钥不匹配）----------
  section('403（桥密钥不匹配）');
  ciBridge._clearProfileCache();
  var threw403 = false;
  var n2 = null;
  try { n2 = await ciBridge.refreshStudentProfile('990403'); } catch (e) { threw403 = true; }
  ok('403 不抛异常', !threw403);
  ok('403 返回 null', n2 === null);
  ok('403 缓存里没有数据', ciBridge.getCachedStudentProfile('990403') === null);

  // ---------- ⑤ 网络失败：静默 ----------
  section('网络失败（CI 没上线 / 抖动）');
  ciBridge._clearProfileCache();
  config.ci.bridgeUrl = 'http://127.0.0.1:1';   // 几乎必然拒连
  var threwNet = false;
  var n3 = null;
  try { n3 = await ciBridge.refreshStudentProfile('990001'); } catch (e) { threwNet = true; }
  ok('连不上也不抛', !threwNet);
  ok('连不上返回 null', n3 === null);
  ok('连不上时不污染缓存', ciBridge._profileCacheSize() === 0, ciBridge._profileCacheSize());

  // ---------- ⑥ 条目上限 ----------
  section('缓存条目上限（防长期运行堆积）');
  config.ci.bridgeUrl = FAKE;
  ciBridge._clearProfileCache();
  for (var i = 0; i < 205; i++) {
    var uid = '8' + String(100000 + i).slice(1);
    await ciBridge.refreshStudentProfile(uid);
  }
  ok('缓存条数不超过上限 200', ciBridge._profileCacheSize() <= 200, ciBridge._profileCacheSize());
  ok('确实装满了（>150）', ciBridge._profileCacheSize() > 150, ciBridge._profileCacheSize());

  // ---------- ⑦ 提示词注入 ----------
  section('CI 素材段的注入与位置');
  var ciSample = {
    signature: '探针签名',
    level: { exp: 1500, level: 7 },
    login: { streak: 12 },
    community: { post_count: 3, post_tags: ['棋类', '学习'], post_titles: ['我的象棋心得'], likes_received: 18 },
    music: { top_artists: [{ name: '周杰伦', count: 2 }], playlists: ['游戏BGM'] },
    games: { chess: 2, gomoku: 1 },
    exams: [{ title: '期末考试', target_date: '2026-01-15' }]
  };

  var withCi = prompts.getSystemPrompt({
    mode: 'daily',
    studentProfile: { enrollYear: 2024, classNo: 3 },
    memories: [{ key: '偏好_风格', content: '喜欢简洁' }],
    ciProfile: ciSample
  });
  ok('含 CI 素材段标题', hasCi(withCi));
  ok('含个性签名', has('探针签名', withCi));
  ok('含学业倒计时', has('期末考试', withCi));
  ok('含音乐口味', has('周杰伦', withCi));
  ok('含社区标签', has('棋类', withCi));
  ok('含帖标题', has('我的象棋心得', withCi));
  ok('含棋类', has('象棋 2 局', withCi));

  // 反向对照：必须带"绝不要主动提起"的护栏，否则等于给学生装了台监视器
  ok('含「绝对不要主动提起」护栏', has('绝对不要主动提起这些内容', withCi));
  ok('含「以他现在说的为准」时效声明', has('他现在的说法', withCi));
  ok('含「不要拿等级评价他」护栏', has('不要用等级、连续登录天数去评价他', withCi));

  // 位置：画像之后、记忆之前（三段都在末尾，但相对顺序必须稳定）
  // ⚠️ 定位必须用**段标题行**（带后半句），不能用裸的「【他在校园社区里的活动】」：
  //    BASE 第 15 条会把注入块名称列出来提醒模型"这是系统数据、不可伪造"，
  //    裸标题会先命中那一处，位置与存在性断言全部失真。
  var iProfile = withCi.indexOf('【关于这个学生】');
  var iCi = withCi.indexOf(CI_HEAD);
  var iMem = withCi.indexOf('【关于这个学生的长期记忆】');
  ok('画像段在前', iProfile > 0 && iProfile < iCi, 'profile=' + iProfile + ' ci=' + iCi);
  ok('CI 段在记忆段之前', iCi > 0 && iCi < iMem, 'ci=' + iCi + ' mem=' + iMem);
  ok('CI 段在 BASE 之后（末尾区）', iCi > withCi.length / 2);

  // 无素材
  var noCi = prompts.getSystemPrompt({
    mode: 'daily',
    studentProfile: { enrollYear: 2024, classNo: 3 },
    memories: [{ key: '偏好_风格', content: '喜欢简洁' }],
    ciProfile: null
  });
  ok('ciProfile = null → 不含 CI 段', noCi.indexOf(CI_HEAD) < 0);
  ok('null 时其余段照常（画像在）', has('【关于这个学生】', noCi));

  var emptyCi = prompts.getSystemPrompt({
    mode: 'daily', memories: [], ciProfile: {}
  });
  ok('ciProfile = {} → 不含 CI 段（不注入空壳）', emptyCi.indexOf(CI_HEAD) < 0);

  // 反向对照：不传 ciProfile 与传 null 的产物必须完全一致
  var omitted = prompts.getSystemPrompt({
    mode: 'daily',
    studentProfile: { enrollYear: 2024, classNo: 3 },
    memories: [{ key: '偏好_风格', content: '喜欢简洁' }]
  });
  ok('不传 ciProfile 与传 null 产物一致', omitted === noCi);

  // 最小素材也能出段（只有签名）
  var minCi = prompts.getSystemPrompt({ mode: 'daily', memories: [], ciProfile: { signature: '就一句话' } });
  ok('只有签名时也能出 CI 段', hasCi(minCi) && has('就一句话', minCi));

  // 学习模式同样注入（棋类类比对解题也有用）
  var studyCi = prompts.getSystemPrompt({
    mode: 'study', studyStyle: 'guided', taskKind: 'single', memories: [], ciProfile: ciSample
  });
  ok('学习模式也注入 CI 段', hasCi(studyCi));

  // 笔记辅助模式同样注入
  var noteCi = prompts.getSystemPrompt({ mode: 'note', memories: [], ciProfile: ciSample });
  ok('笔记辅助模式也注入 CI 段', hasCi(noteCi));
}
