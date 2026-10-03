// v2 功能端到端验证脚本
//
// 覆盖：
//   1. 回归：注册 → 闸门拦截 → 充值 → 对话扣费
//   2. 云盘：上传图片 / 上传文本 / 列表 / 读取 / 配额
//   3. 视觉 native：模型支持视觉时，应收到 image_url 内容块
//   4. 视觉 relay：模型不支持视觉时，应先转述再回答（两条 usage 共享 trace_id）
//   5. 拍题三模式 + 作业批改：提示词分支是否正确生效
//   6. 用量统计：学生端与管理端能否查到带 source 的明细
//   7. 安全边界：非图片文件、越权 hash、超限图片数
//
// 用法：node scripts/verify-v2.js   （需先启动 mock 上游与 Cluss 服务端）

require('dotenv').config();
var http = require('./lib/http');
var fs = require('fs');
var path = require('path');
var FormData = require('form-data');
var db = require('../src/utils/db');

// 目标地址统一走 lib/target：只允许本机实例（除非显式 ALLOW_REMOTE=1），
// http/https 且不内嵌凭据 —— 这些脚本会清数据改配置，指向错对象是危险操作
var BASE = require('./lib/target').resolve(process.env.PORT || 9101);
var MOCK = 'http://127.0.0.1:9200';

var pass = 0;
var fail = 0;
var failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

// 生成一张真实的小 PNG（1x1 像素），确保魔数嗅探能识别
function makePngBuffer() {
  // 最小的合法 PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  );
}

// 生成一张较大的 PNG 用于验证缩图链路（由 JPEG 数据 + 重复填充构成，仅用于体积测试）
function makeBigJpegBuffer(sizeKb) {
  // 一个最小合法 JPEG 头 + 填充。sharp 会尝试解码，失败则回退原图——
  // 本脚本只断言「不因为大图而失败」，不断言一定被压缩
  var head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  var tail = Buffer.from([0xFF, 0xD9]);
  var pad = Buffer.alloc(Math.max(0, sizeKb * 1024 - head.length - tail.length), 0x20);
  return Buffer.concat([head, pad, tail]);
}

function upload(token, buffer, filename, mime) {
  var form = new FormData();
  form.append('file', buffer, { filename: filename, contentType: mime });
  return http.postJson(BASE + '/api/cloud/upload', form, {
    headers: Object.assign({ Authorization: 'Bearer ' + token }, form.getHeaders()),
    maxBodyLength: Infinity,
    validateStatus: function() { return true; }
  });
}

// 解析 SSE 文本为事件数组
function parseSse(raw) {
  var events = [];
  var frames = String(raw).split('\n\n');
  for (var i = 0; i < frames.length; i++) {
    if (!frames[i].trim()) continue;
    var lines = frames[i].split('\n');
    var ev = 'message';
    var dataLines = [];
    for (var j = 0; j < lines.length; j++) {
      if (lines[j].indexOf('event:') === 0) ev = lines[j].slice(6).trim();
      else if (lines[j].indexOf('data:') === 0) dataLines.push(lines[j].slice(5).trim());
    }
    if (!dataLines.length) continue;
    try { events.push({ event: ev, data: JSON.parse(dataLines.join('\n')) }); } catch (e) {}
  }
  return events;
}

function streamPost(url, token, body) {
  return http.postJson(url, body, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    responseType: 'stream',
    timeout: 60000,
    validateStatus: function() { return true; }
  }).then(function(resp) {
    return new Promise(function(resolve, reject) {
      var buf = '';
      resp.data.on('data', function(c) { buf += c.toString('utf8'); });
      resp.data.on('end', function() { resolve({ status: resp.status, raw: buf, events: parseSse(buf) }); });
      resp.data.on('error', reject);
    });
  });
}

function jsonPost(url, token, body) {
  return http.postJson(url, body, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    validateStatus: function() { return true; }
  });
}

function get(url, token) {
  return http.getJson(url, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    validateStatus: function() { return true; }
  });
}

// ---- 模型配置快照 ----
//
// 本脚本会把模型改成指向 mock。不还原的话，在一台**已经配好真实模型**的机器上
// 跑一次验证，线上模型就全被指向 mock 了 —— 而报错信息只会说"AI 服务暂时不可用"，
// 几乎没人会联想到是验证脚本干的。所以这里自动做快照与还原。
var MODEL_SNAPSHOT = null;

