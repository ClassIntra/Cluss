// v11 · ai_conversations 增加 persona 列
//
// 日常模式支持「人格设定」（伙伴 / 幽默 / 元气 / 冷静）：随会话存储，
// 换个会话各回各的人格，不会互相串。学习 / 拍题 / 作文链路不使用该列。
//
// 为什么存列而不是每次随请求传：人格是会话的属性（像 mode 一样）——
// 学生在 A 会话选了「幽默」，切走再切回来，语气应该还在。
function up(db) {
  var names = db.prepare("PRAGMA table_info(ai_conversations)").all()
    .map(function(c) { return c.name; });

  if (!names.persona) {
    db.exec("ALTER TABLE ai_conversations ADD COLUMN persona TEXT DEFAULT ''");
  }
}

module.exports = { version: 11, name: 'conversations_persona', up: up };
