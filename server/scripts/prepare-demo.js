// 准备前端验证环境：清空数据 + 配置模型 + 建一个已充值的测试学生 + 上传一张题图
//
// 用法：node scripts/prepare-demo.js
// 前置：mock 上游（node scripts/mock-ai-server.js）与 Cluss 服务端均已启动

require('dotenv').config();
var axios = require('axios');
var FormData = require('form-data');
var db = require('../src/utils/db');

var BASE = 'http://127.0.0.1:' + (process.env.PORT || 9101);
var MOCK = 'http://127.0.0.1:9200';

function makePngBuffer() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  );
}

// 造一张更像「题目照片」的图：用 sharp 生成一张带文字的图，便于人眼确认缩略图
function makeQuestionImage() {
  var sharp = null;
  try { sharp = require('sharp'); } catch (e) { return Promise.resolve(makePngBuffer()); }

  var svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">',
    '<rect width="600" height="800" fill="#ffffff"/>',
    '<text x="40" y="70" font-size="26" font-family="sans-serif" fill="#111">3. 已知函数 f(x)=x²-2ax+3，</text>',
    '<text x="40" y="110" font-size="26" font-family="sans-serif" fill="#111">求其在区间 [0,2] 上的最小值。</text>',
    '<text x="40" y="180" font-size="22" font-family="sans-serif" fill="#444">（本图为演示用题图）</text>',
    '</svg>'
  ].join('');

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function login(account, password) {
  return axios.post(BASE + '/api/auth/login', { account: account, password: password })
    .then(function(r) {
      if (r.data.code !== 200) throw new Error(r.data.message);
      return r.data.data.token;
    });
}

function reset() {
  ['cluss_usage_log', 'cluss_credit_log', 'cluss_credit', 'ai_messages', 'ai_conversations',
   'wrong_questions', 'writing_pieces']
    .forEach(function(t) { db.prepare('DELETE FROM ' + t).run(); });
  db.prepare('DELETE FROM cloud_user_files').run();
  db.prepare('DELETE FROM cloud_files').run();
  db.prepare('DELETE FROM users WHERE is_admin = 0').run();
  db.prepare("UPDATE cluss_meta SET value = '0' WHERE key = 'assign_version'").run();
  console.log('[prepare] 数据已清空');
}

function configureModels() {
  var stmt = db.prepare([
    'INSERT INTO ai_models (id, label, api_url, api_key, model_name, api_style, supports_stream,',
    '  supports_vision, price_in, price_out, price_cache_hit, is_free, enabled, is_default, sort_order)',
    'VALUES (?, ?, ?, ?, ?, \'openai\', 1, ?, ?, ?, ?, ?, 1, ?, ?)',
    'ON CONFLICT(id) DO UPDATE SET label = excluded.label, api_url = excluded.api_url,',
    '  api_key = excluded.api_key, supports_vision = excluded.supports_vision,',
    '  price_in = excluded.price_in, price_out = excluded.price_out, enabled = 1, is_default = excluded.is_default'
  ].join('\n'));

  stmt.run('deepseek-chat', 'DeepSeek Chat', MOCK, 'mock-key', 'deepseek-chat', 1, 2000, 8000, 200, 0, 1, 0);
  stmt.run('plain-model', '经济型模型', MOCK, 'mock-key', 'plain', 0, 2000, 8000, 200, 0, 0, 10);
  stmt.run('vision-model', '视觉模型', MOCK, 'mock-key', 'vision', 1, 2000, 8000, 200, 0, 0, 11);

  // 转述模型已配好，经济型模型也能拍题
  db.prepare("INSERT INTO cluss_meta (key, value) VALUES ('vision_relay_model_id', 'vision-model') ON CONFLICT(key) DO UPDATE SET value = 'vision-model'").run();
  db.prepare("INSERT INTO cluss_meta (key, value) VALUES ('vision_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();

  console.log('[prepare] 模型已配置：deepseek-chat（视觉/默认）、plain-model（纯文本）、vision-model（视觉/转述）');
}

function createStudent() {
  return axios.post(BASE + '/api/auth/register', {
    net_name: 'demo', real_name: '演示同学', enrollment_year: '2025',
    class_no: '3', password: 'test1234', confirm_password: 'test1234'
  }).then(function(r) {
    if (r.data.code !== 200) throw new Error(r.data.message);
    console.log('[prepare] 测试学生：' + r.data.data.user_info.user_id + ' / 密码 test1234');
    return r.data.data;
  });
}

function topup(userId, token) {
  return login('999999', 'admin12345').then(function(adminToken) {
    return axios.put(BASE + '/api/admin/users/' + userId + '/quota',
      { quota_yuan: 100, weekly_yuan: 50, reason: '演示充值' },
      { headers: { Authorization: 'Bearer ' + adminToken } }
    );
  }).then(function(r) {
    if (r.data.code !== 200) throw new Error(r.data.message);
    console.log('[prepare] 已充值 ¥100（周限额 ¥50）');
  });
}

function uploadImage(student) {
  return makeQuestionImage().then(function(buf) {
    var form = new FormData();
    form.append('file', buf, { filename: '数学题.png', contentType: 'image/png' });
    return axios.post(BASE + '/api/cloud/upload', form, {
      headers: Object.assign({ Authorization: 'Bearer ' + student.token }, form.getHeaders()),
      maxBodyLength: Infinity
    });
  }).then(function(r) {
    if (r.data.code !== 200) throw new Error(r.data.message);
    console.log('[prepare] 已上传演示题图（' + r.data.data.size + ' 字节）');
  });
}

reset();
configureModels();

createStudent().then(function(student) {
  return topup(student.user_info.user_id, student.token).then(function() {
    return uploadImage(student);
  });
}).then(function() {
  console.log('\n[prepare] 环境就绪');
  console.log('  学生账号：250301 / test1234');
  console.log('  管理员：  999999 / admin12345');
  console.log('  访问地址：' + BASE);
  process.exit(0);
}).catch(function(err) {
  console.error('[prepare] 失败:', err.message);
  if (err.response) console.error(err.response.status, JSON.stringify(err.response.data).slice(0, 200));
  process.exit(1);
});