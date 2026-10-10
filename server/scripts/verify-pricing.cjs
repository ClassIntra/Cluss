// 积分策略计费验证（纯函数级，不依赖服务与数据库）
//
// 覆盖 pricing.js 的计费语义：
//   1. 基准价：任何模型按**默认模型单价**折基础价，倍率是相对默认的价格比
//   2. 缓存命中/未命中拆分（回归，确认策略层没破坏原口径）
//   3. 限免：free_until 生效中 → 0；到期 → 自动恢复计费；is_free 恒为 0
//   4. 倍率：万分比换算（×1.20 / ×1.5 / ×0.5）；默认模型强制 ×1
//   5. 峰谷：跨午夜窗口、当天窗口的边界（含"结束时刻不算谷"）、折扣叠加
//
// 用法：node scripts/verify-pricing.cjs    （退出码 0 = 通过）
//
// 为什么不放进 verify-v2：那是集成脚本，要先起服务与 mock 上游；
// 计费策略是纯函数，单测级别就能把边界钉死，跑得快也跑得勤。
//
// 关于 base 参数：calcCostMicro(model, usage, policy, now, base) 的 base
// 缺省时会去查默认模型（碰数据库）。本脚本必须不碰库，所以每个用例都
// 显式传 base（null = 回退按模型自身单价），恰好也把「基准优先」钉成了契约。

var assert = require('assert');
var pricing = require('../src/services/pricing');

var pass = 0;
var fail = 0;

function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' — ' + e.message);
  }
}

// 与 turn-runner 同款 usage 形状
var USAGE = { prompt_tokens: 1000, completion_tokens: 500, cache_hit_tokens: 400 };

// 基准单价（= 默认模型的三档单价，微元/千 token）
//   命中 400 → 400×500/1000 = 200；未命中 600 → 600×2000/1000 = 1200；
//   输出 500 → 500×8000/1000 = 4000；合计 5400 微元
var BASE_PRICES = { price_in: 2000, price_out: 8000, price_cache_hit: 500 };

// 峰谷策略（DeepSeek 官方口径）：高峰 09:00–12:00 / 14:00–18:00，谷时（峰外）五折
var OFFPEAK_DS = {
  enabled: true,
  peaks: [{ startMin: 540, endMin: 720 }, { startMin: 840, endMin: 1080 }],
  discountBp: 5000
};
var NO_OFFPEAK = { enabled: false };

// 一个非默认模型：自身单价故意与基准不同（证明计费读基准、不读自己）
var MODEL_B = Object.assign({}, BASE_PRICES, {
  price_in: 90000, price_out: 90000, price_cache_hit: 90000,
  price_multiplier_bp: 10000
});

console.log('\n=== 基准价（相对默认模型） ===');

ok('基础计费按基准单价，无视模型自身单价', function() {
  assert.strictEqual(pricing.calcCostMicro(MODEL_B, USAGE, NO_OFFPEAK, undefined, BASE_PRICES), 5400);
});

ok('×1.20（12000 bp）= 基准 × 1.2', function() {
  var m = Object.assign({}, MODEL_B, { price_multiplier_bp: 12000 });
  assert.strictEqual(pricing.calcCostMicro(m, USAGE, NO_OFFPEAK, undefined, BASE_PRICES), 6480);
});

ok('默认模型即基准：自身单价被采用，倍率字段强制 ×1', function() {
  var def = Object.assign({}, BASE_PRICES, {
    is_default: 1,
    price_multiplier_bp: 20000   // 残留的非 1 倍率不允许悄悄作用于全站
  });
  assert.strictEqual(pricing.calcCostMicro(def, USAGE, NO_OFFPEAK, undefined, BASE_PRICES), 5400);
});

ok('基准缺失（base=null）回退按模型自身单价（兼容旧数据）', function() {
  // 90000 微元/千：命中 400→36000，未命中 600→54000，输出 500→45000，合计 135000
  assert.strictEqual(pricing.calcCostMicro(MODEL_B, USAGE, NO_OFFPEAK, undefined, null), 135000);
});

console.log('\n=== 缓存拆分回归（base=null 口径） ===');

ok('缓存命中/未命中/输出三段合计', function() {
  assert.strictEqual(pricing.calcCostMicro(BASE_PRICES, USAGE, NO_OFFPEAK, undefined, null), 5400);
});

ok('免费模型恒为 0（策略字段都在也归零）', function() {
  var m = Object.assign({}, BASE_PRICES, { is_free: 1, price_multiplier_bp: 20000 });
  assert.strictEqual(pricing.calcCostMicro(m, USAGE, OFFPEAK_DS), 0);
});

console.log('\n=== 限免 ===');

ok('free_until 在未来 → 免费', function() {
  var m = Object.assign({}, MODEL_B, { free_until: '2099-01-01 00:00:00' });
  assert.strictEqual(pricing.calcCostMicro(m, USAGE, NO_OFFPEAK, undefined, BASE_PRICES), 0);
  assert.strictEqual(pricing.isModelFree(m, '2098-12-31 23:59:59'), true);
});

ok('free_until 已过 → 自动恢复计费（无需定时任务）', function() {
  var m = Object.assign({}, MODEL_B, { free_until: '2020-01-01 00:00:00' });
  assert.strictEqual(pricing.calcCostMicro(m, USAGE, NO_OFFPEAK, undefined, BASE_PRICES), 5400);
  assert.strictEqual(pricing.isModelFree(m, '2020-01-01 00:00:01'), false);
});

ok('截止时刻当刻仍算免费（闭区间）', function() {
  var m = Object.assign({}, MODEL_B, { free_until: '2026-10-08 16:00:00' });
  assert.strictEqual(pricing.isModelFree(m, '2026-10-08 16:00:00'), true);
  assert.strictEqual(pricing.isModelFree(m, '2026-10-08 16:00:01'), false);
});

