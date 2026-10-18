// 迁移 025：校园情境的**学生侧开关**
//
// 背景：Cluss 通过只读桥拿到学生在校园社区的活动素材（签名 / 音乐 / 发帖 /
// 棋类 / 学业倒计时），这些素材会进入提示词、让 AI "更懂这个人"。
// 但此前它们**只存在于提示词里**，且明确要求模型「绝对不要主动提起」——
// 因为学生不知道系统把这些告诉了 AI，说出来就是"被监视"。
//
// 这个迁移要做的，是把「偷偷用」变成「明着用」：
//   学生在自己的设置里能看到"AI 现在知道的关于我的校园信息"，
//   并且可以整体关掉、也可以只关掉某一项。
//
// 为什么值得为它建一张表（而不是塞进 users.info_json）：
//   1. 这是**隐私开关**，读写路径必须与其它资料字段分开 —— 混在 info_json 里
//      等于任何一次资料更新都可能顺手改掉它（覆盖写是 info_json 的常态）；
//   2. 关掉是"我不同意你用"，需要能**明确回读到默认值以外的值**，
//      独立行 + 独立列才有这个确定性；
//   3. 逐项关闭（disabled_json）是一组 key，本身也不适合摊平进资料字段。
//
// 与独立性的关系（重要）：本表**只存开关**，不存任何校园素材。
// 素材永远只从 CI 临时取、用完即弃（见 services/ci-bridge.js 的缓存说明）。
// 于是 CI 未联动时，这张表就是一张空表，Cluss 的一切行为与独立部署完全一致。

function up(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS campus_context_opt (',
    // 一个学生一行；学生被清理时随 users 一起删（见 class-roster 的 userLinkedTables，
    // 它按"表里有没有 user_id 列"运行时发现，本表有，会被自动覆盖）
    '  user_id TEXT PRIMARY KEY,',
    // 总开关：0 = 完全不使用校园素材（既不进提示词，也不在设置里展示内容）
    '  enabled INTEGER NOT NULL DEFAULT 1,',
    // 逐项关闭：被关掉的素材 key 的 JSON 数组，如 ["music","games"]
    // 用"关闭名单"而不是"开启名单"：将来 CI 侧新增素材种类时，
    // 存量学生默认就能享受新素材，不必等他们回来勾选一遍。
    "  disabled_json TEXT NOT NULL DEFAULT '[]',",
    "  updated_at TEXT DEFAULT ''",
    ')'
  ].join('\n'));
}

module.exports = { version: 25, name: 'campus_context', up: up };
