// 迁移 009：错题本
//
// 背景：批改出来的错题看完就没了。这是最该沉淀的学习资产——
// 学生复习时最需要的不是"我当时做了什么题"，而是"我错过哪些、为什么错"。
//
// 数据来源两种：
//   ai     —— 批改时由模型额外输出结构化错题，后端自动入库
//   manual —— 学生自己加进去（AI 识别有误差，或者老师布置的错题）
//
// 字段设计说明：
//   question / correct_answer / reason 是核心三件套（题干 / 正解 / 错因）
//   student_answer 保留学生当时的答法——复习时对照"我当初为什么这么想"最有用
//   image_hash 关联题图，复习时能原图回看
//   note 留给学生自己写（AI 给不了个性化的东西）
//   mastered 是最常用的筛选维度，单独建索引

function up(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS wrong_questions (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL,',
    '  conversation_id TEXT DEFAULT \'\',',
    '  image_hash TEXT DEFAULT \'\',',
    // ai（批改自动提取） | manual（学生手动录入）
    '  source TEXT DEFAULT \'ai\',',
    '  subject TEXT DEFAULT \'\',',
    '  question TEXT NOT NULL,',
    '  student_answer TEXT DEFAULT \'\',',
    '  correct_answer TEXT DEFAULT \'\',',
    '  reason TEXT DEFAULT \'\',',
    // ✗ 完全错 | △ 部分对
    '  tag TEXT DEFAULT \'✗\',',
    '  mastered INTEGER DEFAULT 0,',
    '  note TEXT DEFAULT \'\',',
    '  created_at TEXT DEFAULT (datetime(\'now\')),',
    '  updated_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  db.exec('CREATE INDEX IF NOT EXISTS idx_wrong_user ON wrong_questions(user_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_wrong_mastered ON wrong_questions(user_id, mastered)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_wrong_conv ON wrong_questions(conversation_id)');
}

module.exports = { version: 9, name: 'wrong_questions', up: up };