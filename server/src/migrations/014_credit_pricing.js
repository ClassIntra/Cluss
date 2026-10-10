// 迁移 014：积分策略 —— 模型倍率与限时免费
//
// 背景：管理员需要三种常见的运营手段，此前都只能改三个单价字段硬凑：
//   1) 倍率 —— 「这个模型比基础价贵 1.5 倍」。逐模型一个杠杆，不必每次
//      上游调价都换算三个数字。
//   2) 峰谷 —— 引导学生错峰使用（谷时段打折）。全局配置，存 cluss_meta，
//      与视觉配置同一套机制，改完即时生效，不进本迁移。
//   3) 限免 —— 「本周限时免费试用某贵模型」，到点自动恢复计费。
//      判定是惰性的（读取时比较时间），不需要定时任务去翻转状态。
//
// 字段口径：
//   price_multiplier_bp  万分比整数（10000 = 1.0 倍）。
//     为什么不存小数：全库金额都是微元整数运算，倍率若存浮点，
//     「微元 × 倍率」处就会引入浮点误差；万分比让一次乘法一次取整完成。
//   free_until           UTC 'YYYY-MM-DD HH:MM:SS'（与 time.nowUtc() 同口径，
//     字符串字典序即可比较）。空串 = 未设置限免。
//
// 幂等性说明：ADD COLUMN 前用 PRAGMA table_info 检查（与 003 同款）。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(ai_models)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.price_multiplier_bp) {
    db.exec('ALTER TABLE ai_models ADD COLUMN price_multiplier_bp INTEGER DEFAULT 10000');
  }
  if (!names.free_until) {
    db.exec("ALTER TABLE ai_models ADD COLUMN free_until TEXT DEFAULT ''");
  }
}

module.exports = { version: 14, name: 'credit_pricing', up: up };
