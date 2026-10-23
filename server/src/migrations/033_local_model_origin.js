// 迁移 033：给模型与模型源打「来源」标记
//
// 为什么需要这一列：模型同步以前是两态——跟随（整表替换）或不跟（完全不动）。
// 2026-10-22 用户提出中间那档：**「既同步又能本班改，改动不回传」**。
//
// 这一档不能靠整表替换实现：中枢每下发一次就把本班自建的模型全删了。
// 也不能靠完全不拉：中枢新配的模型本班就永远看不到。
//
// 唯一自洽的做法是**按来源合并**：
//   · origin='hub'   —— 来自中枢的下发，每次下发前清掉、按快照重建
//   · origin='local' —— 本班自己建的（或中枢没下发的），下发时原样保留
//
// 默认值取 'local' 而不是 'hub'：迁移执行时表里已有的行都是本机自己的配置
// （中枢自己也是 'local'，它从不 applySnapshot 自己），标成 hub 会让升级后
// 第一次「本班自选」下发把它们全删掉。

function ensureColumn(db, table, column, ddl) {
  var cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  for (var i = 0; i < cols.length; i++) {
    if (cols[i].name === column) return;
  }
  db.exec(ddl);
}

function up(db) {
  ensureColumn(db, 'ai_models', 'origin',
    "ALTER TABLE ai_models ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, 'ai_sources', 'origin',
    "ALTER TABLE ai_sources ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'");
}

module.exports = { version: 33, name: 'local_model_origin', up: up };
