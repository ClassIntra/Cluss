// 模型 / 模型源「下发范围」验证（迁移 032）
//
// 背景：模型配置是整表替换下发 —— 中枢上有什么，节点上就有什么。为了让
// 「本机试用但先不给各班」成为可能，加了按条目的 sync_enabled 标记。
//
// 这个开关看着简单，错法的代价却很不对称：
//   · 该发没发 —— 班里学生看不到模型，管理员在管理台明明看到「已启用」；
//   · 源关了模型没关 —— 节点收到一个指向不存在源的模型，界面写「源已失效」，
//     而中枢上那个源好好的，提示与事实相反；
//   · 默认模型被关 —— 各班失去计费基准，所有「基准 × 倍率」静默失去参照。
//
// 所以把契约钉死在这里：
//   ① 默认全发（升级后行为不变，不能因为多了一列就把配置少发一半）
//   ② 关模型只影响它自己；全量快照（席位班/上行）不受影响
//   ③ 关源级联关掉它挂的模型
//   ④ 默认模型不能停发（400，库不动）
//   ⑤ 源上有默认模型时不能停发该源（400，库不动）
//   ⑥ 缺 sync_enabled 的老快照落地后按「发」处理，不能被静默关掉
//   ⑦ 带 sync_enabled=0 的快照往返后仍是 0
//   ⑧ 空快照护栏仍然生效（回归）
//
// 用法：node scripts/verify-model-sync-scope.cjs   （退出码 0 = 通过）
// 自给自足：临时库 + 跑全量迁移，不读写任何真实库。

var fs = require('fs');
var os = require('os');
var path = require('path');

var TMP_DB = path.join(os.tmpdir(), 'cluss-scope-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-dummy-secret-model-scope';

require('../src/utils/migration-runner').runAll();

var modelConfig = require('../src/services/model-config');
var db = require('../src/utils/db');

var pass = 0;
var fail = 0;

function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' — ' + e.message);
  }
}

function section(t) { console.log('\n' + t); }

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function eq(a, b, label) {
  if (a !== b) throw new Error((label || '') + ' 期望 ' + b + '，实际 ' + a);
}

function model(id, extra) {
  return Object.assign({
    id: id, label: id, model_name: id, api_style: 'openai', enabled: 1,
    api_url: 'http://127.0.0.1:1/v1', api_key: 'k-' + id,
    price_in: 1000, price_out: 2000, price_cache_hit: 100,
    is_free: 0, is_default: 0, sort_order: 0
  }, extra || {});
}

function source(id, extra) {
  return Object.assign({
    id: id, label: id, api_url: 'http://127.0.0.1:1/v1', api_key: 'k-' + id,
    api_style: 'openai', enabled: 1, sort_order: 0
  }, extra || {});
}

// 播种：A 源两个模型、B 源一个模型、一个自带连接信息的默认模型
function seed() {
  modelConfig.applySnapshot({
    models: [
      model('m-a1', { source_id: 'srcA' }),
      model('m-a2', { source_id: 'srcA' }),
      model('m-b1', { source_id: 'srcB' }),
      model('m-free', { is_default: 1 })
    ],
    sources: [source('srcA'), source('srcB')],
    meta: {}
  });
}

function ids(list) {
  return list.map(function(r) { return r.id; }).sort().join(',');
}

seed();

section('① 默认全部下发（升级后行为不变）');
ok('4 个模型 / 2 个源', function() {
  var c = modelConfig.syncScopeCounts();
  eq(c.models, 4, '模型数');
  eq(c.synced_models, 4, '下发模型数');
  eq(c.sources, 2, '源数');
  eq(c.synced_sources, 2, '下发源数');
});
ok('synced 快照与全量快照条目一致', function() {
  var all = modelConfig.snapshot();
  var synced = modelConfig.snapshot({ scope: 'synced' });
  eq(ids(synced.models), ids(all.models), '模型');
  eq(ids(synced.sources), ids(all.sources), '源');
});
ok('每一行都带着 sync_enabled = 1', function() {
  var synced = modelConfig.snapshot({ scope: 'synced' });
  synced.models.forEach(function(m) { eq(Number(m.sync_enabled), 1, m.id); });
  synced.sources.forEach(function(s) { eq(Number(s.sync_enabled), 1, s.id); });
});

section('② 关掉一个模型：只影响它自己');
ok('setModelSync 返回成功', function() {
  var r = modelConfig.setModelSync('m-b1', 0);
  assert(r.ok, r.message);
  eq(r.sync_enabled, 0);
});
ok('synced 快照少了 m-b1', function() {
  var synced = modelConfig.snapshot({ scope: 'synced' });
  eq(ids(synced.models), 'm-a1,m-a2,m-free');
});
ok('全量快照（席位班/上行）仍是 4 个', function() {
  eq(modelConfig.snapshot().models.length, 4);
});
ok('汇总口径与快照一致（3 / 4）', function() {
  var c = modelConfig.syncScopeCounts();
  eq(c.synced_models, 3);
  eq(c.models, 4);
});
ok('库里的值真的落了盘，不是只在内存', function() {
  var row = db.prepare("SELECT sync_enabled FROM ai_models WHERE id = 'm-b1'").get();
  eq(Number(row.sync_enabled), 0);
});