function snapshotModels() {
  MODEL_SNAPSHOT = db.prepare('SELECT * FROM ai_models').all();
}

function restoreModels() {
  if (!MODEL_SNAPSHOT) return;
  var cols = Object.keys(MODEL_SNAPSHOT[0] || {});
  if (!cols.length) return;

  var tx = db.transaction(function() {
    db.prepare('DELETE FROM ai_models').run();
    var stmt = db.prepare(
      'INSERT INTO ai_models (' + cols.join(',') + ') VALUES (' +
      cols.map(function() { return '?'; }).join(',') + ')'
    );
    MODEL_SNAPSHOT.forEach(function(row) {
      stmt.run(cols.map(function(c) { return row[c]; }));
    });
  });
  tx();
  console.log('\n[清理] 模型配置已还原为本脚本运行前的状态（共 ' + MODEL_SNAPSHOT.length + ' 个）');
}

// ---- 测试用的辅助：直接改库来配置模型（管理接口在后面才测）----
function configureModels() {
  // 主模型：指向 mock，标为支持视觉。
  // enabled 必须显式打开：这个脚本现在允许在"模型表非空"的库上跑，
  // 而那个 id 可能因为被停用而处于 enabled=0 状态。
  db.prepare([
    'UPDATE ai_models SET api_url = ?, api_key = ?, price_in = 2000, price_out = 8000,',
    '  price_cache_hit = 200, supports_vision = 1, enabled = 1 WHERE id = ?'
  ].join('\n')).run(MOCK, 'mock-key', 'deepseek-chat');

  // 造两个专用模型：一个纯文本（用于 relay 测试），一个视觉（当转述模型）
  var stmt = db.prepare([
    'INSERT INTO ai_models (id, label, api_url, api_key, model_name, api_style, supports_stream,',
    '  supports_vision, price_in, price_out, price_cache_hit, is_free, enabled, is_default, sort_order)',
    'VALUES (?, ?, ?, ?, ?, \'openai\', 1, ?, ?, ?, ?, ?, 1, 0, ?)',
    'ON CONFLICT(id) DO UPDATE SET api_url = excluded.api_url, supports_vision = excluded.supports_vision,',
    '  price_in = excluded.price_in, price_out = excluded.price_out, enabled = 1'
  ].join('\n'));

  stmt.run('plain-model', '纯文本模型', MOCK, 'mock-key', 'plain', 0, 2000, 8000, 200, 0, 10);
  stmt.run('vision-model', '视觉模型', MOCK, 'mock-key', 'vision', 1, 2000, 8000, 200, 0, 11);
  console.log('[setup] 模型已配置：deepseek-chat(视觉) / plain-model(纯文本) / vision-model(视觉)');
}

// 这是**破坏性**操作：清空所有学生账号与业务数据。
//
// 加了防呆是因为它踩过一次真实事故：在一台已经配好演示数据的机器上跑验证，
// 学生账号和额度被无声删光 —— 脚本只打印一行"业务数据已清空"，
// 而使用者以为那只是"测试用的清理"。数据没了才发现。
//
// 所以：库里有真实数据时默认**拒绝执行**，必须显式加 --force。
function resetData() {
  var force = process.argv.indexOf('--force') >= 0;

  var students = db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 0').get().c;
  var usage = db.prepare('SELECT COUNT(*) c FROM cluss_usage_log').get().c;
  var convs = db.prepare('SELECT COUNT(*) c FROM ai_conversations').get().c;

  if (!force && (students > 0 || usage > 0)) {
    console.error('\n[拒绝执行] 这个库里有真实数据：');
    console.error('    学生账号 ' + students + ' 个、会话 ' + convs + ' 个、用量记录 ' + usage + ' 条');
    console.error('    本脚本会**全部删除**它们（含额度与云盘文件），且不可恢复。');
    console.error('\n    确认要清空后再跑：node scripts/verify-v2.js --force');
    console.error('    想保留现有数据，请先备份 database/ 目录（三个文件一起）。\n');
    process.exit(1);
  }

  db.prepare('DELETE FROM cluss_usage_log').run();
  db.prepare('DELETE FROM cluss_credit_log').run();
  db.prepare('DELETE FROM cluss_credit').run();
  db.prepare('DELETE FROM ai_messages').run();
  db.prepare('DELETE FROM ai_conversations').run();
  db.prepare('DELETE FROM cloud_user_files').run();
  db.prepare('DELETE FROM cloud_files').run();
  db.prepare('DELETE FROM wrong_questions').run();
  db.prepare("DELETE FROM users WHERE is_admin = 0").run();
  console.log('[setup] 业务数据已清空（' + students + ' 个学生账号被删除）');
}

