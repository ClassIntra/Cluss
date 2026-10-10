/**
 * 计费量化：把「缓存恒定化 + 输出上限」这两项优化换算成积分。
 *
 * 数据源：cluss_usage_log 真实流水（只读）。
 * 单价口径：取自 ai_models 的 price_in / price_cache_hit / price_out（微元/1k token）。
 *   —— 1 积分 = 10000 微元 = 0.01 元。
 *
 * ⚠️ 这个脚本给出的是**模型外推**，不是实测账单。两处必须看清：
 *   1) 缓存那一项假设"恒定前缀在下一轮真的命中上游缓存"。上游缓存有 TTL 与
 *      最小块粒度，实际命中率会低于 100% —— 所以脚本同时给出 50% / 100% 两档。
 *   2) 输出上限那一项是**硬上界**，只要 max_tokens 生效就是确定收益。
 *
 * 用法：
 *   export PYTHONPATH=""; unset NODE_OPTIONS; export PATH="/c/Program Files/nodejs:$PATH"
 *   cd server && node scripts/measure-cost.cjs
 */
'use strict';

var path = require('path');

// 必须先加载 .env：config/index.js 在 require 时强校验 JWT_SECRET，缺了直接退出。
// 顺序不能反（dotenv 不覆盖已存在的 process.env）。
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

var Database = require('better-sqlite3');

var DB = process.env.DB_PATH || path.resolve(__dirname, '..', 'database', 'cluss.db');
var db = new Database(DB, { readonly: true, fileMustExist: true });

var prompts = require('../src/services/prompt-registry');
var pricing = require('../src/services/pricing');

// ---- 单价：以默认模型为准（全站计费锚点）----
var base = db.prepare(
  'SELECT price_in, price_out, price_cache_hit FROM ai_models WHERE is_default = 1 LIMIT 1'
).get() || { price_in: 2000, price_out: 8000, price_cache_hit: 40 };

var P_IN = Number(base.price_in || 0);
var P_OUT = Number(base.price_out || 0);
var P_HIT = Number(base.price_cache_hit || 0) || P_IN;

function micro2pt(m) { return (Number(m) / 10000).toFixed(3); }

console.log('计价基准（默认模型）：输入 ' + P_IN + ' / 缓存命中 ' + P_HIT + ' / 输出 ' + P_OUT + ' 微元每千 token');
console.log('  → 输出单价是输入的 ' + (P_OUT / P_IN).toFixed(1) + ' 倍；命中价是输入价的 1/' + Math.round(P_IN / P_HIT));
console.log('  → 1 积分 = 10000 微元\n');

// ---------------------------------------------------------------------------
// 现状
// ---------------------------------------------------------------------------
var rows = db.prepare(
  'SELECT prompt_tokens p, completion_tokens c, cache_hit_tokens h, cost_micro cm, source s FROM cluss_usage_log'
).all();

var n = rows.length;
var sumP = 0, sumC = 0, sumH = 0, sumCost = 0;
for (var i = 0; i < n; i++) {
  sumP += Number(rows[i].p || 0);
  sumC += Number(rows[i].c || 0);
  sumH += Number(rows[i].h || 0);
  sumCost += Number(rows[i].cm || 0);
}

console.log('=== 现状（' + n + ' 轮真实流水）===');
console.log('  平均输入 ' + Math.round(sumP / n) + ' tk / 平均输出 ' + Math.round(sumC / n) + ' tk');
console.log('  缓存命中率 ' + (sumH / Math.max(1, sumP) * 100).toFixed(1) + '% (' + sumH + '/' + sumP + ')');
console.log('  总成本 ' + micro2pt(sumCost) + ' 积分（平均 ' + micro2pt(sumCost / n) + ' 积分/轮）\n');

// 成本构成：输入 vs 输出
var costIn = (sumP - sumH) * P_IN / 1000 + sumH * P_HIT / 1000;
var costOut = sumC * P_OUT / 1000;
console.log('=== 成本构成 ===');
console.log('  输入侧 ' + micro2pt(costIn) + ' 积分（' + (costIn / (costIn + costOut) * 100).toFixed(1) + '%）');
console.log('  输出侧 ' + micro2pt(costOut) + ' 积分（' + (costOut / (costIn + costOut) * 100).toFixed(1) + '%）\n');

