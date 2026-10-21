// 迁移 031：按节点控制「是否跟随中枢的模型选择」
//
// 背景：模型配置是整表替换下发（中枢改完，所有节点跟着换）。但班级之间
// 未必想用同一套模型 —— 有的班想用自己的 Key/更便宜的模型，或者本地网络
// 连不上中枢选的那家。原来没有开关，只能靠「拔掉 CLUSS_RELAY_URL」整台断开，
// 代价是额度与名单也一起断了。
//
// 所以给每个节点单独一个开关：model_sync = 0 的班保留自己的模型配置，
// 额度/名单/策略照常跟随。中枢在 /sync/version 里把它下发给该节点，
// 节点据此跳过模型配置拉取。
//
// 默认 1（跟随），保持既有行为。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(cluss_nodes)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.model_sync) {
    db.exec('ALTER TABLE cluss_nodes ADD COLUMN model_sync INTEGER NOT NULL DEFAULT 1');
  }
}

module.exports = { version: 31, name: 'node_model_sync', up: up };
