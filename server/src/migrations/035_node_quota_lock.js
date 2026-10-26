// 迁移 035：按节点控制「本班能不能自己动额度」
//
// 背景（2026-10-27 取证）：额度写入权在节点侧只有一道门禁 ——
// admin.js 的 canEditQuotaFor 对「本班学号」无条件放行。所以某班的班管
// 可以在自己机器上给本班任意账号充任意金额，不必经过中枢；充完之后这笔数
// 还会随 /sync/roster 的名册上报覆盖中枢的 sync_roster —— 中枢看到的账
// 不是自己写的那本。实测该班班管在三天内给自己充值 1/999/1000/2000/5000
// 元试参数，最终留下两笔 6666 元；中枢的「收回」经中继下发确实生效过，
// 但两天后又被原地冲了回来。
//
// 根子的问题不是「忘了加校验」，而是**写入权的归属**：本班账本在本机，
// 本机管理员天然是它的话事人。中枢要管，只能靠一条能下发、且节点断网也翻
// 不过去的策略 —— 这正是 model_sync（迁移 031）已经跑通的那条路。
//
// 所以按节点给一个开关：
//   quota_lock = 0 —— 本班可自行充值/收回（现状，默认）
//   quota_lock = 1 —— 中枢锁定：本班禁止任何额度写操作，含本班学号
// 落地四处：
//   · routes/sync.js 的 /sync/version 把它按 instance_id 下发给节点；
//   · services/sync.js 收到后写进本机 cluss_meta —— 断网时仍按上次的锁定态
//     执行，否则拔网线就能绕过，这道锁等于没有；
//   · admin.js 的 canEditQuotaFor 在 NODE 模式下先查它；
//   · 中枢自己接收名册上报时，对锁定节点强制不写额度字段 —— 堵死
//     「本机改不了，那就直接改库再报上来」这条绕过路径。
//
// 默认 0（可自充），保持既有行为；是否加锁由中枢管理员决定。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(cluss_nodes)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  // cluss_nodes 由迁移 023 建。这是对极老库的容错：
  // 表还没有时不报错，让 023 先建好，下一轮自然补上这一列。
  if (!cols.length) return;

  if (!names.quota_lock) {
    db.exec('ALTER TABLE cluss_nodes ADD COLUMN quota_lock INTEGER NOT NULL DEFAULT 0');
  }
}

module.exports = { version: 35, name: 'node_quota_lock', up: up };
