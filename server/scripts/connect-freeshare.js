// 把 freeshare.cc.cd 接入 Cluss
//
// 用法：
//   cd server
//   node scripts/connect-freeshare.js                      # 先探测视觉，再写库
//   node scripts/connect-freeshare.js --vision=on|off|auto  # 强制或跳过探测
//   node scripts/connect-freeshare.js --key=sk-xxx          # 覆盖 API Key
//
// 与 connect-web2api.js 的区别（为什么值得单独一个脚本）：
//   那两个「网页反代」是把 DeepSeek 官网包成 OpenAI 接口，
//   而这个是**真正的 API 聚合服务**，差别是实质性的：
//     · 原生支持图片输入 —— 拍题与批改终于可以走原始链路，不再依赖「转述模型」
//     · 流式末尾会回 usage（含缓存明细）—— Cluss 能精确计费
//     · 不绑定个人网页会话，不存在「token 几小时过期」那类问题
//
// 仍沿用同一条纪律：**视觉能力靠实测，不靠文档**。
// 用一张带随机四位的图去问，答对才算数（见 scripts/probe-vision.js）。

require('dotenv').config();

var path = require('path');
var childProcess = require('child_process');
var db = require('../src/utils/db');
var time = require('../src/utils/time');

var args = process.argv.slice(2);
function flagOf(name) {
  var hit = args.filter(function(a) { return a.indexOf('--' + name + '=') === 0; })[0];
  return hit ? hit.split('=')[1] : null;
}

var BASE_URL = String(flagOf('url') || process.env.FREESHARE_BASE || 'https://freeshare.cc.cd/v1').replace(/\/+$/, '');
var API_KEY = String(flagOf('key') || process.env.FREESHARE_KEY || '');
var VISION_MODE = String(flagOf('vision') || 'auto').toLowerCase();

if (!API_KEY) {
  console.error('\n缺少 API Key。用法：node scripts/connect-freeshare.js --key=sk-xxx\n');
  process.exit(1);
}

// 定价：这个上游的 usage 里带真实 cost，但 Cluss 按自己的单价表算账，
// 所以这里给一个保守的默认值（微元/千 token），管理员可在管理台改。
// 2000/8000 = 2 元 / 8 元 每百万 token，与 DeepSeek 官网定价同量级。
var PRICE_IN = 2000;
var PRICE_OUT = 8000;
var PRICE_CACHE_HIT = 400;

// label 是**学生看得到的**：不写型号名，用人话描述用途。
//
// 两个模型是刻意分工的，能力全部实测过，标签按实测结果写：
//
//   标准  deepseek-v4.1-flash —— 快，且**原生支持图片**。拍题/批改走它。
//   快速  glm-5.3-flash       —— 纯文字。带图请求会被上游**明确拒绝**（HTTP 400，
//                                "does not support image input"）。
//
// 为什么没把它标成「深度思考」：实测它**不输出 reasoning_content**
// （同一道题 65 completion tokens，无思考内容），而 glm-5.2 是有的
// （143 tokens + 220 字思考）。标签是学生看的，名不副实比没选项更糟。
//
// 顺带：前端模型选择器只在「可选模型 > 1」时出现，所以加第二个也把选择器带出来了。
var MODELS = [
  { id: 'ds-v41', label: '标准', model_name: 'deepseek-v4.1-flash', sort_order: 10 },
  { id: 'glm53f', label: '快速', model_name: 'glm-5.3-flash', sort_order: 11 }
];

// 视觉接力模型：给「不支持图片」的模型兜底。
// 配了它，学生在深度思考下也能拍题 —— 先由能看到图的模型把题面转成文字，
// 再交给主模型解。代价是两次调用、更慢也更贵，所以只是兜底，不是默认路径。
var RELAY_MODEL_ID = 'ds-v41';

// web2api 那两个模型依赖的网页会话已失效（且该账号已被风控介入），
// 留着显示"不可用"只会让学生困惑 —— 停用，配置都还在，随时可再启用。
// 含 glm52：那是试配时短暂用过的模型，换掉后要停掉，否则它会以
// 「深度思考」的名字留在学生下拉里 —— 而它其实一次都没被真正验证过。
var STALE_IDS = ['ds-web', 'ds-web-think', 'glm52'];

function probeVision(modelName) {
  if (VISION_MODE === 'on') { console.log('\n按 --vision=on 强制打开视觉（跳过探测）\n'); return 1; }
  if (VISION_MODE === 'off') { console.log('\n按 --vision=off 强制关闭视觉（跳过探测）\n'); return 0; }

  console.log('\n先实测：它到底能不能看图（带随机数字的图，猜不中才算数）');
  var res = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, 'probe-vision.js'), BASE_URL, API_KEY, modelName],
    { encoding: 'utf8', env: Object.assign({}, process.env, { NODE_OPTIONS: '', PYTHONPATH: '' }) }
  );
  String(res.stdout || '').split('\n').forEach(function(line) {
    if (/★|模型回复/.test(line)) console.log('  ' + line.trim());
  });
  return res.status === 0 ? 1 : 0;
}

