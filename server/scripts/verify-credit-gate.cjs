/**
 * 额度闸门并发穿透回归（credit.js recordUsage 事务内余额校验）
 *
 * 复现的漏洞：checkGate 只是**发起前**的快照判定，一笔 AI 调用要跑几十秒。
 * 余额剩 1.2 积分时并发开 N 个请求，每个都读到 1.2、都通过闸门，
 * 各自真实计费后余额穿底。修复前余额能被扣成 -9.4，修复后只放行最先返回的那笔。
 *
 * 跑法：node server/scripts/verify-credit-gate.cjs
 * 会自建临时库，不碰 server/database/cluss.db。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// 用临时库，绝不碰真实数据库。
// 变量名是 DB_PATH（见 src/config/index.js），不是 CLUSS_DB_PATH。
// dotenv 默认不覆盖已存在的环境变量，所以这里设的值优先于 .env。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-credit-'));
const tmpDb = path.join(tmpDir, 'test.db');
process.env.DB_PATH = tmpDb;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-gate-verify';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-pw';

let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ ' + msg); failed++; }
}

const credit = require('../src/services/credit');
const db = require('../src/utils/db');
const time = require('../src/utils/time');

// 临时库是空的，必须先跑迁移建表（真实库里这些表早就有了）
require('../src/utils/init-db').initDatabase();

const UID = '__concurrent_user__';
// 10 元额度 = 10000000 微元
const ALLOC = 10000000;
// 单笔 2 元 = 2000000 微元。5 笔并发 = 10 元，正好把额度打穿
const COST = 2000000;

function reset() {
  db.prepare('DELETE FROM cluss_usage_log WHERE user_id = ?').run(UID);
  db.prepare('DELETE FROM cluss_credit WHERE user_id = ?').run(UID);
}

function allocate() {
  db.prepare(
    'INSERT INTO cluss_credit (user_id, allocated_micro, weekly_quota_micro, updated_at, assigned_by) VALUES (?, ?, ?, ?, ?)'
  ).run(UID, ALLOC, 0, time.nowUtc(), 'test');
}

// 一个「收费模型」：is_free=0、单价按 1 微元/token 计
function paidModel() {
  return { id: 'paid-1', is_free: 0, free_until: '' };
}

console.log('\n[1] 单笔正常记账应成功');
reset();
allocate();
var r1 = credit.recordUsage({
  user_id: UID, conversation_id: 'c1', model_id: 'paid-1',
  model: paidModel(), cost_micro: COST,
  prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, source: 'chat'
});
ok(r1 && r1.ok === true, '首笔入账成功');
ok(r1 && typeof r1.id === 'number' && r1.id > 0, '返回 lastInsertRowid');
var st1 = credit.getState(UID);
ok(st1.available_micro === ALLOC - COST, '余额正确扣减，实际 ' + st1.available_micro);

console.log('\n[2] 并发穿透：连打 5 笔，只应放行到余额为正为止');
reset();
allocate();
// 模拟 5 个请求同时通过了「发起前」的闸门，各自独立调用 recordUsage
var results = [];
for (var i = 0; i < 5; i++) {
  results.push(credit.recordUsage({
    user_id: UID, conversation_id: 'c' + i, model_id: 'paid-1',
    model: paidModel(), cost_micro: COST,
    prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, source: 'chat'
  }));
}
var admitted = results.filter(function (x) { return x && x.ok === true; });
var refused = results.filter(function (x) { return x && x.ok === false; });
ok(admitted.length === 5, '额度足够时（10元/2元×5）全部放行，实际放行 ' + admitted.length);

reset();
allocate();
// 把额度调到只够 2 笔：4 元
db.prepare('UPDATE cluss_credit SET allocated_micro = ? WHERE user_id = ?').run(COST * 2, UID);
results = [];
for (var j = 0; j < 5; j++) {
  results.push(credit.recordUsage({
    user_id: UID, conversation_id: 'd' + j, model_id: 'paid-1',
    model: paidModel(), cost_micro: COST,
    prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, source: 'chat'
  }));
}
admitted = results.filter(function (x) { return x && x.ok === true; });
refused = results.filter(function (x) { return x && x.ok === false; });
ok(admitted.length === 2, '额度只够 2 笔时恰好放行 2 笔，实际 ' + admitted.length);
ok(refused.length === 3, '其余 3 笔被拒，实际 ' + refused.length);

var st2 = credit.getState(UID);
ok(st2.available_micro === 0, '余额精确停在 0 而非负数，实际 ' + st2.available_micro);
ok(st2.available_micro >= 0, '余额没有穿底（本次修复的核心断言）');
ok(refused[0].reason === 'exhausted', '拒绝原因为 exhausted，实际 ' + refused[0].reason);

// 关键断言：账本行数必须等于放行笔数，拒的笔绝不能留下痕迹
var rows = db.prepare('SELECT COUNT(*) AS n FROM cluss_usage_log WHERE user_id = ?').get(UID);
ok(rows.n === admitted.length,
  '账本行数 == 放行笔数（被拒的不入账），实际 ' + rows.n + ' vs ' + admitted.length);

console.log('\n[3] 未分配额度不应入账');
reset();
// 不 allocate
var r3 = credit.recordUsage({
  user_id: '__never_alloc__', conversation_id: 'c', model_id: 'paid-1',
  model: paidModel(), cost_micro: COST,
  prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'chat'
});
ok(r3 && r3.ok === false, '未开通账号被拒');
ok(r3 && r3.reason === 'not_allocated', '原因为 not_allocated，实际 ' + (r3 && r3.reason));

console.log('\n[4] 免费/限免模型不受余额闸门约束');
reset();
var r4 = credit.recordUsage({
  user_id: UID, conversation_id: 'c', model_id: 'free-1',
  model: { id: 'free-1', is_free: 1, free_until: '' },
  cost_micro: 999999, // 免费模型即使算出成本也不该被拦
  prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'chat'
});
ok(r4 && r4.ok === true, '免费模型在无额度情况下仍可入账（明细要留，只是不扣钱）');

reset();
var r4b = credit.recordUsage({
  user_id: UID, conversation_id: 'c', model_id: 'limited',
  model: { id: 'limited', is_free: 0, free_until: '2099-01-01 00:00:00' },
  cost_micro: 500000,
  prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'chat'
});
ok(r4b && r4b.ok === true, '限免期内模型同样不受闸门约束（与 checkGate 同一口径）');

console.log('\n[5] 0 元轮次不应被误拒');
reset();
allocate();
db.prepare('UPDATE cluss_credit SET allocated_micro = ? WHERE user_id = ?').run(1, UID); // 只剩 1 微元
var r5 = credit.recordUsage({
  user_id: UID, conversation_id: 'c', model_id: 'paid-1',
  model: paidModel(), cost_micro: 0,
  prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, source: 'chat'
});
ok(r5 && r5.ok === true, '余额几乎为零但本轮 cost=0 时仍入账（否则明细无故丢失）');

console.log('\n[6] 周限额在写入点兜底');
reset();
allocate();
db.prepare('UPDATE cluss_credit SET allocated_micro = ?, weekly_quota_micro = ? WHERE user_id = ?')
  .run(ALLOC, COST * 2, UID);
var w1 = credit.recordUsage({
  user_id: UID, conversation_id: 'w1', model_id: 'paid-1',
  model: paidModel(), cost_micro: COST,
  prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'chat'
});
var w2 = credit.recordUsage({
  user_id: UID, conversation_id: 'w2', model_id: 'paid-1',
  model: paidModel(), cost_micro: COST,
  prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'chat'
});
var w3 = credit.recordUsage({
  user_id: UID, conversation_id: 'w3', model_id: 'paid-1',
  model: paidModel(), cost_micro: COST,
  prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'chat'
});
ok(w1.ok === true && w2.ok === true, '周限额内两笔放行');
ok(w3.ok === false && w3.reason === 'weekly_exhausted',
  '第 3 笔被周限额拒（即使总额度还剩很多），实际 ' + (w3.reason || 'ok'));

console.log('\n[7] checkGate 语义未被改动（回归）');
reset();
ok(!!credit.checkGate('__none__', { is_free: 0 }), '未开通账号仍被闸门拦下');
allocate();
ok(credit.checkGate(UID, paidModel()) === null, '额度充足时闸门放行');
// 闸门放行「余额刚好为 0」的末次请求 —— 这是原有语义，必须保持
db.prepare('UPDATE cluss_credit SET allocated_micro = ? WHERE user_id = ?').run(COST, UID);
credit.recordUsage({
  user_id: UID, conversation_id: 'z', model_id: 'paid-1',
  model: paidModel(), cost_micro: COST,
  prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'chat'
});
ok(credit.checkGate(UID, paidModel()) !== null, '余额归零后闸门拦下（学生侧行为不变）');

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
console.log('临时库：' + tmpDb);

try { db.close(); } catch (e) {}
if (failed === 0) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }
process.exit(failed === 0 ? 0 : 1);