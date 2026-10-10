// v3 功能端到端验证
//
// 覆盖：
//   1. 错题提取：批改后自动入库，且正文里不含 <wrong-items>
//   2. 错题本 CRUD、筛选、批量、导出、越权
//   3. 记录接口：类型判定、缩略图、分页
//   4. 作文三种用途（且**不带图也能用**，验证 requiresImage 区分生效）
//   5. 回归：v2 的闸门与扣费仍正常
//
// 用法：node scripts/verify-v3.js （需先启动 mock 上游与 Cluss 服务端）

require('dotenv').config();
var http = require('./lib/http');
var FormData = require('form-data');
var db = require('../src/utils/db');

// 目标地址统一走 lib/target：只允许本机实例（除非显式 ALLOW_REMOTE=1），
// http/https 且不内嵌凭据 —— 这些脚本会清数据改配置，指向错对象是危险操作
var target = require('./lib/target');
var BASE = target.resolve(process.env.PORT || 9003);
// mock 上游是另一台"本机服务"，要显式放行（见 lib/target.allow）
var MOCK = target.allow('http://127.0.0.1:9200');

var pass = 0, fail = 0;
var failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function section(t) { console.log('\n=== ' + t + ' ==='); }

function makePng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  );
}

function parseSse(raw) {
  var out = [];
  var frames = String(raw).split('\n\n');
  for (var i = 0; i < frames.length; i++) {
    if (!frames[i].trim()) continue;
    var lines = frames[i].split('\n');
    var ev = 'message', data = [];
    for (var j = 0; j < lines.length; j++) {
      if (lines[j].indexOf('event:') === 0) ev = lines[j].slice(6).trim();
      else if (lines[j].indexOf('data:') === 0) data.push(lines[j].slice(5).trim());
    }
    if (!data.length) continue;
    try { out.push({ event: ev, data: JSON.parse(data.join('\n')) }); } catch (e) {}
  }
  return out;
}

function readSse(url, token, body) {
  return http.postJson(url, body, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    responseType: 'stream', timeout: 60000,
    validateStatus: function() { return true; }
  }).then(function(resp) {
    return new Promise(function(resolve, reject) {
      var buf = '';
      resp.data.on('data', function(c) { buf += c.toString('utf8'); });
      resp.data.on('end', function() {
        resolve({ status: resp.status, raw: buf, events: parseSse(buf) });
      });
      resp.data.on('error', reject);
    });
  });
}

function post(url, token, body) {
  return http.postJson(url, body, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    validateStatus: function() { return true; }
  });
}
function put(url, token, body) {
  return http.putJson(url, body, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    validateStatus: function() { return true; }
  });
}
function del(url, token) {
  return http.del(url, { headers: { Authorization: 'Bearer ' + token }, validateStatus: function() { return true; } });
}
function get(url, token) {
  return http.getJson(url, { headers: token ? { Authorization: 'Bearer ' + token } : {}, validateStatus: function() { return true; } });
}

// ---- 配置快照 ----
//
// 本脚本会改写模型表，**还会把 vision_relay_model_id 强制指向 mock 视觉模型**。
// 不还原的话，在一台已经配好真实模型的机器上跑一次验证，
// 线上模型与视觉配置就全被改掉了 —— 而报错只会说"AI 不可用"，
// 几乎没人会联想到是验证脚本干的。所以自动快照、自动还原。
var MODEL_SNAPSHOT = null;
var META_SNAPSHOT = null;

function snapshotConfig() {
  MODEL_SNAPSHOT = db.prepare('SELECT * FROM ai_models').all();
  META_SNAPSHOT = db.prepare('SELECT * FROM cluss_meta').all();
}

