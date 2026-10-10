// 迁移 018：云笔记文件夹与画板（对齐 ClassIntra 笔记能力）
//
// 做三件事：
//   1) cloud_notes.id 从 INTEGER 改为 TEXT —— 笔记现在由客户端生成 id
//      （如 'note_1698...'），「上传到云端」以上传方 id 为主键，
//      云端与本地的同 id 即视为同一篇（同步标记与画板回填都依赖它）。
//      旧数据是自增整数，原样转成文本（'1'、'2'...），引用不断。
//   2) cloud_notes 加 folder / canvas_data / visibility 三列：
//      folder      —— 所属文件夹（默认「默认」）
//      canvas_data —— 画板/批注涂鸦层数据（JSON 字符串，仅 draw 类型或批注过的笔记非空）
//      visibility  —— private | public（公开笔记全班可见）
//   3) 新建 cloud_note_folders（每用户文件夹清单）。
//
// SQLite 不能 ALTER 主键类型，只能重建表。cloud_notes 没有 incoming 外键
// （file_hash 指向 cloud_files 是逻辑约定，不是 FK），重建是安全的。
// 旧表列集即迁移 012 的九列，新列用字面量补齐，重启二次执行也幂等
// （重建后新表已带 TEXT 主键与新列，直接走 else 分支）。

var NEW_SCHEMA = [
  'CREATE TABLE cloud_notes (',
  '  id TEXT PRIMARY KEY,',
  '  user_id TEXT NOT NULL,',
  "  title TEXT DEFAULT '',",
  "  tags TEXT DEFAULT '',",
  '  is_pinned INTEGER DEFAULT 0,',
  '  file_hash TEXT NOT NULL,',
  "  type TEXT DEFAULT 'note',",
  "  folder TEXT DEFAULT '默认',",
  "  canvas_data TEXT DEFAULT '',",
  "  visibility TEXT DEFAULT 'private',",
  "  created_at TEXT DEFAULT (datetime('now')),",
  "  updated_at TEXT DEFAULT (datetime('now'))",
  ')'
].join('\n');

function up(db) {
  var hasTable = !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_notes'"
  ).get();
  var hasTextId = false;
  if (hasTable) {
    // 旧表 id 是 INTEGER；重建过的表（本迁移已应用过）id 已是 TEXT
    var idType = db.prepare(
      "SELECT type FROM pragma_table_info('cloud_notes') WHERE name = 'id'"
    ).get();
    hasTextId = !!(idType && String(idType.type).toUpperCase() === 'TEXT');
  }

  if (hasTable && !hasTextId) {
    db.exec('ALTER TABLE cloud_notes RENAME TO cloud_notes_old_m018');
    db.exec(NEW_SCHEMA);
    // 旧表没有 folder/canvas_data/visibility 三列，用字面量补齐默认值
    db.exec([
      'INSERT INTO cloud_notes (id, user_id, title, tags, is_pinned, file_hash, type,',
      "  folder, canvas_data, visibility, created_at, updated_at)",
      "SELECT CAST(id AS TEXT), user_id, title, tags, is_pinned, file_hash, type,",
      "  '默认', '', 'private', created_at, updated_at",
      'FROM cloud_notes_old_m018'
    ].join('\n'));
    db.exec('DROP TABLE cloud_notes_old_m018');
  } else if (!hasTable) {
    db.exec(NEW_SCHEMA);
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_notes_user ON cloud_notes(user_id, is_pinned DESC, updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_notes_folder ON cloud_notes(user_id, folder)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_notes_visibility ON cloud_notes(visibility, updated_at)');

  db.exec([
    'CREATE TABLE IF NOT EXISTS cloud_note_folders (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL,',
    '  name TEXT NOT NULL,',
    "  created_at TEXT DEFAULT (datetime('now')),",
    '  UNIQUE(user_id, name)',
    ')'
  ].join('\n'));
}

module.exports = { version: 18, name: 'note_folders_canvas', up: up };
