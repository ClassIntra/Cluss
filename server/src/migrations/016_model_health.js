// ------------------------------------------------------------
// 016：模型健康台账（运行时事实，与管理员的启用意图分开存）
//
// 为什么单独一张表，而不是在 ai_models 上加字段：
//   ai_models 存的是「管理员想要什么」（enabled / 价格 / 是否默认），
//   健康状态存的是「上游实际怎么样」（连续失败次数 / 是否已熔断）。
//   两类状态混在一张表里，迟早会出现「我明明启用了为什么不能用」的扯皮；
//   分开之后，管理员改配置不会误伤运行时的熔断记录，重启也不会丢台账。
//
// 为什么用 INSERT ... ON CONFLICT 而不是 ALTER TABLE 加列：
//   1) 每新增一种观测维度（将来可能有响应时延、成功率）都要改一次主表结构，
//      主表是配置表，不该被高频写入；
//   2) 健康行可能不存在（模型从没被调用过），独立表天然表达「还没观测过」。
//
// 幂等：CREATE TABLE IF NOT EXISTS + index 同名判断。
// ------------------------------------------------------------

module.exports = {
  version: 16,
  name: '016_model_health',
  up: function(db) {
    db.exec([
      'CREATE TABLE IF NOT EXISTS ai_model_health (',
      '  model_id       TEXT PRIMARY KEY,',
      '  fail_count     INTEGER DEFAULT 0,',
      '  health_status  TEXT DEFAULT \'unknown\',',
      '  health_detail  TEXT DEFAULT \'\',',
      '  checked_at     TEXT,',
      '  created_at     TEXT',
      ')'
    ].join('\n'));
  }
};
