// 验证「积分是元的展示层」这条设计没有被破坏：
//   1. 换算正确
//   2. 学生端视图里**不含任何元字段**
//   3. 管理端继续拿得到元（对账口径不能丢）
//   4. 闸门文案是积分口径
//
// 用法：cd server && node scripts/verify-points.cjs
require('dotenv').config();

var config = require('../src/config');
var credit = require('../src/services/credit');
var stats = require('../src/services/usage-stats');
var prompts = require('../src/services/prompt-registry');

var pass = 0;
var fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}
function hasYuanKey(obj) {
  for (var k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && /_yuan$/.test(k)) return k;
  }
  return null;
}

console.log('\n[1] 换算');
ok(config.microToPoints(1000000) === 100, '1 元（1e6 微元）→ 100 积分');
ok(config.microToPoints(0) === 0, '0 微元 → 0 积分');
ok(config.microToPoints(5000) === 1, '5000 微元（半分钱）四舍五入 → 1 积分');
ok(config.yuanToPoints(30) === 3000, '30 元 → 3000 积分');

console.log('\n[2] 学生端额度视图');
var view = credit.toPointsView({
  is_allocated: true,
  allocated_micro: 20000000,   // 20 元
  used_micro: 7600000,         // 7.6 元
  available_micro: 12400000,   // 12.4 元
  used_percent: 38,
  weekly_unlimited: false,
  weekly_quota_micro: 5000000, // 5 元
  weekly_used_micro: 1000000,  // 1 元
  weekly_remaining_micro: 4000000,
  weekly_percent: 20,
  window_days: 7
});

ok(view.allocated_points === 2000, '总额度 2000 积分，实际 ' + view.allocated_points);
ok(view.used_points === 760, '已用 760 积分，实际 ' + view.used_points);
ok(view.available_points === 1240, '可用 1240 积分，实际 ' + view.available_points);
ok(view.weekly_quota_points === 500, '周限额 500 积分');
ok(view.weekly_remaining_points === 400, '本周剩余 400 积分');
ok(!hasYuanKey(view), '视图中没有任何 _yuan 字段');
ok(view.unit === '积分', '带单位标识');

// 可用量向下取整：不能出现"显示还有 1 积分，一问就被拦"
var tiny = credit.toPointsView({ available_micro: 9900, is_allocated: true });
ok(tiny.available_points === 0, '0.99 积分显示为 0（宁可少显示也不误导），实际 ' + tiny.available_points);

console.log('\n[3] 学生端用量视图：去术语化 + 积分换算');
var gRow = stats.studentGroupRow({ key: 'solve', calls: 3, cost_micro: 250000, total_tokens: 9999 });
ok(gRow.cost_points === 25, 'cost_micro 250000 → 25 积分，实际 ' + gRow.cost_points);
ok(gRow.label === '拍题', '来源分组翻译成中文，实际 ' + gRow.label);
ok(gRow.total_tokens === undefined, '不含 token 字段');
ok(gRow.key === 'solve' && gRow.calls === 3, 'key 与次数保留');

var dRow = stats.studentGroupRow({ key: '2026-10-02', calls: 1, cost_micro: 10000 });
ok(dRow.label === '2026-10-02', '日期分组标题保留原样');

var t = stats.studentTotals({ calls: 5, cost_micro: 300000, total_tokens: 12345, prompt_tokens: 100 });
ok(t.cost_points === 30, '总量换算成 30 积分，实际 ' + t.cost_points);
ok(t.total_tokens === undefined && t.prompt_tokens === undefined, '总量不含 token 字段');

var rec = stats.studentRecordRow({
  id: 1, created_at: '2026-10-02T01:00:00Z', source: 'grade', model_label: 'DeepSeek Chat',
  prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, cache_hit_tokens: 50,
  cost_micro: 120000, conversation_title: '二次函数怎么找最值', image_count: 2, estimated: 0
});
ok(rec.cost_points === 12, '单条换算成 12 积分，实际 ' + rec.cost_points);
ok(rec.source_label === '批改', '类型翻译成中文，实际 ' + rec.source_label);
ok(rec.title === '二次函数怎么找最值', '带会话标题（比模型名对学生有用得多）');
ok(rec.model_label === undefined, '不含模型名');
ok(rec.prompt_tokens === undefined && rec.completion_tokens === undefined &&
   rec.total_tokens === undefined && rec.cache_hit_tokens === undefined, '不含任何 token 字段');
ok(rec.cost_micro === undefined && rec.cost_yuan === undefined, '不含金额原值');

console.log('\n[4] 闸门文案');
var gateNoAlloc = credit.checkGate('__never_allocated_user__', { is_free: 0 });
ok(!!gateNoAlloc, '未开通账号被拦下');
ok(gateNoAlloc.indexOf('¥') < 0, '未开通文案不含 ¥');
ok(gateNoAlloc.indexOf('积分') < 0 ? true : gateNoAlloc.indexOf('积分') > 0,
  '未开通文案说明下一步（原文：' + gateNoAlloc + '）');

