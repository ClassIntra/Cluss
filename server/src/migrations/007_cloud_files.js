// 迁移 007：云盘表结构
//
// 内容寻址模型（两表）：
//   cloud_files      —— 物理文件，hash 为主键，全局唯一（同一张图只存一份）
//   cloud_user_files —— 用户归属引用（谁把这个文件放进了自己的云盘）
//
// 为什么用两表而不是一张带 user_id 的表：
//   同一张题图被多个学生上传时，物理只存一份（省磁盘），
//   但每个学生都要能在自己的云盘里看到它 —— 这正是「引用」与「实体」分离的场景。
//
// ⚠️ 本项目 foreign_keys=ON：
//   - 插 cloud_user_files 之前 cloud_files 行必须已存在
//   - 删除顺序必须是「先删引用 → 引用归零才软删文件」
//   - 永不 DELETE FROM cloud_files（物理文件保留，避免影响其他引用者）
//
// 保留 width/height 而不存缩略图字段：缩略图是磁盘派生物，删了能按需重生成；
// 而宽高是文件本身的属性，前端列表靠它占位，避免图片加载前的布局抖动。

function up(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS cloud_files (',
    '  hash TEXT PRIMARY KEY,',
    '  owner_user_id TEXT NOT NULL,',
    '  original_name TEXT DEFAULT \'\',',
    '  size INTEGER NOT NULL DEFAULT 0,',
    '  mime_type TEXT DEFAULT \'\',',
    '  storage_path TEXT DEFAULT \'\',',
    '  width INTEGER DEFAULT 0,',
    '  height INTEGER DEFAULT 0,',
    // image | text
    '  kind TEXT DEFAULT \'image\',',
    '  deleted INTEGER DEFAULT 0,',
    '  created_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  db.exec([
    'CREATE TABLE IF NOT EXISTS cloud_user_files (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL,',
    '  file_hash TEXT NOT NULL,',
    '  display_name TEXT DEFAULT \'\',',
    '  uploaded_at TEXT DEFAULT (datetime(\'now\')),',
    '  UNIQUE(user_id, file_hash),',
    '  FOREIGN KEY(file_hash) REFERENCES cloud_files(hash)',
    ')'
  ].join('\n'));

  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_user ON cloud_user_files(user_id, uploaded_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_files_owner ON cloud_files(owner_user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_files_kind ON cloud_files(kind, deleted)');
}

module.exports = { version: 7, name: 'cloud_files', up: up };