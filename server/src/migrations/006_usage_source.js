// 迁移 006：用量流水补来源、追踪与图片计数
//
// source     这条流水来自哪条链路：
//              chat（日常/学习对话）| solve（拍题）| grade（批改）
//              | vision_relay（图片转述的单独调用）
// trace_id   把「一次用户请求产生的多条上游记账」串成一组。
//             转述回退时一次拍题会产生 N+1 条流水（N 张图各转述一次 + 1 次主回答），
//             没有 trace_id 就无法回答「这次拍题到底花了多少」。
// image_count 本次调用携带的图片数，用于分析「图片对成本的影响」。
//
// 三个字段都带默认值，保证旧节点上报（不带这些字段）仍能正常入库。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(cluss_usage_log)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.source) {
    db.exec('ALTER TABLE cluss_usage_log ADD COLUMN source TEXT DEFAULT \'chat\'');
  }
  if (!names.trace_id) {
    db.exec('ALTER TABLE cluss_usage_log ADD COLUMN trace_id TEXT DEFAULT \'\'');
  }
  if (!names.image_count) {
    db.exec('ALTER TABLE cluss_usage_log ADD COLUMN image_count INTEGER DEFAULT 0');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_user_source ON cluss_usage_log(user_id, source, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_trace ON cluss_usage_log(trace_id)');
}

module.exports = { version: 6, name: 'usage_source', up: up };