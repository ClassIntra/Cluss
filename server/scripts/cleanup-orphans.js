// 云盘孤儿文件清理
//
// 用法：
//   node scripts/cleanup-orphans.js            # 只报告（dry-run，不改任何文件）
//   node scripts/cleanup-orphans.js --delete   # 真正删除孤儿文件
//
// 背景（见 README「已知边界」）：云盘删除是软删，被删引用归零的文件其物理文件
// 会一直留在磁盘上；上传中断等异常也可能留下没有任何引用的文件。
// 磁盘会随拍题量增长，这个脚本负责找出"磁盘上有、数据库里没有任何引用"的文件。
//
// 判定口径：
//   shared/<h2>/<hash><ext>   —— 必须能对上 cloud_files.storage_path（含软删行），
//                                否则为孤儿
//   thumbs/<h2>/<hash>_w*.jpg —— 缩略图是可再生缓存，父 hash 无任何引用即为孤儿
// 空目录在删除后顺手清理。

require('dotenv').config();

var fs = require('fs');
var path = require('path');
var db = require('../src/utils/db');
var cloudStore = require('../src/services/cloud-store');

var DO_DELETE = process.argv.indexOf('--delete') >= 0;

// ---- 收集数据库里的引用 ----
// 库还没初始化（没跑过迁移）时直接退出：没有 cloud_files 表就无从判定"有引用"，
// 此时也不该动磁盘。先启动一次服务让迁移跑完，再回来清理。
var hasTable = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cloud_files'"
).get();
if (!hasTable) {
  console.error('✗ 数据库里没有 cloud_files 表（数据库尚未初始化）。');
  console.error('  先启动一次服务（node src/app.js）让迁移完成，再运行本脚本。');
  process.exit(1);
}

var referencedStorage = {};   // storage_path（相对路径）集合
var referencedHash = {};      // hash 集合（缩略图按 hash 前缀判定）
var rows = db.prepare('SELECT hash, storage_path FROM cloud_files').all();
for (var i = 0; i < rows.length; i++) {
  referencedStorage[rows[i].storage_path] = true;
  referencedHash[rows[i].hash] = true;
}

// ---- 遍历磁盘 ----
function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function(d) {
    var p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

var sharedRoot = cloudStore.sharedRoot();
var thumbRoot = cloudStore.thumbRoot();
var sharedFiles = walk(sharedRoot, []) || [];
var thumbFiles = walk(thumbRoot, []) || [];

// 相对路径统一用 posix 斜杠比对（storage_path 存的是相对路径）
function rel(p, root) {
  return path.relative(root, p).split(path.sep).join('/');
}

var orphans = [];
for (var s = 0; s < sharedFiles.length; s++) {
  if (!referencedStorage[rel(sharedFiles[s], sharedRoot)]) {
    orphans.push({ path: sharedFiles[s], root: sharedRoot, size: fs.statSync(sharedFiles[s]).size });
  }
}
for (var t = 0; t < thumbFiles.length; t++) {
  // <hash>_w<edge>.jpg → hash 部分 = 去掉 _w*.jpg
  var hashPart = path.basename(thumbFiles[t]).replace(/_w\d+\.jpg$/, '');
  if (!referencedHash[hashPart]) {
    orphans.push({ path: thumbFiles[t], root: thumbRoot, size: fs.statSync(thumbFiles[t]).size });
  }
}

// ---- 报告 / 删除 ----
var totalSize = 0;
for (var o = 0; o < orphans.length; o++) totalSize += orphans[o].size;
var mb = (totalSize / 1024 / 1024).toFixed(2);

if (!orphans.length) {
  console.log('✓ 没有孤儿文件（shared ' + sharedFiles.length + ' 个、thumbs ' + thumbFiles.length + ' 个全部有引用）');
  process.exit(0);
}

console.log('发现 ' + orphans.length + ' 个孤儿文件，共 ' + mb + ' MB：');
orphans.forEach(function(f) {
  console.log('  ' + (DO_DELETE ? '删除 ' : '孤儿 ') + rel(f.path, f.root));
});

if (!DO_DELETE) {
  console.log('\n（dry-run：未删除任何文件。确认无误后加 --delete 执行）');
  process.exit(0);
}

var freed = 0;
for (var d = 0; d < orphans.length; d++) {
  try {
    freed += orphans[d].size;
    fs.unlinkSync(orphans[d].path);
  } catch (e) {
    console.warn('  删除失败（跳过）: ' + orphans[d].path + ' — ' + e.message);
  }
}

// 顺手清掉空目录，避免 shared/<h2>/ 越积越多
[sharedRoot, thumbRoot].forEach(function(root) {
  if (!fs.existsSync(root)) return;
  fs.readdirSync(root, { withFileTypes: true }).forEach(function(d) {
    if (!d.isDirectory()) return;
    var sub = path.join(root, d.name);
    if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub);
  });
});

console.log('\n✓ 已删除 ' + orphans.length + ' 个文件，释放 ' + (freed / 1024 / 1024).toFixed(2) + ' MB');
