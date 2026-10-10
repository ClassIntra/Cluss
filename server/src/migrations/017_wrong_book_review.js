// 迁移 017：错题复习排期
//
// 背景：错题本此前只有「待复习 / 已掌握」两个状态，收进来的题会一直躺在那里——
// 它是一块墓碑，不是一个闹钟。学生真正需要的是「什么时候该再看一眼」。
//
// ---- 为什么用「本地日历日」而不是时间戳 ----
//
// 存 'YYYY-MM-DD' 而不是 UTC 时间戳，是被时区逼出来的决定：
//   学生问的是「今天要不要复习」，这是**日历日**问题，不是「间隔了多少小时」问题。
//   若按 UTC 时间戳判定到期，中国学生（UTC+8）在晚上 8 点之后，UTC 已经跨到第二天，
//   于是刚做完的题立刻又变成「已到期」——体感就是"它怎么又催我"。
//   用本地日历日 + 字符串比较：零时区歧义，判定简单，文案也直接（今天 / 明天 / 3 天后）。
//
// ---- 字段 ----
//   review_stage    已连续答对的次数（0 起）。它同时是「下次隔几天」的查表下标。
//   next_review_on  下次该复习的本地日历日；空字符串 = 已走完阶梯（等学生确认掌握）
//   last_reviewed_on 上次复习的本地日历日，用于「今天已经练过」这类判断
//   review_count    累计复习次数（含答错的），用于给学生看"这道题我练过 4 次"
//
// 幂等：ADD COLUMN 前查 PRAGMA table_info；回填只补空值，重复执行不会改动已有排期。

var LADDER = [1, 3, 7, 15, 30];

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// 本地日历日（服务器时区）
function localDay(offsetDays) {
  var d = new Date(Date.now() + Number(offsetDays || 0) * 86400000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function up(db) {
  var cols = db.prepare('PRAGMA table_info(wrong_questions)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.review_stage) {
    db.exec('ALTER TABLE wrong_questions ADD COLUMN review_stage INTEGER DEFAULT 0');
  }
  if (!names.next_review_on) {
    db.exec('ALTER TABLE wrong_questions ADD COLUMN next_review_on TEXT DEFAULT \'\'');
  }
  if (!names.last_reviewed_on) {
    db.exec('ALTER TABLE wrong_questions ADD COLUMN last_reviewed_on TEXT DEFAULT \'\'');
  }
  if (!names.review_count) {
    db.exec('ALTER TABLE wrong_questions ADD COLUMN review_count INTEGER DEFAULT 0');
  }

  // ---- 存量回填 ----
  // 规则：还没掌握的题，按「入库日 + 1 天」排第一次复习。
  //
  // 这里用 SQLite 的 date() 在库内算（created_at 存的是 UTC），
  // 与本地日历日会有最多 1 天的偏差——可以接受：这是一次性的历史数据回填，
  // 而且偏差只发生在「创建时刻距 UTC 跨日不到 8 小时」的行上，
  // 不影响此后所有由应用层排期的记录。
  //
  // 已经过期很久的题不做特殊处理：它们会立刻出现在「今日待复习」里，
  // 这正是想要的——攒了很久没看过的错题，本就该马上过一遍。
  db.exec([
    'UPDATE wrong_questions',
    "SET next_review_on = date(COALESCE(created_at, datetime('now')), '+1 day')",
    "WHERE (next_review_on IS NULL OR next_review_on = '')",
    '  AND mastered = 0'
  ].join('\n'));

  // 已掌握的题不排期：它们不该出现在复习队列里
  db.exec([
    'UPDATE wrong_questions',
    "SET next_review_on = ''",
    "WHERE (next_review_on IS NULL OR next_review_on = '')",
    '  AND mastered = 1'
  ].join('\n'));

  // 到期查询是最高频的路径（每次进错题本、每次刷新角标都走它）
  db.exec([
    'CREATE INDEX IF NOT EXISTS idx_wrong_due',
    'ON wrong_questions(user_id, mastered, next_review_on)'
  ].join(' '));
}

module.exports = { version: 17, name: 'wrong_book_review', up: up, LADDER: LADDER, localDay: localDay };
