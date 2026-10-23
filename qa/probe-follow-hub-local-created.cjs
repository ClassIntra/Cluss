/**
 * 探针：本班自建的模型/源，在「恢复跟随」之后会不会被下一次下发删掉。
 *
 * 怀疑点（读代码发现，未实测）：
 *   markFollowHub / follow-all 无条件把行标成 origin='hub', hub_base='{}'。
 *   而 applySnapshot(merge) 的第一件事就是
 *     DELETE FROM ai_models WHERE origin='hub' AND id NOT IN (中枢快照)
 *   —— 本班自建的行在快照里根本没有 id，于是被删。
 *
 * 后果很硬：8 班自己配的模型（有自己的 Key、自己的地址）会因为班管点一下
 * 「全部恢复跟随」而永久消失，且 UI 上本班自建行没有任何区别于中枢行的标记，
 * 管理员事前完全意识不到这个按钮会删东西。
 */
var fs = require('fs');
var path = require('path');

// 跑在什么库上很重要：这轮涉及「恢复跟随」会不会删行，必须在有完整 schema
// 的库上跑。做法与 probe-hub-base-merge 一致 —— 复制生产库再改，绝不碰真库。
var SRC_DB = path.resolve(__dirname, '../server/database/cluss.db');
var TMP_DIR = path.resolve(__dirname, '../.tmp-qa');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
var TMP_DB = path.join(TMP_DIR, 'probe-follow-' + process.pid + '.db');
fs.copyFileSync(SRC_DB, TMP_DB);

var SERVER_ROOT = path.resolve(__dirname, '..', 'server');

process.env.DB_PATH = TMP_DB;
process.env.CLUSS_MODE = 'node';       // 只有 node 模式才有「恢复跟随谁」的语义
process.env.CLUSS_RELAY_URL = '';      // 不真的联网络
process.env.CLUSS_SHARED_SECRET = '';
process.env.CLUSS_INSTANCE_ID = 'class-08';

// dotenv 默认不覆盖已存在的环境变量，上面钉死的那几个不会被它改回去。
require(path.join(SERVER_ROOT, 'node_modules/dotenv')).config({ path: path.join(SERVER_ROOT, '.env') });
process.env.DB_PATH = TMP_DB;
process.env.CLUSS_MODE = 'node';

var initDb = require(path.join(SERVER_ROOT, 'src/utils/init-db'));
initDb.initDatabase();
var modelConfig = require(path.join(SERVER_ROOT, 'src/services/model-config'));
var db = require(path.join(SERVER_ROOT, 'src/utils/db'));

// ---- 从干净状态开始（探针库，随便清）----
db.exec('DELETE FROM ai_models');
db.exec('DELETE FROM ai_sources');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

function countModel(id) {
  var r = db.prepare('SELECT COUNT(*) AS c FROM ai_models WHERE id = ?').get(id);
  return r ? r.c : 0;
}
// SELECT * 而不是指定几列：diffAgainstHub 要拿整行与 hub_base 逐字段比对，
// 只查 4 列会让其余列变成 undefined，于是「从未改动的字段」也被判成偏离
// （实测报过 model_name/price_in/price_out/enabled/sort_order 五项）。
function row(id) {
  return db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id);
}

// 中枢快照：只有 mA
function hubSnap() {
  return {
    models: [
      { id: 'mA', label: '甲', model_name: 'a-1', is_default: true, enabled: 1,
        sort_order: 1, sync_enabled: 1, price_in: 100, price_out: 300 }
    ],
    sources: [{ id: 'sA', label: '源A', enabled: 1, sort_order: 1, sync_enabled: 1 }],
    meta: {}
  };
}

console.log('\n=== 场景：本班自建模型 + 「全部恢复跟随」 ===\n');

modelConfig.applySnapshot(hubSnap(), { mode: 'merge' });

