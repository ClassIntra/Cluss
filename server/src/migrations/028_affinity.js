// 迁移 028：好感度（默契度）系统
//
// 背景：产品要有一个回答「AI 和我熟不熟」的东西。它不是积分（积分是花掉的额度），
// 也不是排行榜（校园里比分数是负向的），而是随**真实使用深度**增长的亲密度：
//   每天来问问、连续来、被 AI 记住、试过没碰过的功能。
//
// 设计取向——只加不减、每日有顶、不设外人可见的榜：
//   · 只加不减：学生几天不来就扣分，只会让"好久没来"更不敢来；
//   · 每日 8 分封顶：防止集中刷对话把等级冲爆，等级要靠日子堆出来；
//   · 不对外展示：只有学生自己看得到，没有攀比就没有内卷。
//
// 两张表：
//   cluss_affinity      当前状态（一行一人）：总分、连续天数、最近活跃日、探索过的功能
//   cluss_affinity_log  流水：每次加减都留痕。一是可解释（学生问"这分哪来的"），
//                       二是出问题时能复盘是不是规则算错了。
//
// 幂等：建表用 IF NOT EXISTS；探索过的功能用 JSON 数组文本存，
//       读时容错解析，不依赖迁移顺序。

function up(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS cluss_affinity (',
    "  user_id TEXT PRIMARY KEY,",
    '  points INTEGER NOT NULL DEFAULT 0,',
    '  streak_days INTEGER NOT NULL DEFAULT 0,',
    // 最近一次活跃的自然日（本地 YYYY-MM-DD，用 utils/time 的 localDay）',
    "  last_active_date TEXT NOT NULL DEFAULT '',",
    // 已探索过的功能区（JSON 数组文本，如 ["chat","study"]）。空串 = 还没探索任何功能',
    "  explored TEXT NOT NULL DEFAULT '',",
    // 每个原因每天记几次，用于「同一 reason 每天只加一次」与防刷复盘',
    "  daily_marks TEXT NOT NULL DEFAULT '',",
    "  created_at TEXT NOT NULL DEFAULT '',",
    "  updated_at TEXT NOT NULL DEFAULT ''",
    ')'
  ].join('\n'));

  db.exec([
    'CREATE TABLE IF NOT EXISTS cluss_affinity_log (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL,',
    '  delta INTEGER NOT NULL DEFAULT 0,',
    '  reason TEXT NOT NULL,',
    "  created_at TEXT NOT NULL DEFAULT ''",
    ')'
  ].join('\n'));

  db.exec('CREATE INDEX IF NOT EXISTS idx_affinity_log_user ON cluss_affinity_log(user_id, id DESC)');
}

module.exports = { version: 28, name: 'affinity', up: up };