section('③ 关掉一个源：级联关掉它挂的模型');
ok('srcB 上没有默认模型，允许关闭', function() {
  var r = modelConfig.setSourceSync('srcB', 0);
  assert(r.ok, r.message);
  eq(r.affected_models, 1, '挂载模型数');
});
ok('srcB 不在 synced 源里', function() {
  var synced = modelConfig.snapshot({ scope: 'synced' });
  eq(ids(synced.sources), 'srcA');
});
ok('srcB 上的模型同样不发（即使它自己 sync_enabled = 1）', function() {
  var synced = modelConfig.snapshot({ scope: 'synced' });
  eq(ids(synced.models), 'm-a1,m-a2,m-free');
});
ok('全量快照里 srcB 与 m-b1 都还在（本机照常可用）', function() {
  var all = modelConfig.snapshot();
  eq(ids(all.sources), 'srcA,srcB');
  eq(ids(all.models), 'm-a1,m-a2,m-b1,m-free');
});

section('④ 默认模型不能停发');
ok('返回 400 与可执行的说明', function() {
  var r = modelConfig.setModelSync('m-free', 0);
  assert(!r.ok, '不该成功');
  eq(r.code, 400);
  assert(r.message.indexOf('默认模型') >= 0, '文案应点明原因');
});
ok('库里的默认模型仍是「下发」', function() {
  var row = db.prepare("SELECT sync_enabled FROM ai_models WHERE id = 'm-free'").get();
  eq(Number(row.sync_enabled), 1);
  eq(modelConfig.snapshot({ scope: 'synced' }).models.filter(function(m) {
    return m.id === 'm-free';
  }).length, 1);
});
ok('不存在的模型返回 404', function() {
  eq(modelConfig.setModelSync('nope', 0).code, 404);
});

section('⑤ 源上有默认模型时，不能停发该源');
ok('把 m-a1 设为默认（模拟换基准）', function() {
  db.prepare('UPDATE ai_models SET is_default = 0').run();
  db.prepare("UPDATE ai_models SET is_default = 1 WHERE id = 'm-a1'").run();
});
ok('关闭 srcA 被拒，且提示指向那个默认模型', function() {
  var r = modelConfig.setSourceSync('srcA', 0);
  assert(!r.ok, '不该成功');
  eq(r.code, 400);
  assert(r.message.indexOf('m-a1') >= 0, '文案应点名模型');
});
ok('srcA 仍然在下发', function() {
  var row = db.prepare("SELECT sync_enabled FROM ai_sources WHERE id = 'srcA'").get();
  eq(Number(row.sync_enabled), 1);
});
ok('不存在的源返回 404', function() {
  eq(modelConfig.setSourceSync('nope', 0).code, 404);
});

section('⑥ 缺 sync_enabled 的老快照：按「发」处理');
ok('落一份完全没有该字段的快照', function() {
  modelConfig.applySnapshot({
    models: [model('old-1'), model('old-2', { is_default: 1 })],
    sources: [source('old-src')],
    meta: {}
  });
});
ok('全部算作下发，没有被静默关掉', function() {
  var c = modelConfig.syncScopeCounts();
  eq(c.synced_models, 2, '下发模型数');
  eq(c.synced_sources, 1, '下发源数');
});

section('⑦ 带 sync_enabled = 0 的快照：往返后仍是 0');
ok('落地后再取快照，标记没丢', function() {
  modelConfig.applySnapshot({
    models: [
      model('k-1', { sync_enabled: 1, is_default: 1 }),
      model('k-2', { sync_enabled: 0 })
    ],
    sources: [source('k-src', { sync_enabled: 0 })],
    meta: {}
  });
  var synced = modelConfig.snapshot({ scope: 'synced' });
  eq(ids(synced.models), 'k-1');
  eq(synced.sources.length, 0);
  var all = modelConfig.snapshot();
  eq(ids(all.models), 'k-1,k-2');
  eq(ids(all.sources), 'k-src');
});

section('⑧ 空快照护栏仍然生效（回归）');
ok('本机有模型时，空快照被拒且库不动', function() {
  var before = modelConfig.syncScopeCounts();
  var threw = false;
  try {
    modelConfig.applySnapshot({ models: [], sources: [], meta: {} });
  } catch (e) {
    threw = true;
    eq(e.code, 'EMPTY_SNAPSHOT');
  }
  assert(threw, '应当抛 EMPTY_SNAPSHOT');
  var after = modelConfig.syncScopeCounts();
  eq(after.models, before.models, '模型数');
  eq(after.sources, before.sources, '源数');
});

function cleanup() {
  try { db.close(); } catch (e) { /* ignore */ }
  ['', '-wal', '-shm'].forEach(function(ext) {
    try { fs.unlinkSync(TMP_DB + ext); } catch (e) { /* ignore */ }
  });
}

cleanup();
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
if (fail) process.exit(1);