function restoreConfig() {
  if (!MODEL_SNAPSHOT) return;

  var tx = db.transaction(function() {
    var mCols = Object.keys(MODEL_SNAPSHOT[0] || {});
    if (mCols.length) {
      db.prepare('DELETE FROM ai_models').run();
      var ms = db.prepare('INSERT INTO ai_models (' + mCols.join(',') + ') VALUES (' +
        mCols.map(function() { return '?'; }).join(',') + ')');
      MODEL_SNAPSHOT.forEach(function(row) { ms.run(mCols.map(function(c) { return row[c]; })); });
    }
    var kCols = Object.keys(META_SNAPSHOT[0] || {});
    if (kCols.length) {
      db.prepare('DELETE FROM cluss_meta').run();
      var ks = db.prepare('INSERT INTO cluss_meta (' + kCols.join(',') + ') VALUES (' +
        kCols.map(function() { return '?'; }).join(',') + ')');
      META_SNAPSHOT.forEach(function(row) { ks.run(kCols.map(function(c) { return row[c]; })); });
    }
  });
  tx();
  console.log('\n[清理] 模型与视觉配置已还原为本脚本运行前的状态');
}

function setupModels() {
  var stmt = db.prepare([
    'INSERT INTO ai_models (id, label, api_url, api_key, model_name, api_style, supports_stream,',
    '  supports_vision, price_in, price_out, price_cache_hit, is_free, enabled, is_default, sort_order)',
    'VALUES (?, ?, ?, ?, ?, \'openai\', 1, ?, ?, ?, ?, ?, 1, ?, ?)',
    'ON CONFLICT(id) DO UPDATE SET api_url = excluded.api_url, api_key = excluded.api_key,',
    '  supports_vision = excluded.supports_vision, enabled = 1'
  ].join('\n'));

  // 先清掉所有 is_default，再指定本脚本要用的那个。
  // 不清的话会留下**两个** is_default=1（比如库里原本有真实默认模型），
  // 而 getDefaultModelId 遇到多行时选哪个是不确定的 ——
  // 表现就是"同一个请求有时走 mock、有时走真实模型"，断言会随机失败。
  db.prepare('UPDATE ai_models SET is_default = 0').run();

  stmt.run('deepseek-chat', 'DeepSeek Chat', MOCK, 'mock-key', 'deepseek-chat', 1, 2000, 8000, 200, 0, 1, 0);
  stmt.run('plain-model', '经济型模型', MOCK, 'mock-key', 'plain', 0, 2000, 8000, 200, 0, 0, 10);
  stmt.run('vision-model', '视觉模型', MOCK, 'mock-key', 'vision', 1, 2000, 8000, 200, 0, 0, 11);

  // 只保留"测试用的那个"是默认；其它可能存在的旧默认已经被上面清掉
  db.prepare('UPDATE ai_models SET is_default = 1 WHERE id = ?').run('deepseek-chat');

  db.prepare("INSERT INTO cluss_meta (key, value) VALUES ('vision_relay_model_id', 'vision-model') ON CONFLICT(key) DO UPDATE SET value = 'vision-model'").run();
  console.log('[setup] 模型已配置（默认模型 = deepseek-chat）');
}

// 破坏性：清空所有学生账号与业务数据。
// 库里有真实数据时默认拒绝执行，必须显式加 --force（同 verify-v2 的理由：
// 曾在一台配好演示数据的机器上无声清空过）。
// 清场：**只删本脚本自己造的数据**，绝不碰真实账号。
// 原来这里是 `DELETE FROM users WHERE is_admin = 0`（删光所有学生），
// 在真实库上跑会连用户正在试用的账号一起删掉 —— 见 verify-v2 里那段更长的说明。
// 本脚本注册的学生用 net_name='v3test' 标记，只清这些账号及其名下数据。
var TEST_NET_NAME = 'v3test';

