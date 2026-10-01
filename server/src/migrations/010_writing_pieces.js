// 迁移 010：作文记录
//
// 三种用途共用一张表（mode 区分）：
//   generate —— 生成范文（content 存范文）
//   grade    —— 批改学生原稿（content 存原稿，feedback 存批改意见）
//   outline  —— 给提纲（outline 存提纲）
//
// 为什么合成一张表而不是三张：三种用途的参数面板完全一样
// （语言/类型/风格/字数/题目），历史列表也要混在一起按时间排。
// 拆表会让"查看我的作文记录"变成三次查询再合并。

function up(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS writing_pieces (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL,',
    '  conversation_id TEXT DEFAULT \'\',',
    // generate | grade | outline
    '  mode TEXT NOT NULL,',
    // zh | en
    '  language TEXT DEFAULT \'zh\',',
    '  genre TEXT DEFAULT \'\',',
    '  style TEXT DEFAULT \'\',',
    '  word_limit INTEGER DEFAULT 0,',
    '  topic TEXT DEFAULT \'\',',
    '  outline TEXT DEFAULT \'\',',
    '  content TEXT DEFAULT \'\',',
    '  feedback TEXT DEFAULT \'\',',
    '  image_hashes TEXT DEFAULT \'[]\',',
    '  created_at TEXT DEFAULT (datetime(\'now\')),',
    '  updated_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  db.exec('CREATE INDEX IF NOT EXISTS idx_writing_user ON writing_pieces(user_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_writing_mode ON writing_pieces(user_id, mode, created_at DESC)');
}

module.exports = { version: 10, name: 'writing_pieces', up: up };