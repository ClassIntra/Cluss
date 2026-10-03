// 数据库在线备份
//
// 用法：
//   node scripts/backup.js                 # 备份到 <数据库目录>/backups/
//   node scripts/backup.js --out <目录>    # 指定输出目录
//   node scripts/backup.js --keep 14       # 保留最近 14 份（默认 7）
//
// 为什么用 better-sqlite3 的 backup API 而不是直接拷文件：
//   库开了 WAL，直接拷 cluss.db 会丢掉 -wal 里未合并的数据（README「踩过坑」段）；
//   backup API 走 SQLite 在线备份协议——不锁库、不中断业务，
//   产物是单个完整的 .db 文件，恢复时直接替换即可。

require('dotenv').config();

var fs = require('fs');
var path = require('path');
var config = require('../src/config');
var db = require('../src/utils/db');

function parseArgs() {
  var args = process.argv.slice(2);
  var out = { outDir: null, keep: 7 };
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--out') out.outDir = args[++i];
    else if (args[i] === '--keep') out.keep = Math.max(1, parseInt(args[++i], 10) || 7);
  }
  return out;
}

function pruneOld(dir, keep) {
  var files = fs.readdirSync(dir)
    .filter(function(f) { return /^cluss-backup-\d{8}-\d{6}\.db$/.test(f); })
    .sort()
    .reverse(); // 新的在前
  var removed = 0;
  for (var i = keep; i < files.length; i++) {
    fs.unlinkSync(path.join(dir, files[i]));
    removed++;
  }
  return removed;
}

var opts = parseArgs();
var outDir = path.resolve(opts.outDir || path.join(path.dirname(config.dbPath), 'backups'));
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
var dest = path.join(outDir, 'cluss-backup-' + stamp + '.db');

db.backup(dest).then(function() {
  var size = fs.statSync(dest).size;
  console.log('✓ 备份完成: ' + dest);
  console.log('  大小: ' + (size / 1024 / 1024).toFixed(2) + ' MB（单文件完整库，恢复时直接替换 cluss.db）');
  var removed = pruneOld(outDir, opts.keep);
  if (removed) console.log('  已清理旧备份 ' + removed + ' 份（保留最近 ' + opts.keep + ' 份）');
  process.exit(0);
}).catch(function(err) {
  console.error('✗ 备份失败:', err.message);
  process.exit(1);
});
