// 额度锁现状体检（只在本地库上读，不写）
const fs = require('fs');
const path = require('path');

var ROOT = path.join(__dirname, '..');
var SERVER = path.join(ROOT, 'server');

// 手工加载 server/.env（bash 的 `. server/.env` 会被中文注释里的冒号搞坏）
fs.readFileSync(path.join(SERVER, '.env'), 'utf8').split(/\r?\n/).forEach(function (line) {
  var m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
});
// 记忆第 6 条：DB_PATH 是相对路径，从项目根跑会新建空库 —— 这里钉死绝对路径
process.env.DB_PATH = path.join(SERVER, 'database', 'cluss.db');

const db = require(path.join(SERVER, 'src', 'utils', 'db'));
const sync = require(path.join(SERVER, 'src', 'services', 'sync'));

var cols = db.prepare('PRAGMA table_info(cluss_nodes)').all().map(function (c) { return c.name; });
console.log('cluss_nodes 列:', cols.join(','));
console.log('迁移版本:', JSON.stringify(db.prepare('SELECT version, name FROM schema_version ORDER BY version DESC LIMIT 1').get()));

// 注意：seat_instance / is_seat_admin 不在节点表里，是运行时算出来的（cluss_meta）
var rows = db.prepare(
  'SELECT instance_id, label, status, IFNULL(quota_lock,0) AS quota_lock, ' +
  'last_seen_at, node_version, last_model_version FROM cluss_nodes ORDER BY instance_id'
).all();
console.log('节点数=' + rows.length);
rows.forEach(function (n) { console.log('  ' + JSON.stringify(n)); });

console.log('isNodeQuotaLocked(class-18)=' + sync.isNodeQuotaLocked('class-18'));
console.log('isNodeQuotaLocked(class-08)=' + sync.isNodeQuotaLocked('class-08'));

// 节点侧持久化键
var metaKeys = db.prepare("SELECT key, value FROM cluss_meta WHERE key LIKE '%quota%'").all();
console.log('cluss_meta 里的额度键:', JSON.stringify(metaKeys));

// 8 班名单里的额度（看中枢账本）
var r = db.prepare('SELECT COUNT(*) AS c FROM sync_roster').get();
console.log('sync_roster 行数=' + r.c);
try {
  var top = db.prepare(
    'SELECT instance_id, user_id, real_name, allocated_micro, hub_quota_set FROM sync_roster ' +
    'ORDER BY CAST(allocated_micro AS REAL) DESC LIMIT 6'
  ).all();
  console.log('  额度最高的 6 个:');
  top.forEach(function (t) {
    console.log('    ' + t.instance_id + ' ' + t.user_id + ' ' + t.real_name +
      ' ¥' + (Number(t.allocated_micro || 0) / 1e6).toFixed(2) + ' hub_quota_set=' + t.hub_quota_set);
  });
  var s = db.prepare('SELECT instance_id, COUNT(*) AS c, SUM(CAST(allocated_micro AS REAL)) AS total FROM sync_roster GROUP BY instance_id').all();
  console.log('  按实例汇总: ' + JSON.stringify(s.map(function (x) {
    return { instance_id: x.instance_id, 人数: x.c, 总额: '¥' + (Number(x.total || 0) / 1e6).toFixed(2) };
  })));
  var over = db.prepare('SELECT user_id, real_name, allocated_micro, hub_quota_set, synced_at FROM sync_roster WHERE CAST(allocated_micro AS REAL) > 100000000').all();
  console.log('  超过 ¥100 的（疑似自充）: ' + over.length + ' 人');
  over.forEach(function (t) {
    console.log('    ' + t.user_id + ' ' + t.real_name + ' ¥' + (Number(t.allocated_micro) / 1e6).toFixed(2) +
      ' hub_quota_set=' + t.hub_quota_set + ' synced_at=' + t.synced_at);
  });
} catch (e) {
  console.log('  sync_roster 取额度失败: ' + e.message);
}