function reset() {
  var testUsers = db.prepare('SELECT user_id FROM users WHERE net_name = ?')
    .all(TEST_NET_NAME).map(function(r) { return r.user_id; });

  var others = db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 0 AND net_name <> ?')
    .get(TEST_NET_NAME).c;

  if (!testUsers.length) {
    console.log('[setup] 没有上次遗留的测试账号，跳过清理' +
      (others ? '（库里有 ' + others + ' 个真实学生，未触碰）' : ''));
    return;
  }

  // better-sqlite3 的方法依赖 this，apply(null, ...) 会抛 Illegal invocation
  function callStmt(sql, args) {
    var stmt = db.prepare(sql);
    return stmt.all.apply(stmt, args);
  }
  function runStmt(sql, args) {
    var stmt = db.prepare(sql);
    return stmt.run.apply(stmt, args);
  }

  var qs = testUsers.map(function() { return '?'; }).join(',');
  var convIds = callStmt(
    'SELECT id FROM ai_conversations WHERE user_id IN (' + qs + ')', testUsers
  ).map(function(r) { return r.id; });

  var tx = db.transaction(function() {
    if (convIds.length) {
      var cs = convIds.map(function() { return '?'; }).join(',');
      runStmt('DELETE FROM ai_messages WHERE conversation_id IN (' + cs + ')', convIds);
    }
    var us = testUsers.map(function() { return '?'; }).join(',');
    ['cluss_usage_log', 'cluss_credit_log', 'cluss_credit',
     'ai_conversations', 'wrong_questions', 'writing_pieces',
     'cloud_user_files'].forEach(function(t) {
      runStmt('DELETE FROM ' + t + ' WHERE user_id IN (' + us + ')', testUsers);
    });
    db.prepare('DELETE FROM users WHERE net_name = ?').run(TEST_NET_NAME);
  });
  tx();

  console.log('[setup] 已清理上次的 ' + testUsers.length + ' 个测试账号及其数据' +
    (others ? '；' + others + ' 个真实学生未触碰' : ''));
}

var studentToken = '', adminToken = '', studentId = '';
var imgHash = '';