ok('is_free 与 free_until 任一命中即免费', function() {
  assert.strictEqual(pricing.isModelFree({ is_free: 1 }, '2099-01-01 00:00:00'), true);
  assert.strictEqual(pricing.isModelFree({ is_free: 0, free_until: '2099-01-01 00:00:00' }, '2099-01-01 00:00:00'), true);
  assert.strictEqual(pricing.isModelFree({ is_free: 0 }, '2099-01-01 00:00:00'), false);
});

console.log('\n=== 倍率 ===');

ok('×1.5 倍（15000 bp）', function() {
  var m = Object.assign({}, MODEL_B, { price_multiplier_bp: 15000 });
  assert.strictEqual(pricing.calcCostMicro(m, USAGE, NO_OFFPEAK, undefined, BASE_PRICES), 8100);
});

ok('×0.5 向下取整方向正确', function() {
  var m = Object.assign({}, MODEL_B, { price_multiplier_bp: 5000 });
  assert.strictEqual(pricing.calcCostMicro(m, USAGE, NO_OFFPEAK, undefined, BASE_PRICES), 2700);
});

ok('×1.00 不重复取整（与无倍率严格相等）', function() {
  assert.strictEqual(pricing.calcCostMicro(MODEL_B, USAGE, NO_OFFPEAK, undefined, BASE_PRICES), 5400);
});

console.log('\n=== 峰谷（峰窗口 + 峰外折扣） ===');

function localDate(h, min) {
  return new Date(2026, 9, 4, h, min, 0);   // 本地时区 2026-10-04
}

ok('DeepSeek 官方窗口：10:30 / 15:00 在峰内，12:30（午休）/ 18:30 / 03:00 在谷内', function() {
  assert.strictEqual(pricing.isInOffpeakWindow(OFFPEAK_DS, localDate(10, 30)), false);
  assert.strictEqual(pricing.isInOffpeakWindow(OFFPEAK_DS, localDate(15, 0)), false);
  assert.strictEqual(pricing.isInOffpeakWindow(OFFPEAK_DS, localDate(12, 30)), true);
  assert.strictEqual(pricing.isInOffpeakWindow(OFFPEAK_DS, localDate(18, 30)), true);
  assert.strictEqual(pricing.isInOffpeakWindow(OFFPEAK_DS, localDate(3, 0)), true);
});

ok('窗口边界：09:00 整算峰（左闭），12:00 整算谷（右开）', function() {
  assert.strictEqual(pricing.isInOffpeakWindow(OFFPEAK_DS, localDate(9, 0)), false);
  assert.strictEqual(pricing.isInOffpeakWindow(OFFPEAK_DS, localDate(12, 0)), true);
});

ok('峰窗口折扣只作用于谷时：03:00 五折 → 2700，10:30 原价 → 5400', function() {
  assert.strictEqual(pricing.calcCostMicro(MODEL_B, USAGE, OFFPEAK_DS, localDate(3, 0), BASE_PRICES), 2700);
  assert.strictEqual(pricing.calcCostMicro(MODEL_B, USAGE, OFFPEAK_DS, localDate(10, 30), BASE_PRICES), 5400);
});

ok('跨午夜峰窗口（08:30 → 00:30）：00:15 / 12:00 在峰内，03:00 在谷内', function() {
  var nightPeak = { enabled: true, peaks: [{ startMin: 510, endMin: 30 }], discountBp: 5000 };
  assert.strictEqual(pricing.isInOffpeakWindow(nightPeak, localDate(0, 15)), false);
  assert.strictEqual(pricing.isInOffpeakWindow(nightPeak, localDate(12, 0)), false);
  assert.strictEqual(pricing.isInOffpeakWindow(nightPeak, localDate(3, 0)), true);
});

ok('谷时折扣叠加倍率：5400 ×1.5 → 8100，谷时再五折 → 4050', function() {
  var m = Object.assign({}, MODEL_B, { price_multiplier_bp: 15000 });
  // 显式注入谷内时刻：生产语义是"按结算时刻定峰谷"，测试可注入
  assert.strictEqual(pricing.calcCostMicro(m, USAGE, OFFPEAK_DS, localDate(12, 30), BASE_PRICES), 4050);
});

ok('限免优先于一切：谷内也只收 0', function() {
  var m = Object.assign({}, MODEL_B, {
    free_until: '2099-01-01 00:00:00',
    price_multiplier_bp: 15000
  });
  assert.strictEqual(pricing.calcCostMicro(m, USAGE, OFFPEAK_DS, localDate(3, 0), BASE_PRICES), 0);
});

ok('无峰窗口视为未配置（不折扣）', function() {
  var empty = { enabled: true, peaks: [], discountBp: 5000 };
  assert.strictEqual(pricing.isInOffpeakWindow(empty, localDate(3, 0)), false);
});

ok('策略关闭时不打折', function() {
  var m = Object.assign({}, MODEL_B, { price_multiplier_bp: 15000 });
  assert.strictEqual(pricing.calcCostMicro(m, USAGE, NO_OFFPEAK, localDate(3, 0), BASE_PRICES), 8100);
});

console.log('\n=== 配置解析 ===');

ok('HH:MM 解析与兜底', function() {
  assert.strictEqual(pricing.parseHm('22:05', -1), 1325);
  assert.strictEqual(pricing.parseHm('6:00', -1), 360);
  assert.strictEqual(pricing.parseHm('bad', -1), -1);
  assert.strictEqual(pricing.parseHm('24:00', -1), -1);
  assert.strictEqual(pricing.parseHm('', -1), -1);
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