// 逐个模型探测：同一家服务的不同模型能力并不一致
// （实测 deepseek-v4.1-flash 能看图，glm-5.2 不能），
// 只探第一个就会给第二个模型写错能力标记 —— 那正是"拍题时灵时不灵"的来源。
function probeAll() {
  var out = {};
  for (var i = 0; i < MODELS.length; i++) {
    out[MODELS[i].id] = probeVision(MODELS[i].model_name);
  }
  return out;
}

var VISION_BY_ID = (VISION_MODE === 'auto') ? probeAll() : null;

console.log('\n接入 freeshare → ' + BASE_URL + '\n');

function upsert(m, vision) {
  var exists = db.prepare('SELECT id FROM ai_models WHERE id = ?').get(m.id);
  if (exists) {
    db.prepare([
      'UPDATE ai_models SET label = ?, api_url = ?, api_key = ?, model_name = ?,',
      "  api_style = 'openai', supports_stream = 1, supports_vision = ?,",
      '  price_in = ?, price_out = ?, price_cache_hit = ?, is_free = 0, enabled = 1, sort_order = ?',
      'WHERE id = ?'
    ].join('\n')).run(m.label, BASE_URL, API_KEY, m.model_name, vision,
      PRICE_IN, PRICE_OUT, PRICE_CACHE_HIT, m.sort_order, m.id);
    return 'updated';
  }
  db.prepare([
    'INSERT INTO ai_models (id, label, api_url, api_key, model_name, api_style,',
    '  supports_thinking, supports_stream, supports_vision, vision_max_images,',
    '  price_in, price_out, price_cache_hit, is_free, enabled, is_default, sort_order, created_at)',
    "VALUES (?, ?, ?, ?, ?, 'openai', 0, 1, ?, 0, ?, ?, ?, 0, 1, 0, ?, ?)"
  ].join('\n')).run(m.id, m.label, BASE_URL, API_KEY, m.model_name, vision,
    PRICE_IN, PRICE_OUT, PRICE_CACHE_HIT, m.sort_order, time.nowUtc());
  return 'created';
}

// 每个模型用各自探测出来的能力，不要用第一个的结果覆盖全部
function visionFor(id) {
  if (VISION_MODE === 'on') return 1;
  if (VISION_MODE === 'off') return 0;
  return VISION_BY_ID[id] ? 1 : 0;
}

var visionSummary = {};
for (var i = 0; i < MODELS.length; i++) {
  var m = MODELS[i];
  var v = visionFor(m.id);
  visionSummary[m.id] = v;
  console.log('  ' + upsert(m, v) + '  ' + m.id + '  (' + m.label + ' · ' + m.model_name +
    ')  视觉=' + (v ? '开' : '关'));
}

db.prepare('UPDATE ai_models SET is_default = 0').run();
db.prepare('UPDATE ai_models SET is_default = 1 WHERE id = ?').run(MODELS[0].id);
console.log('  默认模型 → ' + MODELS[0].id);

var off = 0;
for (var j = 0; j < STALE_IDS.length; j++) {
  off += db.prepare('UPDATE ai_models SET enabled = 0, is_default = 0 WHERE id = ? AND enabled = 1')
    .run(STALE_IDS[j]).changes;
}
console.log('  停用已失效的网页反代模型 ' + off + ' 个');

// 转述模型：给没有原生视觉的模型兜底，让它也能拍题。
// 只有当接力模型自己支持视觉时才配对，否则等于让瞎子带瞎子。
if (RELAY_MODEL_ID && visionSummary[RELAY_MODEL_ID] === 1) {
  db.prepare(
    "INSERT INTO cluss_meta (key, value) VALUES ('vision_relay_model_id', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(RELAY_MODEL_ID);
  console.log('  转述模型 → ' + RELAY_MODEL_ID + '（让没有原生视觉的模型也能拍题）');
} else if (RELAY_MODEL_ID) {
  console.log('  ！转述模型 ' + RELAY_MODEL_ID + ' 未通过视觉探测，不配对');
}

console.log('\n下一步：');
var noVision = MODELS.filter(function(m) { return visionSummary[m.id] !== 1; });
if (!noVision.length) {
  console.log('  · 所有模型都能原生看图 —— 拍题与批改直接把图片交给模型');
} else {
  console.log('  · 「' + noVision.map(function(m) { return m.label; }).join('、') +
    '」没有原生视觉，已靠转述模型兜底（多一次调用、更慢也更贵）');
  console.log('  · 拍题优先用「标准」：原生看图，一次调用就够');
}
console.log('  · 单价默认 2 元 / 8 元每百万 token，可在管理台调整');
console.log('');
