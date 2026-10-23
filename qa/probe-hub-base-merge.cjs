// 探针：迁移 034「字段级模型同步」端到端验证
//
// 目标（用户 2026-10-22 的原话：「单价什么的也有同步，你就得做完善」）：
//   在「本班自选」档下，本班改过的字段保留本班的值，**没改过的字段（尤其单价、
//   倍率、Key）继续跟中枢更新走**。033 那版是整行冻结，本班只要动过任何一个字段，
//   中枢调价就永远下不来 —— 账和钱静默漂移。
//
// 跑法（必须系统 Node 24，better-sqlite3 的 ABI 才对）：
//   cd server && node ../qa/probe-hub-base-merge.cjs
//
// 数据安全：全程在**复制出来的库**上跑，绝不碰生产库。

var fs = require('fs');
var path = require('path');
var os = require('os');

var SRC_DB = path.resolve(__dirname, '../server/database/cluss.db');
var TMP_DIR = path.resolve(__dirname, '../.tmp-qa');
var TMP_DB = path.join(TMP_DIR, 'probe-034-' + process.pid + '.db');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
fs.copyFileSync(SRC_DB, TMP_DB);

process.env.DB_PATH = TMP_DB;
process.env.CLUSS_MODE = 'node';       // 只有 node 模式才有「下发端」语义
process.env.CLUSS_RELAY_URL = '';      // 不真的联网络
process.env.CLUSS_SHARED_SECRET = '';

// 其余配置（JWT_SECRET 等）从 server/.env 补齐。dotenv 默认**不覆盖**已存在的
// 环境变量，所以上面钉死的 DB_PATH / CLUSS_MODE 不会被它改回去。
require('../server/node_modules/dotenv').config({ path: path.resolve(__dirname, '../server/.env') });
process.env.DB_PATH = TMP_DB;
process.env.CLUSS_MODE = 'node';

var db = require('../server/src/utils/db');
var initDb = require('../server/src/utils/init-db');
initDb.initDatabase();

var mc = require('../server/src/services/model-config');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ('  → ' + JSON.stringify(extra)))); }
}
function q(sql, a) { return db.prepare(sql).get(a); }

// ---- 从干净状态开始（探针库，随便清）----
db.exec('DELETE FROM ai_models');
db.exec('DELETE FROM ai_sources');

function snapModels(list) {
  return list.map(function(m) {
    return {
      id: m.id, label: m.label || m.id, api_url: m.api_url || 'https://hub.example/v1',
      api_key: m.api_key || 'sk-hub', model_name: m.model_name || m.id, api_style: 'openai',
      supports_thinking: 0, supports_stream: 1, supports_vision: 0, vision_max_images: 0,
      price_in: m.price_in || 0, price_out: m.price_out || 0, price_cache_hit: m.price_cache_hit || 0,
      is_free: 0, enabled: 1, is_default: m.is_default ? 1 : 0, sort_order: m.sort_order || 0,
      created_at: '2026-10-01 00:00:00', price_multiplier_bp: m.mult || 10000, free_until: '',
      source_id: m.source_id || '', has_offpeak: 0, offpeak_peak_windows: '', offpeak_discount_bp: 0,
      sync_enabled: 1
    };
  });
}
function snapSources(list) {
  return list.map(function(s) {
    return {
      id: s.id, label: s.label || s.id, api_url: 'https://src.example/v1', api_key: 'sk-src',
      api_style: 'openai', enabled: 1, sort_order: 0, created_at: '2026-10-01 00:00:00', sync_enabled: 1
    };
  });
}
function apply(models, sources, meta) {
  return mc.applySnapshot({
    model_config_version: 1,
    models: snapModels(models),
    sources: snapSources(sources || []),
    meta: meta || {}
  }, { mode: 'merge' });
}

// ============================================================
console.log('\n[1] 首次下发（replace）：落地为「跟随中枢」');
// ============================================================
mc.applySnapshot({
  model_config_version: 1,
  models: snapModels([
    { id: 'mA', label: '甲', price_in: 1000, price_out: 2000, is_default: true },
    { id: 'mB', label: '乙', price_in: 500, price_out: 1000 }
  ]),
  sources: snapSources([{ id: 'sA', label: '源A' }]),
  meta: { offpeak_enabled: '1', offpeak_discount_bp: '5000' }
}, { mode: 'replace' });

