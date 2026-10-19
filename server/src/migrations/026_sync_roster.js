// 迁移 026：全校花名册镜像（跨班充值的可见性来源）
//
// 背景（2026-10-19 实测的死结）：管理员在 18 班想给 8 班学生充值，但
//   · 18 班手握云端写入权，本机 users 表里却只有本班学生 —— 列表中找不到 8 班；
//   · 8 班看得见自己学生，却没有写入权（席位在 18 班），一提交就 403。
// 两边合起来 = **全校没有一个人能给 8 班充钱**。
//
// 账本这条路本来就是通的：云端 allocations 是全校口径，上行只挡「别的学校」，
// 节点落地时也只挑自己存在的学号。缺的从头到尾只是**可见性**。
//
// 于是补这张镜像表：席位班从云端拉一份全校名册存本机，管理台据此把外班
// 学生也列出来，充值照走既有的额度上行（那一路上没有本班限制）。
//
// 三条边界，都是不能破的：
//   1. **只读镜像，不是本地名册**。这里不参与 class-roster 的「一班一节点」
//      纳入/清理判定，也绝不进 users 表 —— 本机的世界边界仍是本班（那条边界
//      是拿撞号事故换来的，见 services/class-roster.js 头注）。
//   2. **只有席位班才有数据**：下行接口对非席位班一律 403，非席位班这张表
//      永远是空的，管理台的合并逻辑自然什么都不加。
//   3. **表里存的是云端快照**（含外班余额/消耗），不是本机账本。本机账本
//      （cluss_credit）继续只记本班 —— 外班的钱在云端，抄进本机账本就成了
//      两处口径。
//
// 关于列名用 user_id：本表会被 class-roster 的 userLinkedTables 自动纳入
// 「删账号连带清理」范围（该函数按「表里有没有 user_id 列」发现）。这是
// 可接受的：被清理的只会是本班账号，其镜像行随后由下一次轮询重新拉回。

function up(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS sync_roster (',
    '  user_id TEXT PRIMARY KEY,',
    // 上报这条记录的节点（= 该学生所在班的实例号）
    "  instance_id TEXT NOT NULL DEFAULT '',",
    // 仅展示用的班级号；权威归属仍由学号 YYCCNN 解出（见 class-roster.classOf）
    "  class_no TEXT NOT NULL DEFAULT '',",
    "  net_name TEXT NOT NULL DEFAULT '',",
    "  real_name TEXT NOT NULL DEFAULT '',",
    '  is_admin INTEGER NOT NULL DEFAULT 0,',
    "  status TEXT NOT NULL DEFAULT 'active',",
    // 以下四组来自云端（账本与流水现场 JOIN 的权威值），本机没有对应行
    '  allocated_micro INTEGER NOT NULL DEFAULT 0,',
    '  weekly_quota_micro INTEGER NOT NULL DEFAULT 0,',
    '  used_micro INTEGER NOT NULL DEFAULT 0,',
    '  calls INTEGER NOT NULL DEFAULT 0,',
    "  last_at TEXT NOT NULL DEFAULT '',",
    // 拉取时刻（整表替换时统一写入）。云端 roster_version 存 cluss_meta，
    // 不在每行重复一份。
    "  synced_at TEXT NOT NULL DEFAULT ''",
    ');',
    'CREATE INDEX IF NOT EXISTS idx_sync_roster_class ON sync_roster(class_no);'
  ].join('\n'));
}

module.exports = { version: 26, name: 'sync_roster', up: up };
