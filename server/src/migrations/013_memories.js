// 迁移 013：跨会话记忆
//
// 解决什么问题：
//   会话是有边界的，而学生的偏好与关键结论是跨会话的。
//   「我数学弱、别给我超纲内容」「这篇笔记是我复习的主线」这类信息，
//   若只存在于某次对话里，换一个会话就全忘了，模型每轮都在重新认识这个学生。
//
// 模型：key 唯一的条目式记忆
//   memories(user_id, key, content, source, updated_at)
//   - key     —— 记忆的"名字"，同 key 再次写入即**增量更新**（不是追加一条新的）
//   - content —— 记忆正文（一句话到几句话，刻意不存长文；长文该去云笔记）
//   - source  —— 从哪来的（auto / user / note），排障时一眼看出是谁写的
//
// 为什么用 key 而不是自增流水：
//   "增量更新"是需求的核心。流水式追加会让同一个事实存 N 份，
//   检索时要么全塞进上下文（浪费 token），要么挑一条（可能挑到过期的那份）。
//   key 唯一 + upsert 让一条事实永远只有一份最新表述。
//
// 与 cloud_notes 的分工（刻意不混）：
//   cloud_notes 是**学生自己写的文档**（正文在云盘 .md，可长可短，给人看的）；
//   memories 是**系统沉淀的碎片事实**（一句话，给模型看的）。
//   长文进笔记，结论进记忆 —— 反过来放两边都别扭。

function up(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS memories (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL,',
    // 记忆键，同一用户下唯一（增量更新的依据）
    '  key TEXT NOT NULL,',
    '  content TEXT DEFAULT \'\',',
    // auto（系统从行为沉淀）| user（学生自己说的）| note（从笔记提炼）
    '  source TEXT DEFAULT \'auto\',',
    // 检索用的冗余标签（空格分隔的关键词），为空时按 key+content 检索
    '  tags TEXT DEFAULT \'\',',
    '  created_at TEXT DEFAULT (datetime(\'now\')),',
    '  updated_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  // UNIQUE(user_id, key) 是"增量更新"的落地保证：
  // 靠 ON CONFLICT 就能 upsert，不必先查再决定 insert/update
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_user_key ON memories(user_id, key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_user_updated ON memories(user_id, updated_at DESC)');
}

module.exports = { version: 13, name: 'memories', up: up };
