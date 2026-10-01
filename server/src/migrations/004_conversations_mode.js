// 迁移 004：会话模式（学习 / 日常）与学习子模式（引导 / 直接给答案）
//
// 为什么拆成两列而不是一个 mode：
//   mode       决定整体提示词框架（学习 vs 通用助手）
//   study_style 是学习大类内部的子模式，可随时切换而不改变大类归属
// 合成一列的话，「学习→直答→再切回引导」会被当成三次大类切换，
// 既污染语义，也让前端无法只切换子模式。
//
// 存量会话默认 study + guided：它们本来就是引导式解题产生的。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(ai_conversations)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.mode) {
    db.exec('ALTER TABLE ai_conversations ADD COLUMN mode TEXT DEFAULT \'study\'');
  }
  if (!names.study_style) {
    db.exec('ALTER TABLE ai_conversations ADD COLUMN study_style TEXT DEFAULT \'guided\'');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_conv_user_mode ON ai_conversations(user_id, mode, updated_at DESC)');
}

module.exports = { version: 4, name: 'conversations_mode', up: up };