// 迁移 030：sync_roster 加「中枢已下发额度」标记
//
// 背景（2026-10-21 真机实测）：跨班充值账能加上，**但收回（归零）传不下去**。
//
//   下行 /sync/assignments 的列表条件原来是 `allocated_micro > 0`。
//   这条件对「充值」没问题，对「归零」是致命的：被收回的学生额度正好是 0，
//   于是**不在下发列表里** —— 节点拿不到清零指令，永远停在旧值 ¥2。
//   管理台点「收回」会返回成功，钱却没退。（实测：中枢已归零，8 班仍显示 ¥2）
//
// 为什么不能简单去掉 `> 0`：
//   下发是**整表覆盖**语义。全量下发会把这个节点上所有「本来就没额度」的学生
//   也一并写 0 —— 如果节点刚在本班给学生调过额度、还没上报，就会被中枢的旧值冲掉。
//   谁的钱该归谁管，不能靠「都发一遍 + 覆盖」蒙过去。
//
// 于是加一列显式记录**中枢的意图**：
//   hub_quota_set = 1 表示「中枢改过这个学生的额度，这个意图还没被节点确认」，
//   此时无论额度是 0 还是正数，都要出现在下发列表里。
//
// 清除时机：节点上报名册且**已经追平额度版本**（说明它确实应用了这次下发）时置 0。
// 节点落后时的上报不动这一列，否则「中枢刚改、节点用旧值上报」会把意图抹掉。
//
// 幂等性说明：ADD COLUMN 前用 PRAGMA table_info 检查。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(sync_roster)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.hub_quota_set) {
    db.exec('ALTER TABLE sync_roster ADD COLUMN hub_quota_set INTEGER NOT NULL DEFAULT 0');
  }
}

module.exports = { version: 30, name: 'roster_hub_quota', up: up };
