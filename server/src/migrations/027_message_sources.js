// 迁移 027：助手消息的来源清单
//
// 背景：联网搜索的回答里会带 [1][2] 这样的引用编号，但编号对应的链接
// 只存在于**当时喂给模型的那条 tool 消息**里，落库的正文里没有。
// 于是学生事后回看，只看到一串没有出处的编号 —— 引用等于失效，
// 而这恰恰是"能不能信"的关键。
//
// 加一列 sources（JSON 数组）：
//   [{ n: 1, title, url, host, published, source_type }, ...]
//   n 是回答里 [n] 的编号，跨轮次连续（第二轮从第一轮的下一个号开始）。
//
// 幂等：ADD COLUMN 前查 PRAGMA table_info；存量行默认空串（没有来源）。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(ai_messages)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.sources) {
    db.exec("ALTER TABLE ai_messages ADD COLUMN sources TEXT DEFAULT ''");
  }
}

module.exports = { version: 27, name: 'message_sources', up: up };
