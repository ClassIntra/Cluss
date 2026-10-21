// 迁移 032：模型 / 模型源加「是否下发到各班」标记
//
// 背景：模型配置是**整表替换**下发（见 services/model-config.js）：中枢上有什么，
// 节点上就有什么，多一个少一个都不行。但全校共用一套配置这件事有个副作用 ——
// 中枢为了某个班试用的新模型、贵模型、或者只有本机能连通的渠道，会**强制**
// 出现在每个班的模型选择列表里。班管既不能删（下一轮又被拉回来），也不能停用
// （停用同样会被覆盖）。
//
// 原来的唯一出口是给整个班关掉 model_sync（迁移 031），代价是这个班从此完全
// 自己维护模型 —— 只想排除一个模型，却要让整班脱管，粒度太粗。
//
// 所以加一层**按条目的下发范围**：sync_enabled = 0 的模型/源只留在本机，
// 不进入下发快照。默认 1，保持既有行为。
//
// 两条约束（在 routes/admin.js 里硬性挡住，不能只靠前端提示）：
//   1. 默认模型必须下发 —— 它是各班的计费基准，缺失会让节点上的倍率计算整体失去参照；
//   2. 源关闭时它挂的模型级联不发光 —— 否则节点收到一个指向不存在的源的模型，
//      表现为「源已失效」，管理员根本猜不到是中枢少发了那个源。

function up(db) {
  ['ai_models', 'ai_sources'].forEach(function(table) {
    var cols = db.prepare('PRAGMA table_info(' + table + ')').all();
    var names = {};
    for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;
    if (!names.sync_enabled) {
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 1');
    }
  });
}

module.exports = { version: 32, name: 'model_sync_scope', up: up };
