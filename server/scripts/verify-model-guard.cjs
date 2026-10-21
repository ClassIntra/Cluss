// 模型配置「空快照」护栏验证
//
// 背景（2026-10-21 生产事故）：一份 ai_models 为空的快照被 applySnapshot 落地，
// 整表替换把全校 3 个模型 + 2 个来源清成 0 条 —— 学生侧直接没有可用模型，
// 而且这条路径不留任何可读日志，只能靠翻库才知道发生过什么（10-12 已经同样丢过一次）。
//
// 这里把契约钉死：
//   ① 非空配置不许被空快照覆盖（抛 EMPTY_SNAPSHOT，且库必须原样不动）
//   ② 「模型漏传、源传了」这种半份快照同样算空 —— 不能因为 sources 非空就放行
//   ③ 确需清空时必须显式 allowEmpty=true（不是靠上游少传一个字段促成）
//   ④ 本机本来就是 0 条时，空快照无破坏性，不该误报
//
// 用法：node scripts/verify-model-guard.cjs   （退出码 0 = 通过）
// 自给自足：临时库 + 跑全量迁移，不读写任何真实库。

var fs = require('fs');
var os = require('os');
var path = require('path');

var TMP_DB = path.join(os.tmpdir(), 'cluss-guard-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-dummy-secret-model-guard';

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

function counts() {
  return {
    models: db.prepare('SELECT COUNT(*) AS c FROM ai_models').get().c,
    sources: db.prepare('SELECT COUNT(*) AS c FROM ai_sources').get().c
  };
}

function model(id, extra) {
  return Object.assign({ id: id, label: id, model_name: id, api_style: 'openai', enabled: 1 }, extra || {});
}

function source(id) {
  return { id: id, label: id, api_url: 'http://127.0.0.1:1/v1', api_key: 'k-' + id, api_style: 'openai', enabled: 1 };
}

function expectThrow(fn, code) {
  try {
    fn();
  } catch (e) {
    if (code && e.code !== code) throw new Error('抛出的错误码是 ' + e.code + '，期望 ' + code);
    return e;
  }
  throw new Error('没有抛错，护栏没生效');
}

console.log('模型配置空快照护栏\n');

console.log('【1】空库播种：本地 0 条时不该被拦');
ok('空库上写入 2 个模型 + 1 个源', function () {
  modelConfig.applySnapshot({
    models: [model('m-a', { is_default: 1 }), model('m-b')],
    sources: [source('s-1')]
  });
  var c = counts();
  if (c.models !== 2 || c.sources !== 1) throw new Error('落地结果不对 ' + JSON.stringify(c));
});

console.log('\n【2】空快照必须被拒绝（这次事故的形态）');
ok('models=[] 且本地有 2 条 → 抛 EMPTY_SNAPSHOT', function () {
  expectThrow(function () {
    modelConfig.applySnapshot({ models: [], sources: [] });
  }, 'EMPTY_SNAPSHOT');
});
ok('被拒之后库原样不动（2 个模型 + 1 个源都还在）', function () {
  var c = counts();
  if (c.models !== 2 || c.sources !== 1) throw new Error('库被改动了 ' + JSON.stringify(c));
});
ok('被拒之后默认模型仍然可用', function () {
  var r = db.prepare('SELECT id FROM ai_models WHERE is_default = 1').get();
  if (!r || r.id !== 'm-a') throw new Error('默认模型丢了');
});

console.log('\n【3】半份快照同样算空（模型漏传、只传了源）');
ok('models=[] 但 sources 有 1 条 → 仍然拒绝', function () {
  expectThrow(function () {
    modelConfig.applySnapshot({ models: [], sources: [source('s-9')] });
  }, 'EMPTY_SNAPSHOT');
});
ok('那次被拒也没写进 sources', function () {
  if (db.prepare('SELECT 1 AS x FROM ai_sources WHERE id = ?').get('s-9')) throw new Error('s-9 落库了');
});

console.log('\n【4】显式 allowEmpty 才允许清空');
ok('allowEmpty=true → 真的清空', function () {
  modelConfig.applySnapshot({ models: [], sources: [], allowEmpty: true });
  var c = counts();
  if (c.models !== 0 || c.sources !== 0) throw new Error('没清干净 ' + JSON.stringify(c));
});
ok('清空后本地就是 0 条，再次收到空快照也不该抛（无破坏性）', function () {
  modelConfig.applySnapshot({ models: [], sources: [] });
  if (counts().models !== 0) throw new Error('应为 0 条');
});

console.log('\n【5】正常整表替换：旧模型不许残留');
ok('写入 3 个模型后替换成 1 个', function () {
  modelConfig.applySnapshot({ models: [model('x1'), model('x2'), model('x3')], sources: [source('sx')] });
  modelConfig.applySnapshot({ models: [model('only-one')], sources: [source('sy')] });
  var c = counts();
  if (c.models !== 1) throw new Error('模型数应为 1，实际 ' + c.models);
  if (db.prepare('SELECT 1 AS x FROM ai_models WHERE id = ?').get('x1')) throw new Error('x1 残留');
  if (c.sources !== 1) throw new Error('源数应为 1，实际 ' + c.sources);
});

console.log('\n【6】版本号单调递增（节点据此判断要不要回拉）');
ok('bumpModelVersion 从 0 开始 +1', function () {
  var v0 = modelConfig.currentModelVersion();
  var v1 = modelConfig.bumpModelVersion();
  if (v1 !== v0 + 1) throw new Error('期望 ' + (v0 + 1) + '，实际 ' + v1);
  if (modelConfig.currentModelVersion() !== v1) throw new Error('落库的版本号不是 ' + v1);
});

db.close();
['', '-wal', '-shm'].forEach(function (suf) {
  try { fs.unlinkSync(TMP_DB + suf); } catch (e) { /* 不存在就算了 */ }
});

console.log('\n结果：%d 通过，%d 失败', pass, fail);
process.exit(fail === 0 ? 0 : 1);