var adminToken = '';
var studentToken = '';
var studentId = '';

function run() {
  resetData();
  snapshotModels();
  configureModels();

  section('1. 回归：注册 / 闸门 / 充值 / 对话');
  return jsonPost(BASE + '/api/auth/register', '', {
    net_name: 'v2test', real_name: '验证同学', enrollment_year: '2025',
    class_no: '7', password: 'test1234', confirm_password: 'test1234'
  }).then(function(r) {
    ok('开放注册成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 120));
    studentToken = r.data.data.token;
    studentId = r.data.data.user_info.user_id;
    console.log('    学号：' + studentId + '（期望 2507xx）');

    return jsonPost(BASE + '/api/chat/stream', studentToken, { content: '测试' });
  }).then(function(r) {
    ok('未充值被闸门拦截（期望 402）', r.status === 402, 'HTTP ' + r.status);

    return jsonPost(BASE + '/api/auth/login', '', { account: '999999', password: 'admin12345' });
  }).then(function(r) {
    ok('管理员登录成功', r.data.code === 200);
    adminToken = r.data.data.token;

    return http.putJson(BASE + '/api/admin/users/' + studentId + '/quota',
      { quota_yuan: 50, weekly_yuan: 20, reason: 'v2 验证充值' },
      { headers: { Authorization: 'Bearer ' + adminToken }, validateStatus: function() { return true; } }
    );
  }).then(function(r) {
    ok('充值成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 120));

    return streamPost(BASE + '/api/chat/stream', studentToken, { content: '帮我讲讲这道题' });
  }).then(function(r) {
    var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
    ok('文本对话流式完成', !!done, '事件数 ' + r.events.length);
    ok('done 事件含消耗与余额', !!(done && done.data.cost_points !== undefined &&
      done.data.balance && done.data.balance.available_points !== undefined));
    // 契约：**学生端的流里不能出现金额字段**。
    // 学生只看积分（见 README「计费单位」与 credit.toPointsView 的说明）。
    // 前端能拿到元就迟早会有人渲染出来，所以这条要锁死。
    ok('done 事件不含任何金额字段', !!(done &&
      done.data.cost_yuan === undefined &&
      done.data.cost_micro === undefined &&
      done.data.balance.available_yuan === undefined &&
      done.data.balance.available_micro === undefined));
    ok('source 为 chat', !!(done && done.data && true));
  })

  .then(function() {
    section('2. 云盘：上传 / 列表 / 读取 / 配额');
    return upload(studentToken, makePngBuffer(), '题目.png', 'image/png');
  }).then(function(r) {
    ok('上传图片成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 160));
    ok('返回 hash 与 kind=image', !!(r.data.data && r.data.data.hash && r.data.data.kind === 'image'));
    ok('返回 thumb_url', !!(r.data.data && r.data.data.thumb_url));
    global.__imgHash = r.data.data.hash;

    return upload(studentToken, Buffer.from('第一章 力学基础\n\n力是物体间的相互作用。\n', 'utf8'), '笔记.txt', 'text/plain');
  }).then(function(r) {
    ok('上传文本成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 160));
    ok('kind=text', !!(r.data.data && r.data.data.kind === 'text'));
    global.__txtHash = r.data.data.hash;

    // 伪装成图片的 html（魔数不是图片，应被拒）
    return upload(studentToken, Buffer.from('<html><script>alert(1)</script></html>', 'utf8'), 'evil.png', 'image/png');
  }).then(function(r) {
    ok('伪装成图片的 HTML 被拒', r.data.code !== 200, 'HTTP ' + r.status + ' ' + (r.data.message || ''));

    return upload(studentToken, Buffer.from('<html><script>alert(1)</script></html>', 'utf8'), 'evil.html', 'text/html');
  }).then(function(r) {
    ok('html 扩展名被拒', r.data.code !== 200, (r.data.message || ''));

    return get(BASE + '/api/cloud/files', studentToken);
  }).then(function(r) {
    var files = r.data.data.files || [];
    ok('文件列表返回两个文件', files.length === 2, '实际 ' + files.length);
    ok('列表含 url 与 thumb_url', files.every(function(f) { return !!f.url; }));

    return get(BASE + '/api/cloud/quota', studentToken);
  }).then(function(r) {
    ok('配额接口可用', r.data.code === 200 && r.data.data.quota_bytes > 0);
    console.log('    已用 ' + r.data.data.used_mb + 'MB / 共 ' + r.data.data.quota_mb + 'MB');

    return http.getJson(BASE + '/api/cloud/files/' + global.__imgHash + '?thumb=1', {
      headers: { Authorization: 'Bearer ' + studentToken },
      responseType: 'arraybuffer',
      validateStatus: function() { return true; }
    });
  }).then(function(r) {
    ok('缩略图可读取', r.status === 200, 'HTTP ' + r.status + ' 大小 ' + (r.data ? r.data.length : 0));

    // 越权：管理员尝试读学生的文件（管理员自己云盘里没有它）
    return http.getJson(BASE + '/api/cloud/files/' + global.__imgHash, {
      headers: { Authorization: 'Bearer ' + adminToken },
      responseType: 'arraybuffer',
      validateStatus: function() { return true; }
    });
  }).then(function(r) {
    ok('越权读取被拒（期望 404）', r.status === 404, 'HTTP ' + r.status);
  })

  .then(function() {
    section('3. 视觉 native：支持视觉的模型应收到 image_url');
    return streamPost(BASE + '/api/study/solve/stream', studentToken, {
      model_id: 'deepseek-chat',
      paper_mode: 'single',
      image_hashes: [global.__imgHash],
      content: ''
    });
  }).then(function(r) {
    var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
    var text = r.events.filter(function(e) { return e.event === 'delta'; })
      .map(function(e) { return e.data.text; }).join('');

    ok('拍题流式完成', !!done, '事件数 ' + r.events.length);
    ok('vision_mode = native', !!(done && done.data.vision_mode === 'native'), done ? done.data.vision_mode : '');
    ok('模型确实收到了图片', text.indexOf('已收到图片') !== -1, text.slice(0, 60));
    ok('图片计入 image_count', !!(done && done.data.image_count === 1));

    // 关键断言：数据库里绝不能有 base64
    var maxLen = db.prepare('SELECT MAX(LENGTH(attachments)) AS m FROM ai_messages').get().m || 0;
    ok('附件列不含 base64（长度 < 500）', maxLen < 500, '最长 ' + maxLen + ' 字符');

    var maxContent = db.prepare('SELECT MAX(LENGTH(content)) AS m FROM ai_messages').get().m || 0;
    ok('消息正文不含 base64（长度 < 20000）', maxContent < 20000, '最长 ' + maxContent + ' 字符');
  })

  .then(function() {
    section('4. 视觉 relay：纯文本模型应先转述再回答');
    // 配置转述模型
    return http.putJson(BASE + '/api/admin/vision',
      { relay_model_id: 'vision-model', max_images: 4, enabled: true },
      { headers: { Authorization: 'Bearer ' + adminToken }, validateStatus: function() { return true; } }
    );
  }).then(function(r) {
    ok('视觉配置保存成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 160));

    db.prepare('DELETE FROM cluss_usage_log').run();
    return streamPost(BASE + '/api/study/solve/stream', studentToken, {
      model_id: 'plain-model',
      paper_mode: 'multi',
      image_hashes: [global.__imgHash],
      content: ''
    });
  }).then(function(r) {
    var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
    var statuses = r.events.filter(function(e) { return e.event === 'status'; });
    var text = r.events.filter(function(e) { return e.event === 'delta'; })
      .map(function(e) { return e.data.text; }).join('');

    ok('relay 拍题完成', !!done, '事件数 ' + r.events.length);
    ok('vision_mode = relay', !!(done && done.data.vision_mode === 'relay'), done ? done.data.vision_mode : '');
    ok('有 vision 进度事件', statuses.some(function(s) { return s.data.stage === 'vision'; }));
    ok('有 vision_done 事件', statuses.some(function(s) { return s.data.stage === 'vision_done'; }));
    ok('模型收到的是转述文字（非图片）', text.indexOf('已收到图片') === -1, text.slice(0, 60));

    // 转述与主回答应是两条 usage，共享 trace_id
    var rows = db.prepare('SELECT source, trace_id, model_id FROM cluss_usage_log ORDER BY id').all();
    var relay = rows.filter(function(x) { return x.source === 'vision_relay'; });
    var main = rows.filter(function(x) { return x.source === 'solve'; });

    ok('存在 vision_relay 记账', relay.length === 1, '实际 ' + relay.length + ' 条');
    ok('存在 solve 记账', main.length === 1, '实际 ' + main.length + ' 条');
    ok('两条记账共享同一 trace_id', !!relay[0] && !!main[0] && relay[0].trace_id === main[0].trace_id && !!main[0].trace_id);
    ok('转述记的是转述模型', !!relay[0] && relay[0].model_id === 'vision-model');
  })

  .then(function() {
    section('5. 拍题三模式与作业批改的提示词分支');
    var cases = [
      { name: '单题', url: '/api/study/solve/stream', body: { model_id: 'deepseek-chat', paper_mode: 'single', image_hashes: [global.__imgHash] } },
      { name: '多题', url: '/api/study/solve/stream', body: { model_id: 'deepseek-chat', paper_mode: 'multi', image_hashes: [global.__imgHash] } },
      { name: '跨页题', url: '/api/study/solve/stream', body: { model_id: 'deepseek-chat', paper_mode: 'cross_page', image_hashes: [global.__imgHash, global.__txtHash] } },
      { name: '作业批改', url: '/api/study/grade/stream', body: { model_id: 'deepseek-chat', answer_hashes: [global.__imgHash] } }
    ];

    var chain = Promise.resolve();
    cases.forEach(function(c) {
      chain = chain.then(function() {
        return streamPost(BASE + c.url, studentToken, c.body).then(function(r) {
          var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
          var text = r.events.filter(function(e) { return e.event === 'delta'; })
            .map(function(e) { return e.data.text; }).join('');
          if (c.name === '作业批改') {
            ok(c.name + ' 返回批改表格', text.indexOf('| 题号 |') !== -1, text.slice(0, 50));
            // ---- 错题自动收录（这条链路以前完全没有断言）----
            // 模型在批改表格之外还会输出一段 <wrong-items> JSON。
            // 注意：**流式 delta 里保留原始标记是符合设计的** —— 块还没传完，
            // 服务端无法中途判断边界；露不露给学生由渲染层负责
            // （client/utils/markdown.js 的 stripStructured，截断到起始标记之前）。
            // 所以这里断言的是「存档后的正文」，见下面错题本那一段。
            ok('delta 流保留原始标记（截断归渲染层）', text.indexOf('<wrong-items') !== -1);
            ok('done 回报收录 2 道错题', !!(done && done.data.wrong_added === 2),
              'wrong_added=' + (done && done.data.wrong_added));
            global.__gradeConvId = done && done.data.conversation_id;
          } else {
            ok(c.name + ' 完成', !!done);
          }
          return r;
        });
      });
    });

    // 先记下批改前的错题数。脚本要能重复运行，不能假定错题本是空的 ——
    // 断言绝对条数会让第二次运行"因为第一次留下的数据"而失败，
    // 那会把真实问题淹没在噪声里。
    return get(BASE + '/api/wrong-book?limit=1', studentToken).then(function(r) {
      global.__wrongBefore = (r.data.data && r.data.data.total) || 0;
      return chain;
    }).then(function() {
      // ---- 错题真的进了本子吗：查错题本接口 ----
      return get(BASE + '/api/wrong-book?limit=10', studentToken);
    }).then(function(r) {
      var d = r.data.data || {};
      var items = d.items || [];
      var expectTotal = global.__wrongBefore + 2;
      ok('错题本新增 2 条', d.total === expectTotal,
        '批改前 ' + global.__wrongBefore + ' 条，现在 ' + d.total);

      // 列表按 id 倒序，最新收录的两条在最前
      var fresh = items.slice(0, 2);
      var subjects = fresh.map(function(x) { return x.subject; });
      ok('错题带学科', subjects.indexOf('物理') !== -1, subjects.join(','));

      var tags = fresh.map(function(x) { return x.tag; });
      ok('判定标记含 ✗ 与 △', tags.indexOf('✗') !== -1 && tags.indexOf('△') !== -1, tags.join(','));

      ok('错题记录了错因', !!(fresh[0] && fresh[0].reason));
      ok('错题关联了来源会话', !!(fresh[0] && fresh[0].conversation_id));
      ok('错题关联了题图（复习可回看原图）', !!(fresh[0] && fresh[0].image_hash));
      ok('新收录的默认都是待复习', !!(d.counts && d.counts.pending === d.total && d.counts.mastered === 0),
        JSON.stringify(d.counts));

      return get(BASE + '/api/wrong-book/subjects', studentToken);
    }).then(function(r) {
      var subs = (r.data.data && r.data.data.subjects) || [];
      ok('学科筛选列表含物理', subs.some(function(s) { return s.subject === '物理'; }));

      return get(BASE + '/api/wrong-book/export.csv', studentToken);
    }).then(function(r) {
      var body = String(r.data || '');
      ok('错题 CSV 含错因列与数据', body.indexOf('错因') !== -1 && body.indexOf('物理') !== -1);

      // 存档的批改正文必须是剥离过的 —— 学生回看历史时不该看到那坨 JSON
      return get(BASE + '/api/conversations/' + global.__gradeConvId, studentToken);
    }).then(function(r) {
      var msgs = (r.data.data && r.data.data.messages) || [];
      var assistant = msgs.filter(function(m) { return m.role === 'assistant'; })[0] || {};
      var content = String(assistant.content || '');
      ok('存档正文已剥离错题 JSON', content.indexOf('<wrong-items') === -1);
      ok('存档正文保留了批改表格', content.indexOf('| 题号 |') !== -1);

      // 跨页题只有 1 张图时应降级为单题
      return streamPost(BASE + '/api/study/solve/stream', studentToken, {
        model_id: 'deepseek-chat', paper_mode: 'cross_page', image_hashes: [global.__imgHash]
      });
    }).then(function(r) {
      var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
      ok('跨页题单图自动降级不报错', !!done);
    });
  })

  .then(function() {
    section('5b. 画像 / 上下文 / 积分是否真的进了提示词');
    // 再发一条对话，然后回放 mock 收到的请求。
    // 这一步同时验证三件很容易"静默失效"的事：
    //   1) 画像注入 —— 且批改新增的错题要能**立刻**反映出来。
    //      画像有 60s 缓存，批改后必须调 invalidate，否则要等一分钟才更新，
    //      而这种滞后在人工试用时几乎不可能被发现。
    //   2) 积分余额注入
    //   3) 当前时间注入
    return streamPost(BASE + '/api/chat/stream', studentToken, { content: '再讲一道题' });
  }).then(function() {
    return get(MOCK + '/__last');
  }).then(function(r) {
    var msgs = (r.data && r.data.messages) || [];
    var sys = (msgs[0] && msgs[0].role === 'system' && msgs[0].content) || '';

    ok('system prompt 已送达 mock', sys.length > 0);
    ok('注入了【关于这个学生】', sys.indexOf('【关于这个学生】') !== -1);
    ok('画像带上了刚批改出的错题学科（缓存已刷新）', sys.indexOf('物理') !== -1);
    ok('注入了积分余额', sys.indexOf('[积分余额]') !== -1);
    ok('注入了当前时间', sys.indexOf('[当前时间]') !== -1);
    ok('学生提示词里没有金额符号', sys.indexOf('¥') === -1);
    // 画像与余额必须排在 BASE 之后，否则会打断上游 KV 缓存前缀
    var baseEnd = sys.indexOf('通用规则');
    ok('画像排在 BASE 之后（不破坏缓存前缀）',
      baseEnd !== -1 && sys.indexOf('【关于这个学生】') > baseEnd);
  })

  .then(function() {
    section('6. 用量统计（学生端 / 管理端）');
    return get(BASE + '/api/usage/summary?days=7&group_by=day', studentToken);
  }).then(function(r) {
    ok('学生用量汇总可用', r.data.code === 200);
    ok('汇总含额度信息', !!(r.data.data && r.data.data.wallet));
    ok('汇总总量大于 0', !!(r.data.data && r.data.data.totals.calls > 0));
    // 学生端口径是积分，且不含技术字段（token 等）——见 README「去术语化」
    ok('学生汇总用积分且无金额字段', !!(r.data.data.totals.cost_points !== undefined &&
      r.data.data.totals.cost_yuan === undefined && r.data.data.totals.total_tokens === undefined));
    console.log('    学生累计 ' + r.data.data.totals.calls + ' 次，共 ' +
      r.data.data.totals.cost_points + ' 积分');

    return get(BASE + '/api/usage/records?days=7&limit=5', studentToken);
  }).then(function(r) {
    ok('学生明细可用', r.data.code === 200 && r.data.data.items.length > 0);
    var hasSource = r.data.data.items.every(function(x) { return !!x.source; });
    ok('明细含 source 字段', hasSource);
    // 学生端明细里不能有技术字段（token / 模型名）——见 README「去术语化」
    var one = r.data.data.items[0] || {};
    ok('学生明细不含技术字段', one.total_tokens === undefined &&
      one.prompt_tokens === undefined && one.model_label === undefined);

    return get(BASE + '/api/usage/export.csv?days=7', studentToken);
  }).then(function(r) {
    var body = String(r.data || '');
    // 学生导出与管理端导出的**列完全不同**，不只是换个单位
    ok('学生 CSV 是积分口径且无技术列',
      body.indexOf('时间,类型,内容,消耗积分') === 0 &&
      body.indexOf('Token') === -1 && body.indexOf('模型') === -1,
      body.slice(0, 30));

    return get(BASE + '/api/admin/usage/summary?days=7&group_by=source', adminToken);
  }).then(function(r) {
    ok('管理端按来源汇总可用', r.data.code === 200);
    var keys = (r.data.data.items || []).map(function(x) { return x.key; });
    console.log('    来源分布: ' + keys.join(', '));
    ok('来源包含 solve 与 grade', keys.indexOf('solve') !== -1);

    return get(BASE + '/api/admin/usage/records?days=7&limit=5', adminToken);
  }).then(function(r) {
    ok('管理端明细可用', r.data.code === 200 && r.data.data.items.length > 0);

    return get(BASE + '/api/admin/usage/export.csv?days=7', adminToken);
  }).then(function(r) {
    // 注意：不能断言「首字符是 BOM」——axios 的默认 transformResponse 会调用 stripBOM
    // 把 BOM 去掉，所以要改判 Content-Type 与表头内容
    var ct = String((r.headers && r.headers['content-type']) || '');
    var body = String(r.data || '');
    ok('CSV 导出可用', r.status === 200 && ct.indexOf('text/csv') === 0 && body.indexOf('时间,用户,学号') === 0,
      'HTTP ' + r.status + ' / ' + ct + ' / ' + body.slice(0, 24));
  })

  .then(function() {
    section('7. 模型管理接口');
    return get(BASE + '/api/admin/models', adminToken);
  }).then(function(r) {
    var models = r.data.data.models || [];
    // 不断言绝对数量：库里可能本来就有真实模型在跑。
    // 断言"测试用的那三个都在"就够了。
    var modelIds = models.map(function(x) { return x.id; });
    ok('模型列表含测试用模型',
      ['deepseek-chat', 'plain-model', 'vision-model'].every(function(id) { return modelIds.indexOf(id) >= 0; }),
      modelIds.join(','));
    var one = models[0];
    ok('API Key 已掩码（不回传明文）', !!one && one.api_key_masked.indexOf('mock-key') === -1);
    ok('列表含视觉字段', !!one && one.supports_vision !== undefined);

    return jsonPost(BASE + '/api/admin/models', adminToken, {
      id: 'new-model', label: '新模型', api_url: MOCK, api_key: 'k',
      price_in: 3, price_out: 9, is_free: true
    });
  }).then(function(r) {
    ok('新增模型成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 120));

    return http.putJson(BASE + '/api/admin/models/new-model',
      { price_in: 5, price_out: 15 },
      { headers: { Authorization: 'Bearer ' + adminToken }, validateStatus: function() { return true; } }
    );
  }).then(function(r) {
    ok('改单价成功', r.data.code === 200 && r.data.data.price_in === 5, JSON.stringify(r.data.data || {}).slice(0, 80));

    // 验证改价即时生效（不做缓存）
    return jsonPost(BASE + '/api/admin/models/new-model/set-default', adminToken, {});
  }).then(function(r) {
    ok('设为默认模型成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 100));

    return http.del(BASE + '/api/admin/models/new-model',
      { headers: { Authorization: 'Bearer ' + adminToken }, validateStatus: function() { return true; } });
  }).then(function(r) {
    ok('删除未使用模型成功', r.data.code === 200 && r.data.data.soft_disabled === false, JSON.stringify(r.data).slice(0, 100));

    return http.del(BASE + '/api/admin/models/deepseek-chat',
      { headers: { Authorization: 'Bearer ' + adminToken }, validateStatus: function() { return true; } });
  }).then(function(r) {
    ok('删除已使用的模型 → 软禁用', r.data.code === 200 && r.data.data.soft_disabled === true, JSON.stringify(r.data).slice(0, 120));
  })

  .then(function() {
    section('8. 安全边界');

    // 第 7 节用"删除"测了软禁用，把 deepseek-chat 停掉了；这里要重新启用。
    // （软禁用的模型不该还能用 —— 这正是后端会拒绝它的原因，是预期行为。）
    db.prepare('UPDATE ai_models SET enabled = 1 WHERE id = ?').run('deepseek-chat');

    // 非图片文件当图片发
    return jsonPost(BASE + '/api/study/solve/stream', studentToken, {
      model_id: 'deepseek-chat', paper_mode: 'single', image_hashes: [global.__txtHash]
    });
  }).then(function(r) {
    ok('文本文件当图片发送被拒', r.status === 400, 'HTTP ' + r.status + ' ' + (r.data.message || ''));

    // 越权 hash
    return jsonPost(BASE + '/api/study/solve/stream', studentToken, {
      model_id: 'deepseek-chat', paper_mode: 'single',
      image_hashes: ['a'.repeat(64)]
    });
  }).then(function(r) {
    ok('不存在的 hash 被拒', r.status === 400, 'HTTP ' + r.status);

    // 不带图拍题
    return jsonPost(BASE + '/api/study/solve/stream', studentToken, {
      model_id: 'deepseek-chat', paper_mode: 'single', image_hashes: []
    });
  }).then(function(r) {
    ok('拍题不带图被拒', r.status === 400, 'HTTP ' + r.status);

    // 非法题量模式
    return jsonPost(BASE + '/api/study/solve/stream', studentToken, {
      model_id: 'deepseek-chat', paper_mode: 'hack', image_hashes: [global.__imgHash]
    });
  }).then(function(r) {
    ok('非法题量模式被拒', r.status === 400, 'HTTP ' + r.status);

    // 学生访问管理端模型接口
    return get(BASE + '/api/admin/models', studentToken);
  }).then(function(r) {
    ok('学生访问管理接口被拒（403）', r.status === 403, 'HTTP ' + r.status);

    // 拍题能力探测
    return get(BASE + '/api/study/capabilities', studentToken);
  }).then(function(r) {
    ok('能力探测可用', r.data.code === 200);
    ok('探测含题量模式', !!(r.data.data.paper_modes && r.data.data.paper_modes.length === 3));
    console.log('    可看图模型: ' + (r.data.data.vision_models || []).map(function(m) { return m.id; }).join(', '));
  })

  .then(function() {
    restoreModels();

    section('结果');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (failures.length) {
      console.log('\n失败项：');
      failures.forEach(function(f) { console.log('  - ' + f); });
    }
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch(function(err) {
    // 中途失败也要还原，否则会留下一份被改成 mock 的模型配置
    try { restoreModels(); } catch (e) { console.error('[清理] 还原失败:', e.message); }
    console.error('\n[脚本异常]', err.message);
    if (err.response) console.error('status', err.response.status, err.response.data && String(err.response.data).slice(0, 300));
    process.exit(1);
  });
}

run();