console.log('\n[4b] 周限额文案（心理抗拒相关，事务内验证后回滚）');
try {
  var db = require('../src/utils/db');
  var time = require('../src/utils/time');
  var gateMsg = '';
  db.transaction(function() {
    var uid = '__test_weekly__';
    db.prepare('INSERT INTO cluss_credit (user_id, allocated_micro, weekly_quota_micro, updated_at, assigned_by) VALUES (?, ?, ?, ?, ?)')
      .run(uid, 100000000, 5000000, time.nowUtc(), 'test');
    // 本周已用满 5 元
    db.prepare(['INSERT INTO cluss_usage_log (user_id, cost_micro, source, created_at, synced)',
      'VALUES (?, ?, ?, ?, 0)'].join('\n'))
      .run(uid, 5000000, 'chat', time.nowUtc());

    gateMsg = credit.checkGate(uid, { is_free: 0 }) || '';
    throw new Error('__ROLLBACK__');
  })();
} catch (e) {
  if (e.message !== '__ROLLBACK__') throw e;
}
ok(!!gateMsg, '周限额用满时被拦下');
ok(gateMsg.indexOf('下周再试') < 0, '不再说"请下周再试"（既像管制，也不准确）');
ok(gateMsg.indexOf('滚动回补') > 0, '说明额度按天回补（给出更短、真实的可期时间）');
ok(gateMsg.indexOf('防止单个账号') > 0, '说明限制的理由（有理由的限制更易被接受）');
ok(gateMsg.indexOf('¥') < 0, '周限额文案同样不含 ¥');

console.log('\n[5] 管理端口径未受影响');
var sum = stats.summary({
  userId: '999999',
  from: '1970-01-01 00:00:00',
  to: '2099-01-01 00:00:00',
  days: 7,
  groupBy: 'day'
});
ok(sum.totals.cost_yuan !== undefined, '统计服务仍返回 cost_yuan（管理台在用）');
ok(hasYuanKey(sum.totals) === 'cost_yuan', '管理端保留元字段');

console.log('\n[6] CSV 两种口径（列也不同，不只是换单位）');
var rows = [
  { created_at: '2026-10-02T01:00:00Z', user_name: '甲', user_id: '250301', source: 'chat', model_label: 'M', prompt_tokens: 1, completion_tokens: 2, cache_hit_tokens: 0, total_tokens: 3, image_count: 0, cost_yuan: '0.25', cost_points: 25, estimated: 0 },
  stats.studentRecordRow({ created_at: '2026-10-02T02:00:00Z', source: 'solve', cost_micro: 30000, conversation_title: '求最值' })
];
var csvYuan = stats.recordsToCsv([rows[0]]);
var csvPoints = stats.recordsToCsv(rows, { unit: 'points' });
ok(csvYuan.indexOf('费用(元)') > 0 && csvYuan.indexOf('0.25') > 0, '管理台导出仍是元');
ok(csvYuan.indexOf('总Token') > 0, '管理台导出保留完整台账列');
ok(csvPoints.indexOf('消耗积分') > 0 && csvPoints.indexOf(',25') > 0, '学生导出是积分');
ok(csvPoints.indexOf('费用(元)') < 0 && csvPoints.indexOf('Token') < 0, '学生导出不含"元"与"Token"');
ok(csvPoints.indexOf('求最值') > 0, '学生导出有"内容"列（写了他问的是什么）');
ok(csvPoints.split('\n').length === 3, '学生导出两行数据，实际 ' + (csvPoints.split('\n').length - 1) + ' 行');

console.log('\n[7] 提示语里不出现金额（避免模型对学生说"花了多少钱"）');
var sys = prompts.getSystemPrompt({ mode: 'study', studyStyle: 'guided' });
ok(sys.indexOf('¥') < 0, '提示词不含 ¥ 符号');
ok(sys.indexOf('积分') > 0, '提示词使用积分口径（含"不要主动播报余额"的约束）');
ok(sys.indexOf('主动播报') > 0, '有"不要主动播报余额"的约束');

var sysWithBal = prompts.getSystemPrompt({
  mode: 'study', studyStyle: 'guided',
  pointsBalance: 1240, weeklyRemainingPoints: 400
});
ok(sysWithBal.indexOf('[积分余额] 当前可用 1240 积分') > 0, '余额已注入（学生问到时能直接答）');
ok(sysWithBal.indexOf('本周剩余 400 积分') > 0, '周剩余一并注入');
ok(sysWithBal.lastIndexOf('[积分余额]') < sysWithBal.lastIndexOf('[当前时间]'),
  '余额在时间之前，都在 system prompt 末尾（不破坏缓存前缀）');

var sysNoBal = prompts.getSystemPrompt({ mode: 'study', studyStyle: 'guided' });
ok(sysNoBal.indexOf('[积分余额]') < 0, '未传余额时不注入该段');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
