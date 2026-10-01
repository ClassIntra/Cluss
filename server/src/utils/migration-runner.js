// 迁移引擎：按版本顺序执行 migrations/ 下的迁移文件，记录到 schema_version 表
//
// 与 ClassIntra 的策略一致：
//   - 文件名排序即执行顺序，只执行 version > 当前版本的迁移
//   - 每个迁移在事务中执行，失败回滚并中止后续迁移
//   - 所有迁移必须幂等（IF NOT EXISTS / 先检查列再 ADD COLUMN）
// 这样重复启动、异常中断后重启都安全。

var db = require('./db');
var fs = require('fs');
var path = require('path');

var MIGRATIONS_DIR = path.join(__dirname, '../migrations');

function ensureSchemaVersionTable() {
  db.exec([
    'CREATE TABLE IF NOT EXISTS schema_version (',
    '  version INTEGER PRIMARY KEY,',
    '  name TEXT NOT NULL,',
    '  applied_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));
}

function getCurrentVersion() {
  ensureSchemaVersionTable();
  var row = db.prepare('SELECT MAX(version) AS max_version FROM schema_version').get();
  if (!row || row.max_version === null) return -1;
  return row.max_version;
}

function loadMigrations() {
  var list = [];
  if (!fs.existsSync(MIGRATIONS_DIR)) return list;
  var files = fs.readdirSync(MIGRATIONS_DIR).filter(function(f) { return f.endsWith('.js'); });
  files.sort();
  for (var i = 0; i < files.length; i++) {
    var filePath = path.join(MIGRATIONS_DIR, files[i]);
    var mod = require(filePath);
    if (!mod || typeof mod.up !== 'function' || typeof mod.version !== 'number') {
      console.warn('[migration] 跳过无效迁移文件:', files[i], '(缺少 version 或 up)');
      continue;
    }
    list.push({ version: mod.version, name: mod.name || files[i], up: mod.up, file: files[i] });
  }
  return list;
}

function runAll() {
  var current = getCurrentVersion();
  var migrations = loadMigrations();
  var applied = 0;

  for (var i = 0; i < migrations.length; i++) {
    var m = migrations[i];
    if (m.version <= current) continue;
    var tx = db.transaction(function() {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(m.version, m.name);
    });
    try {
      tx();
      applied++;
      console.log('[migration] 已应用 v' + m.version + ' ' + m.name);
    } catch (err) {
      console.error('[migration] v' + m.version + ' (' + m.file + ') 执行失败:', err.message);
      throw err;
    }
  }

  return { applied: applied, currentVersion: getCurrentVersion() };
}

module.exports = { runAll: runAll, getCurrentVersion: getCurrentVersion };