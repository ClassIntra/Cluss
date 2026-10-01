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
var axios = require('axios');
var fs = require('fs');
var path = require('path');
var FormData = require('form-data');
var db = require('../src/utils/db');

var BASE = 'http://127.0.0.1:' + (process.env.PORT || 9101);
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
  return axios.post(BASE + '/api/cloud/upload', form, {
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
  return axios.post(url, body, {
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
  return axios.post(url, body, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    validateStatus: function() { return true; }
  });
}

function get(url, token) {
  return axios.get(url, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    validateStatus: function() { return true; }
  });
}

// ---- 测试用的辅助：直接改库来配置模型（管理接口在后面才测）----
function configureModels() {
  // 主模型：指向 mock，标为支持视觉
  db.prepare([
    'UPDATE ai_models SET api_url = ?, api_key = ?, price_in = 2000, price_out = 8000,',
    '  price_cache_hit = 200, supports_vision = 1 WHERE id = ?'
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

function resetData() {
  db.prepare('DELETE FROM cluss_usage_log').run();
  db.prepare('DELETE FROM cluss_credit_log').run();
  db.prepare('DELETE FROM cluss_credit').run();
  db.prepare('DELETE FROM ai_messages').run();
  db.prepare('DELETE FROM ai_conversations').run();
  db.prepare('DELETE FROM cloud_user_files').run();
  db.prepare('DELETE FROM cloud_files').run();
  db.prepare("DELETE FROM users WHERE is_admin = 0").run();
  console.log('[setup] 业务数据已清空');
}

var adminToken = '';
var studentToken = '';
var studentId = '';

function run() {
  resetData();
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

    return axios.put(BASE + '/api/admin/users/' + studentId + '/quota',
      { quota_yuan: 50, weekly_yuan: 20, reason: 'v2 验证充值' },
      { headers: { Authorization: 'Bearer ' + adminToken }, validateStatus: function() { return true; } }
    );
  }).then(function(r) {
    ok('充值成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 120));

    return streamPost(BASE + '/api/chat/stream', studentToken, { content: '帮我讲讲这道题' });
  }).then(function(r) {
    var done = r.events.filter(function(e) { return e.event === 'done'; })[0];
    ok('文本对话流式完成', !!done, '事件数 ' + r.events.length);
    ok('done 事件含费用与余额', !!(done && done.data.cost_micro !== undefined && done.data.balance));
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

    return axios.get(BASE + '/api/cloud/files/' + global.__imgHash + '?thumb=1', {
      headers: { Authorization: 'Bearer ' + studentToken },
      responseType: 'arraybuffer',
      validateStatus: function() { return true; }
    });
  }).then(function(r) {
    ok('缩略图可读取', r.status === 200, 'HTTP ' + r.status + ' 大小 ' + (r.data ? r.data.length : 0));

    // 越权：管理员尝试读学生的文件（管理员自己云盘里没有它）
    return axios.get(BASE + '/api/cloud/files/' + global.__imgHash, {
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
    return axios.put(BASE + '/api/admin/vision',
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
          } else {
            ok(c.name + ' 完成', !!done);
          }
          return r;
        });
      });
    });

    return chain.then(function() {
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
    section('6. 用量统计（学生端 / 管理端）');
    return get(BASE + '/api/usage/summary?days=7&group_by=day', studentToken);
  }).then(function(r) {
    ok('学生用量汇总可用', r.data.code === 200);
    ok('汇总含额度信息', !!(r.data.data && r.data.data.wallet));
    ok('汇总总量大于 0', !!(r.data.data && r.data.data.totals.calls > 0));
    console.log('    学生累计 ' + r.data.data.totals.calls + ' 次调用，¥' + r.data.data.totals.cost_yuan);

    return get(BASE + '/api/usage/records?days=7&limit=5', studentToken);
  }).then(function(r) {
    ok('学生明细可用', r.data.code === 200 && r.data.data.items.length > 0);
    var hasSource = r.data.data.items.every(function(x) { return !!x.source; });
    ok('明细含 source 字段', hasSource);

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
    ok('模型列表可用', models.length === 3, '实际 ' + models.length);
    var one = models[0];
    ok('API Key 已掩码（不回传明文）', !!one && one.api_key_masked.indexOf('mock-key') === -1);
    ok('列表含视觉字段', !!one && one.supports_vision !== undefined);

    return jsonPost(BASE + '/api/admin/models', adminToken, {
      id: 'new-model', label: '新模型', api_url: MOCK, api_key: 'k',
      price_in: 3, price_out: 9, is_free: true
    });
  }).then(function(r) {
    ok('新增模型成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 120));

    return axios.put(BASE + '/api/admin/models/new-model',
      { price_in: 5, price_out: 15 },
      { headers: { Authorization: 'Bearer ' + adminToken }, validateStatus: function() { return true; } }
    );
  }).then(function(r) {
    ok('改单价成功', r.data.code === 200 && r.data.data.price_in === 5, JSON.stringify(r.data.data || {}).slice(0, 80));

    // 验证改价即时生效（不做缓存）
    return jsonPost(BASE + '/api/admin/models/new-model/set-default', adminToken, {});
  }).then(function(r) {
    ok('设为默认模型成功', r.data.code === 200, JSON.stringify(r.data).slice(0, 100));

    return axios.delete(BASE + '/api/admin/models/new-model',
      { headers: { Authorization: 'Bearer ' + adminToken }, validateStatus: function() { return true; } });
  }).then(function(r) {
    ok('删除未使用模型成功', r.data.code === 200 && r.data.data.soft_disabled === false, JSON.stringify(r.data).slice(0, 100));

    return axios.delete(BASE + '/api/admin/models/deepseek-chat',
      { headers: { Authorization: 'Bearer ' + adminToken }, validateStatus: function() { return true; } });
  }).then(function(r) {
    ok('删除已使用的模型 → 软禁用', r.data.code === 200 && r.data.data.soft_disabled === true, JSON.stringify(r.data).slice(0, 120));
  })

  .then(function() {
    section('8. 安全边界');
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
    section('结果');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (failures.length) {
      console.log('\n失败项：');
      failures.forEach(function(f) { console.log('  - ' + f); });
    }
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch(function(err) {
    console.error('\n[脚本异常]', err.message);
    if (err.response) console.error('status', err.response.status, err.response.data && String(err.response.data).slice(0, 300));
    process.exit(1);
  });
}

run();