var A = q('SELECT * FROM ai_models WHERE id = ?', 'mA');
ok('A 落地', !!A);
ok('单价落地', A.price_in === 1000 && A.price_out === 2000, A && [A.price_in, A.price_out]);
ok('origin = hub', A.origin === 'hub', A && A.origin);
ok('hub_base 已记录', !!A.hub_base && JSON.parse(A.hub_base).price_in === 1000);
ok('meta 落地', initDb.getMeta('offpeak_discount_bp') === '5000');

// ============================================================
console.log('\n[2] 本班改了显示名（模拟管理员在 8 班改一条）');
// ============================================================
db.prepare("UPDATE ai_models SET label = ?, origin = 'local' WHERE id = ?").run('甲（本班改名）', 'mA');

var d1 = mc.diffAgainstHub(q('SELECT * FROM ai_models WHERE id = ?', 'mA'), 'ai_models');
ok('偏离字段只有 label', d1.fields.length === 1 && d1.fields[0] === 'label', d1.fields);

// ============================================================
console.log('\n[3] 中枢调单价 → 本班必须收到（这是 033 的老毛病）');
// ============================================================
var r3 = apply([
  { id: 'mA', label: '甲', price_in: 500, price_out: 900, is_default: true },
  { id: 'mB', label: '乙', price_in: 300, price_out: 600 }
], [{ id: 'sA', label: '源A' }]);

var A3 = q('SELECT * FROM ai_models WHERE id = ?', 'mA');
ok('输入单价跟到中枢新值 500', A3.price_in === 500, A3.price_in);
ok('输出单价跟到中枢新值 900', A3.price_out === 900, A3.price_out);
ok('本班改过的显示名保留', A3.label === '甲（本班改名）', A3.label);
ok('origin 仍为 local（有本班字段）', A3.origin === 'local', A3.origin);
ok('未改动的 B 完全跟随', q('SELECT * FROM ai_models WHERE id = ?', 'mB').price_in === 300);

// ============================================================
console.log('\n[4] 本班没动过的字段继续收敛：改回原名后应恢复跟随');
// ============================================================
db.prepare('UPDATE ai_models SET label = ? WHERE id = ?').run('甲', 'mA');
apply([{ id: 'mA', label: '甲', price_in: 500, price_out: 900, is_default: true }], [{ id: 'sA', label: '源A' }]);
var A4 = q('SELECT * FROM ai_models WHERE id = ?', 'mA');
ok('偏离清零 → origin 回到 hub', A4.origin === 'hub', A4.origin);
ok('diff 为空', mc.diffAgainstHub(A4, 'ai_models').fields.length === 0);

// ============================================================
console.log('\n[5] 中枢新增 / 删除条目');
// ============================================================
apply([
  { id: 'mA', label: '甲', price_in: 500, price_out: 900, is_default: true },
  { id: 'mC', label: '丙', price_in: 700 }
], [{ id: 'sA', label: '源A' }]);
ok('新条目 C 自动加入', !!q('SELECT * FROM ai_models WHERE id = ?', 'mC'));
ok('中枢删掉的 B 在本班消失', !q('SELECT * FROM ai_models WHERE id = ?', 'mB'));

// 本班自建的条目不能因为「中枢没有同 id」被删掉
db.prepare([
  'INSERT INTO ai_models (id, label, api_url, api_key, model_name, api_style, price_in, price_out,',
  '  price_cache_hit, enabled, is_default, sort_order, origin, hub_base)',
  "VALUES ('mLocal', '本班自建', 'https://mine/v1', 'sk-mine', 'mine', 'openai', 10, 20, 0, 1, 0, 9, 'local', '')"
].join('\n')).run();
apply([{ id: 'mA', label: '甲', price_in: 500, price_out: 900, is_default: true }], [{ id: 'sA', label: '源A' }]);
ok('本班自建条目保留', !!q('SELECT * FROM ai_models WHERE id = ?', 'mLocal'));

