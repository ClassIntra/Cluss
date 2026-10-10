// 迁移 012：云笔记元数据表
//
// 存储模型（与云盘一致的内容寻址思想）：
//   cloud_notes      —— 笔记元数据（标题 / 标签 / 置顶 / 所属云盘文件 hash）
//   正文（markdown） —— 存为云盘里的 .md 文本文件（cloud_files + cloud_user_files）
//
// 为什么元数据单独建表，而不是全部塞进 cloud_files：
//   云盘文件是内容寻址的（同一内容只存一份），标题/标签/置顶/排序这些"每篇笔记自己"
//   的属性不适合放在共享的物理文件记录上。这里沿用"引用与实体分离"的模型：
//   cloud_files 存全文，cloud_notes 存每篇笔记的元数据与归属。
//
// file_hash：指向 cloud_files.hash（该笔记正文的 .md 文件）。
// type：note（纯文本笔记）。ClassIntra 还有 draw（画板），本项目先只做 note，
//       保留 type 字段为将来扩展留位，方便不改表就能加画板。
//
// ⚠️ 本项目 foreign_keys=ON：
//   - 插 cloud_notes 前，对应 cloud_files 行必须已存在（先写云盘再写元数据）
//   - 删除时先删元数据、引用归零才软删文件（cloud-store 已封装，路由里按序调用）

function up(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS cloud_notes (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL,',
    '  title TEXT DEFAULT \'\',',
    // JSON 数组字符串，如 ["数学","复习"]；空串视为无标签
    '  tags TEXT DEFAULT \'\',',
    '  is_pinned INTEGER DEFAULT 0,',
    // 正文 .md 文件在 cloud_files 里的 hash（内容寻址）
    '  file_hash TEXT NOT NULL,',
    // note | draw（本项目先只做 note，保留扩展位）
    '  type TEXT DEFAULT \'note\',',
    '  created_at TEXT DEFAULT (datetime(\'now\')),',
    '  updated_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_notes_user ON cloud_notes(user_id, is_pinned DESC, updated_at DESC)');
}

module.exports = { version: 12, name: 'cloud_notes', up: up };