// ---------------------------------------------------------------------------
// 杠杆一：输出上限
// ---------------------------------------------------------------------------
var CAP = { chat: 3072, solve: 4096, writing: 6144 };
var savedOut = 0, trimmed = 0;
for (var j = 0; j < n; j++) {
  var s = String(rows[j].s || 'chat');
  var cap = CAP[s] || CAP.chat;
  var c = Number(rows[j].c || 0);
  if (c > cap) { savedOut += (c - cap) * P_OUT / 1000; trimmed++; }
}
console.log('=== 杠杆一：输出上限（max_tokens）===');
console.log('  会被截断的轮数：' + trimmed + ' / ' + n + '（' + (trimmed / n * 100).toFixed(1) + '%）');
console.log('  直接省下 ' + micro2pt(savedOut) + ' 积分（占总成本 ' +
  (savedOut / sumCost * 100).toFixed(1) + '%） —— 这是**确定收益**（只要 max_tokens 生效）\n');

// ---------------------------------------------------------------------------
// 杠杆二：恒定前缀命中缓存
// ---------------------------------------------------------------------------
// 取一个代表性场景的恒定段长度（引导式单题 + 附件护栏，最接近拍题主路径）
var parts = prompts.getSystemPromptParts({
  mode: 'study', studyStyle: 'guided', taskKind: 'single', hasAttachment: true
});
var stableTk = pricing.estimateTokens(parts.stable);

console.log('=== 杠杆二：system 恒定段进缓存 ===');
console.log('  恒定段 ' + parts.stable.length + ' 字符 ≈ ' + stableTk + ' tk（改造前它夹着每轮变化的段，无法命中）');
console.log('  变化段 ' + parts.dynamic.length + ' 字符 ≈ ' + pricing.estimateTokens(parts.dynamic) + ' tk（已移出 system）');

// 投影：每轮 prompt 中前 stableTk 个 token 命中缓存
function project(hitRatio) {
  var mi = 0;
  for (var k = 0; k < n; k++) {
    var p = Number(rows[k].p || 0);
    var hit = Math.min(stableTk, p) * hitRatio + Number(rows[k].h || 0);
    if (hit > p) hit = p;
    mi += (p - hit) * P_IN / 1000 + hit * P_HIT / 1000;
  }
  return mi;
}
var nowIn = costIn;
var p100 = project(1);
var p50 = project(0.5);

console.log('  输入侧成本：现状 ' + micro2pt(nowIn) + ' 积分');
console.log('    若恒定段 100% 命中 → ' + micro2pt(p100) + ' 积分（省 ' +
  micro2pt(nowIn - p100) + '，' + ((nowIn - p100) / nowIn * 100).toFixed(0) + '%）');
console.log('    若恒定段 50%  命中 → ' + micro2pt(p50) + ' 积分（省 ' +
  micro2pt(nowIn - p50) + '，' + ((nowIn - p50) / nowIn * 100).toFixed(0) + '%）\n');

console.log('=== 合计（相对现状的总成本 ' + micro2pt(sumCost) + ' 积分）===');
console.log('  输出上限（确定）        : -' + micro2pt(savedOut) + ' 积分');
console.log('  + 缓存 100% 命中（乐观）: -' + micro2pt(nowIn - p100) + ' 积分  → 合计 -' +
  micro2pt(savedOut + nowIn - p100) + ' 积分（-' + ((savedOut + nowIn - p100) / sumCost * 100).toFixed(0) + '%）');
console.log('  + 缓存  50% 命中（保守）: -' + micro2pt(nowIn - p50) + ' 积分  → 合计 -' +
  micro2pt(savedOut + nowIn - p50) + ' 积分（-' + ((savedOut + nowIn - p50) / sumCost * 100).toFixed(0) + '%）');
console.log('\n  平均每轮：' + micro2pt(sumCost / n) + ' → ' +
  micro2pt((sumCost - savedOut - (nowIn - p50)) / n) + ' ~ ' +
  micro2pt((sumCost - savedOut - (nowIn - p100)) / n) + ' 积分/轮');

db.close();
