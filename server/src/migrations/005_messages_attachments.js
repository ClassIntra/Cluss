// 迁移 005：消息附件与来源标记
//
// attachments 存的是 JSON 数组：[{hash, name, mime, size, kind}]
//   kind = image | text
//
// ⚠️ 绝不存 base64：一张手机拍的题图 base64 后约 2~8MB，几个来回就能把
//    会话表撑到几百 MB，且 SQLite 每次读整行都会把这串大字符串搬进内存。
//    图片正文按 hash 从云盘重读即可，这里只留引用与元信息。
//
// source 标记这条消息由哪种链路产生：chat（对话）/ study（学习）/ solve（拍题）/ grade（批改）。
// 用于后续按来源统计与排查「这条回复是谁生成的」。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(ai_messages)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.attachments) {
    db.exec('ALTER TABLE ai_messages ADD COLUMN attachments TEXT DEFAULT \'[]\'');
  }
  if (!names.source) {
    db.exec('ALTER TABLE ai_messages ADD COLUMN source TEXT DEFAULT \'chat\'');
  }
}

module.exports = { version: 5, name: 'messages_attachments', up: up };