// 本班纯自建：类比 8 班自己加了一个私有模型。此时 hub_base 为空串（无基线）
db.prepare([
  "INSERT INTO ai_models (id, label, model_name, is_default, enabled, sort_order, sync_enabled,",
  " price_in, price_out, origin, hub_base) VALUES",
  " ('myown', '本班自建模型', 'my-1', 0, 1, 9, 1, 10, 20, 'local', '')"
].join(' ')).run();

ok('前置：本班自建已在库里', countModel('myown') === 1);
ok('前置：自建行没有中枢基线（hub_base 为空）', row('myown').hub_base === '');

ok('后置：follow-all 没有波及自建行（仍有改动可调）', row('myown').hub_base === '');

// 走正式 API 的挑选条件（修复后）
modelConfig.markFollowHub('ai_models', 'myown');
ok('【修复后】底层拒绝恢复本班自建的行', row('myown').hub_base === '', row('myown').hub_base);

var guarded = db.prepare(
  "UPDATE ai_models SET origin = 'hub', hub_base = '{}' WHERE " + modelConfig.HAS_HUB_BASE_SQL
).run();
ok('【修复后】follow-all 的挑选条件扫不到自建行', guarded.changes === 0, 'changes=' + guarded.changes);

// 下一轮下发（中枢快照里没有 myown）
modelConfig.applySnapshot(hubSnap(), { mode: 'merge' });

console.log('');
ok('【关键】本班自建模型没有被下一次下发删掉', countModel('myown') === 1,
  '结果：' + countModel('myown') + ' 条（0 = 已被静默删除）');

// ---- 单条 follow 的同一问题 ----
console.log('\n=== 场景：单条「恢复跟随」同一个坑 ===\n');

modelConfig.applySnapshot(hubSnap(), { mode: 'merge' });
db.prepare("DELETE FROM ai_models WHERE id = 'myown'").run();
db.prepare([
  "INSERT INTO ai_models (id, label, model_name, is_default, enabled, sort_order, sync_enabled,",
  " price_in, price_out, origin, hub_base) VALUES",
  " ('myown2', '本班自建2', 'my-2', 0, 1, 9, 1, 10, 20, 'local', '')"
].join(' ')).run();

modelConfig.markFollowHub('ai_models', 'myown2');
ok('【修复后】单条 follow 也拒绝了自建行', row('myown2').hub_base === '', row('myown2').hub_base);
modelConfig.applySnapshot(hubSnap(), { mode: 'merge' });

ok('【关键】单条 follow 后自建模型也没被删', countModel('myown2') === 1,
  '结果：' + countModel('myown2') + ' 条');

// ---- 正常路径不能被改坏：中枢下发的行仍然要能恢复 ----
console.log('\n=== 回归：中枢下发的行改过后，恢复跟随必须生效 ===\n');

modelConfig.applySnapshot(hubSnap(), { mode: 'merge' });
db.prepare("UPDATE ai_models SET label = '本班改名', price_in = 999 WHERE id = 'mA'").run();
modelConfig.applySnapshot(hubSnap(), { mode: 'merge' });
ok('本班改过的价格之所以保住，是因为动手改过', row('mA').price_in === 999, row('mA').price_in);

modelConfig.markFollowHub('ai_models', 'mA');
modelConfig.applySnapshot(hubSnap(), { mode: 'merge' });
ok('恢复跟随后，中枢的价格覆盖了本班的 999', row('mA').price_in === 100, row('mA').price_in);
ok('恢复跟随后，显示名也回到中枢版本', row('mA').label === '甲', row('mA').label);
ok('恢复跟随后没有偏离项了',
  modelConfig.diffAgainstHub(row('mA'), 'ai_models').fields.length === 0,
  JSON.stringify(modelConfig.diffAgainstHub(row('mA'), 'ai_models').fields));

console.log('\n=== ' + pass + '/' + (pass + fail) + ' 通过 ===\n');

try { fs.unlinkSync(TMP_DB); } catch (e) { /* ignore */ }
process.exit(fail ? 1 : 0);
