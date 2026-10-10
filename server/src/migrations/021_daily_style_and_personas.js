// 迁移 021：日常模式「无限制风格」开关 + 学生自定义 AI 人格
//
// 本次做两件事（都属于"日常对话"这一条链路）：
//
// ① ai_conversations 增加 daily_style 列
//   日常模式默认是"学习边界"内的闲聊（不主动展开娱乐内容、不写攻略）。
//   学生可以按会话切到"无限制"：内容放开 + 话题放开（能聊娱乐、能写攻略、
//   能纯闲聊），但**计费不放开** —— 仍然照常扣积分，不因为"放得开"而免费，
//   也不因为"放得开"而加价。
//   存列而不是随请求传，理由同 persona：它是会话属性，切走再切回应该还在。
//   取值约定：''（默认/受限）| 'free'（无限制）。
//
// ② 新建 ai_personas 表（学生自定义人格）
//   内置 4 个人格（伙伴/幽默/元气/冷静）此前硬编码在 prompt-registry 里，
//   学生只能选、不能改。现在允许每个学生自己写人格（名字 + 提示词）。
//   - user_id + name 唯一：同一个学生不能建两个同名人格（前端好显示、不易混）
//   - prompt 是学生写的**人设描述**，不是系统提示词本身 ——
//     系统提示词的硬约束（安全 / 底线）永远在，自定义人格只在"语气/风格"层生效
//     （落地在 prompt-registry 的 PERSONA_GUARD 里，不交由学生 override）
//   - builtin 标记：为将来"把某个内置人格固化进学生列表"留口子，当前一律 0
//
// 幂等：ADD COLUMN 前查 PRAGMA；建表/索引一律 IF NOT EXISTS。

function up(db) {
  // ---- ① daily_style ----
  var cols = db.prepare('PRAGMA table_info(ai_conversations)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.daily_style) {
    // 默认 '' = 受限（与历史行为一致，存量会话不受影响）
    db.exec("ALTER TABLE ai_conversations ADD COLUMN daily_style TEXT DEFAULT ''");
  }

  // ---- ② ai_personas ----
  db.exec([
    'CREATE TABLE IF NOT EXISTS ai_personas (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL,',
    // 人格名（学生自己起的，如"毒舌学姐""温柔学长"）
    '  name TEXT NOT NULL,',
    // 人设描述（学生写的一段话，描述希望 AI 用什么口吻/性格）
    '  prompt TEXT DEFAULT \'\',',
    // 0 = 学生自定义；1 = 内置人格固化（当前未用，留口子）
    '  builtin INTEGER NOT NULL DEFAULT 0,',
    '  created_at TEXT DEFAULT (datetime(\'now\')),',
    '  updated_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  // 同一学生下人格名唯一：防止列表出现两个同名项，学生自己都分不清
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_user_name ON ai_personas(user_id, name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_personas_user ON ai_personas(user_id)');
}

module.exports = { version: 21, name: 'daily_style_and_personas', up: up };