function run() {
  snapshotConfig();
  reset();
  setupModels();

  section('0. 准备：注册 + 充值 + 上传题图');
  return post(BASE + '/api/auth/register', '', {
    net_name: 'v3test', real_name: '验证三号', enrollment_year: '2025',
    class_no: '8', password: 'test1234', confirm_password: 'test1234'
  }).then(function(r) {
    ok('注册成功', r.data.code === 200);
    studentToken = r.data.data.token;
    studentId = r.data.data.user_info.user_id;

    return post(BASE + '/api/auth/login', '', { account: '999999', password: 'admin12345' });
  }).then(function(r) {
    adminToken = r.data.data.token;
    return put(BASE + '/api/admin/users/' + studentId + '/quota', adminToken,
      { quota_yuan: 100, weekly_yuan: 50, reason: 'v3 验证充值' });
  }).then(function(r) {
    ok('充值成功', r.data.code === 200);

    var form = new FormData();
    form.append('file', makePng(), { filename: '作业.png', contentType: 'image/png' });
    return http.postJson(BASE + '/api/cloud/upload', form, {
      headers: Object.assign({ Authorization: 'Bearer ' + studentToken }, form.getHeaders()),
      maxBodyLength: Infinity
    });
  }).then(function(r) {
    ok('上传题图成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 120));
    imgHash = r.data.data.hash;
  })

  // ============================================================
  .then(function() {
    section('1. 错题自动提取');
    return readSse(BASE + '/api/study/grade/stream', studentToken, {
      model_id: 'deepseek-chat',
      answer_hashes: [imgHash]
    });
  }).then(function(r) {
    var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
    var text = r.events.filter(function(e) { return e.event === 'delta'; })
      .map(function(e) { return e.data.text; }).join('');

    ok('批改流式完成', !!done, '事件数 ' + r.events.length);
    ok('done 事件带 wrong_added', !!(done && done.data.wrong_added !== undefined),
      done ? JSON.stringify(done.data.wrong_added) : '');
    ok('自动收录 2 道错题', !!(done && done.data.wrong_added === 2),
      done ? String(done.data.wrong_added) : '');

    // 流式正文里不能出现 JSON（前端截断，但后端这里断言流本身也干净不了——
    // 后端是转完才剥离，所以流里必然含标记；这里只断言存档与接口层干净）
    var rows = db.prepare('SELECT question, subject, tag, source, image_hash FROM wrong_questions WHERE user_id = ? ORDER BY id').all(studentId);
    ok('错题表有 2 条', rows.length === 2, '实际 ' + rows.length);
    ok('学科识别为物理', !!(rows[0] && rows[0].subject === '物理'), rows[0] ? rows[0].subject : '');
    ok('tag 分别为 ✗ 与 △', !!(rows[0] && rows[0].tag === '✗' && rows[1] && rows[1].tag === '△'),
      rows.map(function(x) { return x.tag; }).join(','));
    ok('来源标记为 ai', !!(rows[0] && rows[0].source === 'ai'));
    ok('关联了来源题图', !!(rows[0] && rows[0].image_hash === imgHash));
    void text;

    // 存档的助手消息里不能含 <wrong-items>
    var msg = db.prepare([
      "SELECT content FROM ai_messages WHERE role='assistant' AND source='grade'",
      'ORDER BY id DESC LIMIT 1'
    ].join('\n')).get();
    ok('存档正文已剥离结构化块', !!(msg && msg.content.indexOf('<wrong-items') === -1),
      msg ? ('长度 ' + msg.content.length) : '无消息');
    ok('存档正文保留了批改表格', !!(msg && msg.content.indexOf('| 题号 |') !== -1));
  })

  // ============================================================
  .then(function() {
    section('2. 错题本 CRUD 与权限');
    return get(BASE + '/api/wrong-book?mastered=0', studentToken);
  }).then(function(r) {
    ok('列表可用', r.data.code === 200 && r.data.data.items.length === 2, '实际 ' + (r.data.data.items || []).length);
    ok('统计正确（待复习 2）', r.data.data.counts.pending === 2, JSON.stringify(r.data.data.counts));
    var first = r.data.data.items[0];
    ok('列表项含题干与错因', !!(first.question && first.reason));
    ok('列表项带来源题图缩略图', !!first.image_url);
    global.__w1 = first.id;

    return get(BASE + '/api/wrong-book/subjects', studentToken);
  }).then(function(r) {
    ok('学科列表可用', r.data.code === 200 && r.data.data.subjects.length === 1,
      JSON.stringify(r.data.data.subjects));

    return put(BASE + '/api/wrong-book/' + global.__w1, studentToken, { mastered: true, note: '已重做一遍' });
  }).then(function(r) {
    ok('标记已掌握成功', r.data.code === 200 && r.data.data.item.mastered === true);

    return get(BASE + '/api/wrong-book?mastered=1', studentToken);
  }).then(function(r) {
    ok('按已掌握筛选正确', r.data.data.items.length === 1, '实际 ' + r.data.data.items.length);

    return post(BASE + '/api/wrong-book', studentToken, {
      subject: '数学', question: '手动添加的题', student_answer: '错的', correct_answer: '对的',
      reason: '测试错因', tag: '✗'
    });
  }).then(function(r) {
    ok('手动新增成功', r.data.code === 200 && r.data.data.item.source === 'manual',
      JSON.stringify(r.data.data && r.data.data.item || {}).slice(0, 80));
    global.__w3 = r.data.data.item.id;

    return post(BASE + '/api/wrong-book', studentToken, { question: '' });
  }).then(function(r) {
    ok('空题干被拒', r.status === 400, 'HTTP ' + r.status);

    return put(BASE + '/api/wrong-book/' + global.__w1, studentToken, { question: '' });
  }).then(function(r) {
    ok('编辑时清空题干被拒', r.status === 400, 'HTTP ' + r.status);

    return post(BASE + '/api/wrong-book/batch', studentToken, { ids: [global.__w1, global.__w3], action: 'unmaster' });
  }).then(function(r) {
    ok('批量标回待复习成功', r.data.code === 200 && r.data.data.affected === 2, JSON.stringify(r.data));

    return del(BASE + '/api/wrong-book/' + global.__w3, studentToken);
  }).then(function(r) {
    ok('删除成功', r.data.code === 200);

    return get(BASE + '/api/wrong-book/export.csv', studentToken);
  }).then(function(r) {
    var body = String(r.data || '');
    ok('CSV 导出可用', r.status === 200 && String(r.headers['content-type']).indexOf('text/csv') === 0,
      'HTTP ' + r.status);
    ok('CSV 含表头与数据', body.indexOf('学科,题干') === 0 && body.indexOf('手动添加的题') === -1,
      body.slice(0, 40));

    // 越权：管理员读学生的错题
    return get(BASE + '/api/wrong-book/' + global.__w1, adminToken);
  }).then(function(r) {
    ok('越权读他人错题返回 404', r.status === 404, 'HTTP ' + r.status);

    // 越权：用别人的 id 批量改
    return post(BASE + '/api/wrong-book/batch', adminToken, { ids: [global.__w1], action: 'delete' });
  }).then(function(r) {
    ok('越权批量操作影响 0 条', r.data.code === 200 && r.data.data.affected === 0,
      JSON.stringify(r.data.data || {}));
    var still = db.prepare('SELECT COUNT(*) AS c FROM wrong_questions WHERE id = ?').get(global.__w1);
    ok('原错题未被删掉', still.c === 1, '剩余 ' + still.c);
  })

  // ============================================================
  .then(function() {
    section('3. 解题与批改记录');
    // 再造一条拍题记录，用于验证类型筛选
    return readSse(BASE + '/api/study/solve/stream', studentToken, {
      model_id: 'deepseek-chat', paper_mode: 'single', image_hashes: [imgHash]
    });
  }).then(function() {
    return get(BASE + '/api/study/records?type=all', studentToken);
  }).then(function(r) {
    ok('记录列表可用', r.data.code === 200, JSON.stringify(r.data).slice(0, 100));
    var items = r.data.data.items || [];
    ok('有 2 条记录（1 拍题 1 批改）', items.length === 2, '实际 ' + items.length);

    var types = items.map(function(x) { return x.type; }).sort();
    ok('类型判定正确', types.join(',') === 'grade,solve', types.join(','));

    var graded = items.filter(function(x) { return x.type === 'grade'; })[0];
    ok('批改记录带缩略图', !!(graded && graded.thumb_hash === imgHash), graded ? graded.thumb_hash.slice(0, 8) : '');
    ok('记录带摘要', !!(graded && graded.summary && graded.summary.length > 0),
      graded ? graded.summary.slice(0, 30) : '');
    ok('摘要不含 Markdown 标记', !!(graded && graded.summary.indexOf('|') === -1 && graded.summary.indexOf('#') === -1),
      graded ? graded.summary.slice(0, 40) : '');

    return get(BASE + '/api/study/records?type=grade', studentToken);
  }).then(function(r) {
    ok('按批改筛选返回 1 条', r.data.data.items.length === 1 && r.data.data.items[0].type === 'grade',
      '实际 ' + r.data.data.items.length);

    return get(BASE + '/api/study/records?type=solve', studentToken);
  }).then(function(r) {
    ok('按拍题筛选返回 1 条', r.data.data.items.length === 1 && r.data.data.items[0].type === 'solve',
      '实际 ' + r.data.data.items.length);

    // 关键词搜索：批改回复的小结里必含「运动学公式」（mock 固定文案），
    // 命中的应该是那条批改记录（消息正文走 EXISTS 子查询）
    return get(BASE + '/api/study/records?type=all&q=' + encodeURIComponent('运动学公式'), studentToken);
  }).then(function(r) {
    var items = r.data.data.items || [];
    ok('按内容关键词搜到批改记录', items.length === 1 && items[0].type === 'grade',
      '实际 ' + items.length);

    return get(BASE + '/api/study/records?type=all&q=' + encodeURIComponent('zzz不存在的关键词'), studentToken);
  }).then(function(r) {
    ok('搜不到时返回 0 条', r.data.data.items.length === 0 && r.data.data.total === 0,
      '实际 ' + r.data.data.total);
  })

  // ============================================================
  .then(function() {
    section('4. 作文：三种用途');
    return readSse(BASE + '/api/writing/generate/stream', studentToken, {
      language: 'zh', genre: '记叙文', style: '细腻描写', word_limit: 800,
      topic: '以「那一刻我长大了」为题写一篇记叙文'
    });
  }).then(function(r) {
    var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
    var text = r.events.filter(function(e) { return e.event === 'delta'; })
      .map(function(e) { return e.data.text; }).join('');

    ok('生成范文成功（不带图）', !!done, '事件数 ' + r.events.length);
    ok('生成了正文', text.length > 50, '长度 ' + text.length);
    ok('带字数标注', text.indexOf('本文共约') !== -1, text.slice(-60));
    global.__essay = text;
  }).then(function() {
    return readSse(BASE + '/api/writing/outline/stream', studentToken, {
      language: 'zh', genre: '记叙文', word_limit: 600, topic: '我的老师'
    });
  }).then(function(r) {
    var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
    var text = r.events.filter(function(e) { return e.event === 'delta'; })
      .map(function(e) { return e.data.text; }).join('');
    ok('生成提纲成功', !!done && text.indexOf('写作提纲') !== -1, text.slice(0, 40));

    return readSse(BASE + '/api/writing/grade/stream', studentToken, {
      language: 'zh', topic: '那一刻我长大了',
      content: '那天我很感动。妈妈在做饭，我看了很久，突然觉得应该帮她，于是我去帮忙了。'
    });
  }).then(function(r) {
    var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
    var text = r.events.filter(function(e) { return e.event === 'delta'; })
      .map(function(e) { return e.data.text; }).join('');
    ok('批改作文成功', !!done && text.indexOf('逐段点评') !== -1, text.slice(0, 40));
    ok('批改含润色示例', text.indexOf('润色示例') !== -1);

    // 英文生成
    return readSse(BASE + '/api/writing/generate/stream', studentToken, {
      language: 'en', genre: 'Narrative', word_limit: 150, topic: 'A memorable trip'
    });
  }).then(function(r) {
    var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
    var text = r.events.filter(function(e) { return e.event === 'delta'; })
      .map(function(e) { return e.data.text; }).join('');

    ok('英文模式可用', !!done);
    // mock 只在收到英文任务标记时才回英文范文，所以这条同时验证了
    // 「language 确实被拼进了提示词」——若没传，mock 会回中文，断言立刻失败
    ok('英文模式返回英文内容（验证 language 已进提示词）',
      text.indexOf('A Memorable Trip') !== -1,
      text.slice(0, 40));
    ok('英文模式带 Word count 标注', text.indexOf('Word count') !== -1, text.slice(-40));
  })

  // ============================================================
  .then(function() {
    section('5. 作文参数与保存');
    return post(BASE + '/api/writing/generate/stream', studentToken, { language: 'zh' });
  }).then(function(r) {
    ok('缺题目被拒', r.status === 400, 'HTTP ' + r.status + ' ' + (r.data.message || ''));

    return post(BASE + '/api/writing/grade/stream', studentToken, { language: 'zh' });
  }).then(function(r) {
    ok('批改缺内容与图被拒', r.status === 400, 'HTTP ' + r.status);

    return post(BASE + '/api/writing/pieces', studentToken, {
      mode: 'generate', language: 'zh', genre: '记叙文', style: '细腻描写',
      word_limit: 800, topic: '那一刻我长大了', content: global.__essay
    });
  }).then(function(r) {
    ok('保存作文成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 100));
    global.__pieceId = r.data.data.id;

    return get(BASE + '/api/writing/pieces', studentToken);
  }).then(function(r) {
    ok('作文记录列表可用', r.data.data.items.length === 1, '实际 ' + r.data.data.items.length);
    ok('列表含摘要与长度', !!(r.data.data.items[0].excerpt && r.data.data.items[0].content_len > 0));
    ok('列表不回传全文', !r.data.data.items[0].content, '（避免几千字 × N 条）');

    return get(BASE + '/api/writing/pieces/' + global.__pieceId, studentToken);
  }).then(function(r) {
    ok('查看单篇含全文', r.data.data.piece.content.length > 50, '长度 ' + r.data.data.piece.content.length);

    // 越权
    return get(BASE + '/api/writing/pieces/' + global.__pieceId, adminToken);
  }).then(function(r) {
    ok('越权读他人作文返回 404', r.status === 404, 'HTTP ' + r.status);

    return del(BASE + '/api/writing/pieces/' + global.__pieceId, studentToken);
  }).then(function(r) {
    ok('删除作文成功', r.data.code === 200);

    return post(BASE + '/api/writing/pieces', studentToken, { mode: 'bogus', content: 'x' });
  }).then(function(r) {
    ok('非法 mode 被拒', r.status === 400, 'HTTP ' + r.status);
  })

  // ============================================================
  .then(function() {
    section('6. 回归：闸门、台账、用量');
    return get(BASE + '/api/wallet', studentToken);
  }).then(function(r) {
    var w = r.data.data;
    // 学生端口径是积分，且**不应该有任何金额字段**（见 README「计费单位」）。
    // 注意：单次消耗不足 1 积分时 used_points 会四舍五入成 0，
    // 所以这里断言"总额度消耗 > 0"更稳 —— 累计是按微元算的，不会丢账。
    ok('额度已扣减（按微元累计）', Number(w.allocated_points) - Number(w.available_points) > 0,
      '额度 ' + w.allocated_points + ' / 可用 ' + w.available_points);
    ok('学生端额度视图不含金额字段', w.used_yuan === undefined && w.allocated_yuan === undefined);
    console.log('    额度 ' + w.allocated_points + ' 积分 / 可用 ' + w.available_points +
      ' 积分（两位小数口径，可用量向下保留到「分」）');

    return get(BASE + '/api/usage/summary?days=7&group_by=source', studentToken);
  }).then(function(r) {
    var keys = (r.data.data.items || []).map(function(x) { return x.key; });
    ok('用量按来源统计含解题链路', keys.indexOf('grade') !== -1 || keys.indexOf('solve') !== -1,
      keys.join(','));

    return get(BASE + '/api/admin/usage/records?days=7&limit=10', adminToken);
  }).then(function(r) {
    var items = r.data.data.items || [];
    ok('管理端能看到明细', items.length > 0, '共 ' + r.data.data.total + ' 条');
    var hasWriting = items.some(function(x) { return x.source === 'writing'; });
    ok('明细含 writing 来源', hasWriting, items.map(function(x) { return x.source; }).join(','));

    // 题目必须带图这条仍生效（防止 requiresImage 改动把拍题的校验削弱了）
    return post(BASE + '/api/study/solve/stream', studentToken, {
      model_id: 'deepseek-chat', paper_mode: 'single', image_hashes: []
    });
  }).then(function(r) {
    ok('拍题无图仍被拒（校验未削弱）', r.status === 400, 'HTTP ' + r.status);
  })

  .then(function() {
    restoreConfig();

    section('结果');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (failures.length) {
      console.log('\n失败项：');
      failures.forEach(function(f) { console.log('  - ' + f); });
    }
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch(function(err) {
    // 中途失败也要还原，否则会留下一份被改成 mock 的模型与视觉配置
    try { restoreConfig(); } catch (e) { console.error('[清理] 还原失败:', e.message); }
    console.error('\n[脚本异常]', err.message);
    if (err.response) console.error('status', err.response.status, String(err.response.data).slice(0, 300));
    process.exit(1);
  });
}

run();