// ============================================================
console.log('\n[6] 「恢复跟随中枢」：整行回到中枢版本');
// ============================================================
db.prepare("UPDATE ai_models SET label = '又被本班改了', price_in = 9999, origin = 'local' WHERE id = 'mA'").run();
var fr = mc.markFollowHub('ai_models', 'mA');
ok('markFollowHub 成功', fr.ok === true, fr);
apply([{ id: 'mA', label: '甲', price_in: 500, price_out: 900, is_default: true }], [{ id: 'sA', label: '源A' }]);
var A6 = q('SELECT * FROM ai_models WHERE id = ?', 'mA');
ok('显示名回到中枢值', A6.label === '甲', A6.label);
ok('单价回到中枢值（本班的 9999 被覆盖）', A6.price_in === 500, A6.price_in);
ok('origin 回到 hub', A6.origin === 'hub', A6.origin);

// ============================================================
console.log('\n[7] 全局峰谷（meta）：本班改过的保持，没改过的跟随');
// ============================================================
initDb.setMeta('offpeak_discount_bp', '8000');      // 本班把折扣改成 8 折
apply([{ id: 'mA', label: '甲', price_in: 500, price_out: 900, is_default: true }],
  [{ id: 'sA', label: '源A' }], { offpeak_enabled: '1', offpeak_discount_bp: '6000' });
ok('本班改过的折扣保留 8000', initDb.getMeta('offpeak_discount_bp') === '8000', initDb.getMeta('offpeak_discount_bp'));
ok('没改过的开关跟随中枢', initDb.getMeta('offpeak_enabled') === '1');

apply([{ id: 'mA', label: '甲', price_in: 500, price_out: 900, is_default: true }],
  [{ id: 'sA', label: '源A' }], { offpeak_enabled: '0', offpeak_discount_bp: '6000' });
ok('继续下发也改不动本班那一项', initDb.getMeta('offpeak_discount_bp') === '8000');
ok('开关跟到中枢的 0', initDb.getMeta('offpeak_enabled') === '0', initDb.getMeta('offpeak_enabled'));

// ============================================================
console.log('\n[8] 模型源也走同一套');
// ============================================================
db.prepare("UPDATE ai_sources SET api_key = 'sk-8ban', origin = 'local' WHERE id = 'sA'").run();
// 中枢只发源会被空快照护栏拦下（这是对的），所以这里照常带一个模型
apply([{ id: 'mA', label: '甲', price_in: 500, price_out: 900, is_default: true }],
  [{ id: 'sA', label: '源A' }]);
var S = q('SELECT * FROM ai_sources WHERE id = ?', 'sA');
ok('源的本班 Key 保留', S.api_key === 'sk-8ban', S.api_key);
ok('源的其余字段跟随中枢', S.api_url === 'https://src.example/v1', S.api_url);
var ds = mc.diffAgainstHub(S, 'ai_sources');
ok('源偏离字段只有 api_key', ds.fields.length === 1 && ds.fields[0] === 'api_key', ds.fields);

// ============================================================
console.log('\n[9] 快照出站不夹带本机状态（origin / hub_base）');
// ============================================================
var snap = mc.snapshot({ scope: 'all' });
var leak = snap.models.filter(function(m) { return m.origin !== undefined || m.hub_base !== undefined; });
ok('模型出站无 origin / hub_base', leak.length === 0, leak[0]);
var leakS = snap.sources.filter(function(s) { return s.origin !== undefined || s.hub_base !== undefined; });
ok('源出站无 origin / hub_base', leakS.length === 0);

// ============================================================
console.log('\n[10] 幂等：同一份快照连跑 3 次结果一致');
// ============================================================
var before = JSON.stringify(db.prepare('SELECT id, label, price_in, price_out, origin, hub_base FROM ai_models ORDER BY id').all());
for (var i = 0; i < 3; i++) {
  apply([{ id: 'mA', label: '甲', price_in: 500, price_out: 900, is_default: true }], [{ id: 'sA', label: '源A' }]);
}
var after = JSON.stringify(db.prepare('SELECT id, label, price_in, price_out, origin, hub_base FROM ai_models ORDER BY id').all());
ok('三次合并后状态不变（幂等）', before === after);

console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
try { fs.unlinkSync(TMP_DB); } catch (e) { /* WAL 文件可能还在，无所谓 */ }
try { fs.unlinkSync(TMP_DB + '-wal'); } catch (e) { }
try { fs.unlinkSync(TMP_DB + '-shm'); } catch (e) { }
process.exit(fail ? 1 : 0);
