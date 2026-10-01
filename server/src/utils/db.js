// SQLite 连接：单例 + WAL 模式 + 并发友好参数
//
// 为什么是 WAL：班级节点可能出现「Cluss 与其它进程同读一库」的情况，
// WAL 允许读写并发，配合 busy_timeout 可避免瞬时 SQLITE_BUSY 直接报错。

var Database = require('better-sqlite3');
var path = require('path');
var fs = require('fs');
var config = require('../config');

var dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

var db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

module.exports = db;