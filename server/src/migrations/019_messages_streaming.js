// 迁移 019：消息"正在生成"标记
//
// 背景：助手消息此前是**整轮生成结束才一次性 INSERT**。于是学生在生成途中
// 切页面 / 关掉应用再回来，会话里只看到用户消息，助手那条压根不存在 ——
// 看起来就像"生成断了/丢了"。服务端其实还在跑，只是没有任何中间态落在库里，
// 前端回到页面时无从判断"这轮到底还在不在生成"。
//
// 加一列 streaming：
//   1 = 这一轮还在生成（前端可以据此轮询，直到它变成 0）
//   0 = 已完成 / 已停止
// 配合 turn-runner 在流式开始时就**预留**一条占位助手消息、边生成边增量落库，
// 学生换设备、重开应用回来时就能看到"已写到哪"并继续等。
//
// 幂等：ADD COLUMN 前查 PRAGMA table_info；存量行默认 0（都已完成）
// —— 历史消息本就不该被当成"正在生成"。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(ai_messages)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.streaming) {
    // NOT NULL + DEFAULT 是安全的：SQLite 允许带默认值的 NOT NULL ADD COLUMN，
    // 存量行会被写成 0
    db.exec("ALTER TABLE ai_messages ADD COLUMN streaming INTEGER NOT NULL DEFAULT 0");
  }
}

module.exports = { version: 19, name: 'messages_streaming', up: up };
