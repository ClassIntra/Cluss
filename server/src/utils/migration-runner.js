// 迁移引擎：按版本顺序执行 migrations/ 下的迁移，记录到 schema_version 表
//
// 与 ClassIntra 的策略一致：
//   - 迁移清单是显式的（migrations/index.js），只执行 version > 当前版本的迁移
//   - 每个迁移在事务中执行，失败回滚并中止后续迁移
//   - 所有迁移必须幂等（IF NOT EXISTS / 先检查列再 ADD COLUMN）
// 这样重复启动、异常中断后重启都安全。
//
// 迁移清单走**静态** require（migrations/index.js），不做目录扫描 + 动态加载：
// 动态 require 会执行"目录里任何 .js"，是一个可被利用的落地点。

var db = require('./db');

// 静态引入：路径是字面量，打包与审查都可靠
var MIGRATIONS = require('../migrations/index');

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

// 从显式清单里筛出合法迁移并按版本排序。
// 模块是仓库内静态引用的（见文件头的说明），这里只做形状校验
function loadMigrations() {
  var list = [];
  for (var i = 0; i < MIGRATIONS.length; i++) {
    var mod = MIGRATIONS[i];
    if (!mod || typeof mod.up !== 'function' || typeof mod.version !== 'number') {
      console.warn('[migration] 跳过无效迁移条目 #' + i + '（缺少 version 或 up）');
      continue;
    }
    list.push({ version: mod.version, name: mod.name || ('v' + mod.version), up: mod.up });
  }
  list.sort(function(a, b) { return a.version - b.version; });
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
      console.error('[migration] v' + m.version + ' (' + m.name + ') 执行失败:', err.message);
      throw err;
    }
  }

  return { applied: applied, currentVersion: getCurrentVersion() };
}

module.exports = { runAll: runAll, getCurrentVersion: getCurrentVersion };