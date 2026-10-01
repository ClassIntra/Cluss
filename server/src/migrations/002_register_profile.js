// 迁移 002：注册信息补全（入学年份 / 班级）与学号段规则
//
// 背景：Cluss 注册要求填「真实姓名 + 入学年份 + 班级」，
// 并据此分配 YYNNCC 格式学号：
//   YY = 入学年份后两位（2025 → 25），NN = 班级号，CC = 班内注册编号
//   例：2025 年入学、3 班、第 7 个注册 → 250307
// 这样在联动部署时，Cluss 账号与 ClassIntra 的学号体系天然对应，不需要映射表。
//
// 幂等性说明：ADD COLUMN 前用 PRAGMA table_info 检查列是否已存在。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(users)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.enrollment_year) {
    db.exec('ALTER TABLE users ADD COLUMN enrollment_year TEXT DEFAULT \'\'');
  }
  if (!names.class_no) {
    db.exec('ALTER TABLE users ADD COLUMN class_no TEXT DEFAULT \'\'');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_users_class ON users(enrollment_year, class_no)');
}

module.exports = { version: 2, name: 'register_profile_fields', up: up };