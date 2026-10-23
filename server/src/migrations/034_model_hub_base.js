// 迁移 034：中枢基线 —— 让「本班自选」档做到**字段级**同步
//
// 背景（2026-10-22 用户反馈「单价什么的也有同步」）：
//   033 给了 origin，但粒度是「整行」：本班只要动过某条模型的任何一个字段
//   （哪怕只是改个显示名），这一行就永久归本班，中枢后续对它的**单价、
//   倍率、峰谷、Key** 全部不再下发。管理员在中枢把单价从 1 元调到 0.5 元，
//   本班账单却还按 1 元扣 —— 这种漂移在账上查不出来，只能靠人发现。
//
// 改法：给每行记一份「上一次从中枢收到的是什么」（hub_base，JSON）。
// 合并时做三方比较：
//   · 本机值 == 基线   → 本班没动过这个字段 → 用中枢的新值
//   · 本机值 != 基线   → 本班改过这个字段   → 保留本班的值
// 于是「本班能改」与「中枢的调价能下来」不再互斥，冲突只落在**真的被改过的
// 那一个字段**上（冲突时本班优先，因为那是管理员在本机的明确动作）。
//
// 为什么不存「改过哪些列」的清单：清单要靠每个写路由主动上报，漏一处就永久
// 不同步（且无法自检）。基线是被动记录的，任何写法都算得出来。
//
// 幂等性：ADD COLUMN 前用 PRAGMA table_info 检查（与 003 / 014 同款）。

function up(db) {
  var targets = [
    { table: 'ai_models', column: 'hub_base' },
    { table: 'ai_sources', column: 'hub_base' }
  ];

  for (var t = 0; t < targets.length; t++) {
    var table = targets[t].table;
    var column = targets[t].column;

    var cols = db.prepare('PRAGMA table_info(' + table + ')').all();
    var names = {};
    for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

    if (!names[column]) {
      // 空串 = 「还没有基线」（老数据 / 本机自建）。合并时按来源区分：
      // origin='hub' 的行直接以中枢为准，origin='local' 的行以本机为准。
      db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " TEXT DEFAULT ''");
    }
  }
}

module.exports = { version: 34, name: 'model_hub_base', up: up };
