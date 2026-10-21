// 迁移 029：隐藏会话 + 统一隐藏密码
//
// 背景：学生有不想被翻到的对话（问过尴尬的问题、把 AI 当树洞）。
// 笔记早就有了"私密笔记 + 密码"，但会话没有 —— 同一份隐私诉求，
// 两套入口、两个密码，学生要么不知道，要么记两次。
//
// 本迁移做三件事：
//   ① ai_conversations 加 hidden 列（0/1）：列表默认不带出隐藏会话，
//      读取隐藏会话内容需要先通过密码解锁（见 services/private-lock.js）；
//   ② 建 cluss_private_lock：隐藏密码（scrypt hash + salt，**不存明文**）。
//      笔记的私密密码与会话的隐藏密码共用这一份 —— "合为一个"；
//   ③ 幂等：ADD COLUMN 前查 PRAGMA；建表用 IF NOT EXISTS。
//
// 取舍说明：为什么不把密码 hash 放 localStorage？
//   隐藏是账号级功能，换台设备登录该同样生效；且 hash 留在学生自己维护的
//   本地数据里，清一次浏览器数据就"锁丢了人还能进"。
//   代价是 hash 上到服务器 —— standalone 模式下数据本就在本机；
//   节点模式下 hash 不可逆、不含任何聊天内容，符合"上云只有计量数据"红线。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(ai_conversations)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.hidden) {
    db.exec('ALTER TABLE ai_conversations ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }

  db.exec([
    'CREATE TABLE IF NOT EXISTS cluss_private_lock (',
    '  user_id TEXT PRIMARY KEY,',
    '  password_hash TEXT NOT NULL,',
    "  salt TEXT NOT NULL DEFAULT '',",
    "  created_at TEXT NOT NULL DEFAULT '',",
    "  updated_at TEXT NOT NULL DEFAULT ''",
    ')'
  ].join('\n'));
}

module.exports = { version: 29, name: 'conversation_hidden', up: up };
