// 定价计算
//
// 口径与 ClassIntra 完全一致（便于两套系统对账时不需要换算）：
//   单价字段：微元 / 千 token；金额字段：微元（1 元 = 1e6 微元）
//   1 元/百万 token = 1000 微元/千 token
//
// 缓存命中语义（重要，涉及会不会重复计费）：
//   上游返回的 prompt_tokens 通常已包含 cache_hit 部分（如 DeepSeek）。
//   若直接把 prompt 全按 price_in 算，就会对命中部分重复收费。
//   所以命中部分按 price_cache_hit 单独算，未命中部分按 price_in 算；
//   未配 price_cache_hit（=0）时命中部分回落按 price_in，不欠费也不错收。
//
// ---- 积分策略（乘在基础价之上，依次两层）----
//   0) 基准价：**默认模型**的三档单价是全站计费锚点。任何模型（含默认自己）
//      的用量都先按默认模型单价折成基础价，再乘该模型的倍率 ——
//      倍率因此是「相对默认模型的价格比」（×1.20 = 比默认贵 20%），
//      管理员调基准价即全站调价，逐模型只需维护一个数字。
//   1) 模型倍率：ai_models.price_multiplier_bp（万分比，10000 = ×1.00）。
//      默认模型固定 ×1（它就是基准，倍率字段对它无意义，计费侧强制归一）。
//   2) 峰谷折扣：**逐模型**可声明是否参与（迁移 022）。参与的模型用自己
//      的峰窗与折扣；模型未声明时回退 cluss_meta 里那份全局配置（它同时
//      是新模型的默认值）—— 按 DeepSeek 官方口径，高峰 09:00–12:00、
//      14:00–18:00，低谷（其余时段）约半价。判定用服务器本地时间 ——
//      峰谷是面向 "学生什么时候用" 的墙上时间概念，库里流水照旧存 UTC。
//      为什么下沉到模型级：峰谷政策是逐模型不同的，全局一刀切会给
//      根本没有谷时价的上游凭空打折（少收积分），账就漂了。
//   免费模型（永久免费或限免中）在这些层之前直接归零。
//
//   结算时点语义：一轮对话可能跨过峰谷边界（22:00 前发起、22:01 结束），
//   以**结算时刻**（calcCostMicro 被调用时）为准。简单、可预期，
//   误差至多一轮，不值得为它把整轮计费拆成两段。

function perThousand(priceMicro, tokens) {
  // 先乘后除，保留整数精度；priceMicro 是「每千 token 的微元数」
  return Math.round((Number(priceMicro || 0) * Number(tokens || 0)) / 1000);
}

// ------------------------------------------------------------
// 限免判定（纯函数）
//
// model.free_until 是 UTC 'YYYY-MM-DD HH:MM:SS'，与 nowUtc() 同口径，
// 字符串字典序比较即可判断是否到期（SQLite 日期格式的天然优势）。
// 限免到期**自动**恢复计费：判定是读取时惰性进行的，无需定时任务。
// ------------------------------------------------------------
function isModelFree(model, nowUtcStr) {
  if (!model) return false;
  if (model.is_free) return true;

  var until = String(model.free_until || '').trim();
  if (!until) return false;

  var now = nowUtcStr || require('../utils/time').nowUtc();
  return now <= until;
}

// ------------------------------------------------------------
// 峰谷配置（cluss_meta，与视觉配置同一套机制，改完即时生效）
//
// policy: { enabled, peaks: [{ startMin, endMin }, ...], discountBp }
//   peaks        忙时（峰）窗口，1~2 个，可跨午夜；折扣作用于**峰外**的闲时
//   discountBp   万分比（5000 = 5 折）
//
// 为什么按「峰时段」而不是「谷时段」配置：DeepSeek 官方峰谷是两段高峰
// （09:00–12:00、14:00–18:00），午休 12:00–14:00 属于低谷 —— 单个谷时段
// 窗口表达不了"谷被峰从中间豁开"的形状；配峰窗口、谷取补集才自然。
// ------------------------------------------------------------
function parseHm(s, fallback) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return fallback;
  var h = parseInt(m[1], 10);
  var min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

function parseDiscountBp(v, fallback) {
  var n = Number(v);
  if (!isFinite(n) || n <= 0 || n > 10000) return fallback;
  return Math.round(n);
}

// 解析峰窗口 JSON（'[{ "start": "09:00", "end": "12:00" }, ...]'），最多取 2 个
function parsePeakWindows(raw) {
  try {
    var arr = JSON.parse(String(raw || ''));
    if (!Array.isArray(arr)) return null;
    var out = [];
    for (var i = 0; i < arr.length && out.length < 2; i++) {
      var w = arr[i] || {};
      var s = parseHm(w.start, -1);
      var e = parseHm(w.end, -1);
      if (s < 0 || e < 0 || s === e) return null;
      out.push({ startMin: s, endMin: e });
    }
    return out.length ? out : null;
  } catch (e) {
    return null;
  }
}

// DeepSeek 官方峰谷口径：高峰 09:00–12:00、14:00–18:00（低谷约半价）
var DEFAULT_PEAK_WINDOWS = [
  { startMin: 9 * 60, endMin: 12 * 60 },
  { startMin: 14 * 60, endMin: 18 * 60 }
];

function getOffpeakConfig() {
  // meta 表在迁移前可能还不存在（如独立调用本模块的脚本）：兜底为「关闭」
  var getMeta;
  try { getMeta = require('../utils/init-db').getMeta; } catch (e) { getMeta = null; }
  function read(key, fallback) {
    if (!getMeta) return fallback;
    var v = getMeta(key, null);
    return v === null || v === undefined || v === '' ? fallback : v;
  }

  var peaks = parsePeakWindows(read('offpeak_peak_windows', ''));
  if (!peaks) {
    // 旧配置兼容：谷时段 [S,E) 五折 ⇔ 峰时段取补集 [E,S)（可跨午夜）
    var s = parseHm(read('offpeak_start', ''), -1);
    var e = parseHm(read('offpeak_end', ''), -1);
    if (s >= 0 && e >= 0 && s !== e) peaks = [{ startMin: e, endMin: s }];
  }
  if (!peaks) peaks = DEFAULT_PEAK_WINDOWS;

  return {
    enabled: read('offpeak_enabled', '0') === '1',
    peaks: peaks,
    discountBp: parseDiscountBp(read('offpeak_discount_bp', ''), 5000)
  };
}

// 写入峰谷配置（admin 路由已校验格式）：峰窗口以 'HH:MM' JSON 原样入库
function setOffpeakConfig(patch) {
  var setMeta = require('../utils/init-db').setMeta;
  setMeta('offpeak_enabled', patch.enabled ? '1' : '0');
  setMeta('offpeak_peak_windows', JSON.stringify(patch.peaks || []));
  setMeta('offpeak_discount_bp', String(patch.discountBp));
}

// 当前分钟是否落在任一峰窗口内（跨午夜窗口取或逻辑）
function inPeakWindow(peaks, cur) {
  for (var i = 0; i < peaks.length; i++) {
    var s = peaks[i].startMin;
    var e = peaks[i].endMin;
    if (s < e) {
      if (cur >= s && cur < e) return true;
    } else if (cur >= s || cur < e) {
      return true;   // 跨午夜（如 08:30 → 00:30）
    }
  }
  return false;
}

// 是否处于谷时段（即折扣生效期）＝ 启用且**不在**任何峰窗口内（纯函数；
// date 用服务器本地时间，缺省取当前时刻）
function isInOffpeakWindow(policy, date) {
  if (!policy || !policy.enabled) return false;
  if (!policy.peaks || !policy.peaks.length) return false;
  var d = date || new Date();
  var cur = d.getHours() * 60 + d.getMinutes();
  return !inPeakWindow(policy.peaks, cur);
}

// ------------------------------------------------------------
// 模型级峰谷策略（迁移 022）
//
// 峰谷**不是所有模型都有** —— 上游的峰谷政策逐模型不同。所以"参不参与峰谷、
// 峰窗是什么、打几折"要逐模型声明，全局那份 cluss_meta 配置降级为
// 「未声明时的默认值 / 兜底」。
//
// model 上的三个字段（迁移 022 加列）：
//   has_offpeak           0 = 不参与；1 = 参与；**undefined = 未声明**
//   offpeak_peak_windows  该模型峰窗 JSON（'' → 回退全局）
//   offpeak_discount_bp   该模型谷时折扣万分比（0 → 回退全局）
//
// 为什么把 undefined 与 0 分开（很关键）：
//   0 是管理员的**明确意图**（"这个模型不参与峰谷"）；
//   undefined 是"这条数据压根没有这个字段"（纯计算场景传入的字面量、
//   独立调用本模块的老脚本）。把 undefined 也当成"不参与"，会让所有
//   显式传 policy 的历史用法静默失去峰谷 —— 所以 undefined 一律沿用
//   全局策略，等价于迁移前行为。
// ------------------------------------------------------------
function offpeakPolicyForModel(model, globalPolicy) {
  var g = globalPolicy === undefined ? getOffpeakConfig() : globalPolicy;

  // 未声明：沿用全局（旧数据 / 纯计算场景，行为与迁移前一致）
  if (!model || model.has_offpeak === undefined) return g;
  // 明确不参与：返回关闭态（下游 isInOffpeakWindow 会直接短路 false）
  if (Number(model.has_offpeak) !== 1) return { enabled: false, peaks: [], discountBp: 0 };

  var peaks = parsePeakWindows(model.offpeak_peak_windows);
  if (!peaks) peaks = (g && g.peaks && g.peaks.length) ? g.peaks : DEFAULT_PEAK_WINDOWS;

  var discountBp = parseDiscountBp(model.offpeak_discount_bp, 0);
  if (!discountBp) discountBp = (g && g.discountBp) || 5000;

  return { enabled: true, peaks: peaks, discountBp: discountBp };
}

// 该模型此刻是否正享受谷时折扣（返回折扣万分比；0 = 无折扣）。
// 学生端与看板都从这里取，保证"能看到优惠"与"实际按优惠算"同源。
function modelOffpeakDiscount(model, globalPolicy, now) {
  var p = offpeakPolicyForModel(model, globalPolicy);
  if (!isInOffpeakWindow(p, now)) return 0;
  if (!(p.discountBp > 0) || p.discountBp >= 10000) return 0;
  return p.discountBp;
}


// ------------------------------------------------------------
// 基准单价：默认模型的三档单价
//
// 为什么基准放在默认模型上：管理员调价的高频动作是「全站整体调」——
// 改默认模型的单价即可，其他模型的倍率含义不变；若各模型各自维护单价，
// 相对关系会随上游调价散架。
//
// 惰性 require('./ai')：ai 顶层 require 了 pricing，加载期互引会出环；
// 调用期 ai 早已加载完毕，安全。基准缺失（无默认模型或其单价全为 0，
// 如全新安装尚未配价）时返回 null，计费回退按模型自身单价 —— 兼容旧数据。
// ------------------------------------------------------------
function getBasePrices() {
  try {
    var ai = require('./ai');
    var id = ai.getDefaultModelId();
    var row = id ? ai.getModelRow(id) : null;
    if (row && ((row.price_in || 0) > 0 || (row.price_out || 0) > 0)) {
      return {
        price_in: row.price_in || 0,
        price_out: row.price_out || 0,
        price_cache_hit: row.price_cache_hit || 0
      };
    }
  } catch (e) { /* 库未就绪等异常：回退模型自身单价，不阻断计费 */ }
  return null;
}

// ------------------------------------------------------------
// 计费主入口
//
// policy / now / base 可选：峰谷策略、结算时刻、基准单价（缺省分别读
// cluss_meta、用当前时刻、解析默认模型单价）。生产调用前两者都不传 ——
// 「以结算时刻定峰谷」的语义就落在缺省路径上；纯计算场景（测试、
// 复算历史账单）显式传入，不依赖运行时的库内配置。base 传 null 表示
// 跳过基准解析、直接按模型自身单价算（测试保持不碰数据库）。
//
// 乘法精度：微元 × 万分比两次相乘最坏 ~1e18 会超出 JS 整数安全域（2^53），
// 所以倍率与折扣各自「乘一次、取整一次」，每步都留在安全域内。
// ------------------------------------------------------------
function calcCostMicro(model, usage, policy, now, base) {
  if (!model) return 0;
  if (isModelFree(model)) return 0;

  var prices = base === undefined ? getBasePrices() : base;
  if (!prices) prices = model;   // 基准缺失：回退按模型自身单价（兼容旧数据）

  var promptTokens = Number(usage.prompt_tokens || 0);
  var completionTokens = Number(usage.completion_tokens || 0);
  var cacheHit = Number(usage.cache_hit_tokens || 0);

  var cacheHitPrice = Number(prices.price_cache_hit || 0) || Number(prices.price_in || 0);
  var hitPart = Math.min(cacheHit, promptTokens);
  var missPart = Math.max(0, promptTokens - hitPart);

  var cost = perThousand(cacheHitPrice, hitPart) +
    perThousand(prices.price_in, missPart) +
    perThousand(prices.price_out, completionTokens);

  // 模型倍率（万分比）。默认模型强制 ×1：它就是基准，倍率对它没有意义，
  // 万一管理台残留了非 1 倍率也不能让它悄悄作用于全站。
  var multBp = model.is_default ? 10000 : Number(model.price_multiplier_bp || 0);
  if (multBp > 0 && multBp !== 10000) {
    cost = Math.round(cost * multBp / 10000);
  }

  // 谷时段折扣（万分比）—— 按**模型级**峰谷策略解析（迁移 022）：
  // 模型可声明"不参与峰谷"，或自带峰窗与折扣；未声明时沿用全局配置。
  var p = policy;
  if (p === undefined) p = getOffpeakConfig();
  p = offpeakPolicyForModel(model, p);
  if (isInOffpeakWindow(p, now) && p.discountBp > 0 && p.discountBp < 10000) {
    cost = Math.round(cost * p.discountBp / 10000);
  }

  return cost;
}

// 上游未回 usage 时的估算：按字符类型分桶折算 token。
//
// 为什么不能只用一个系数：中文、英文、符号的 token 密度差得很远 ——
// 中文约 0.58 token/字符，英文字母约 0.18，数字与标点约 0.62。
// 原来统一用 len/2.5，实测（以 deepseek2api 自带的 DeepSeek tokenizer 为基准，
// 10 个覆盖中/英/混排/Markdown/代码/公式/数字的样本）：
//
//   系数                  合计偏差   平均绝对误差   最差单个样本
//   len/2.5（旧）          -7.0%      45.6%        117%
//   中文/其他 两桶          -5.5%      31.7%         75%
//   中文/字母/其他 三桶      +0.4%      14.6%         40%   ← 现在这个
//
// 旧的"合计偏差"看着不大，是因为中文的低估与英文的高估互相抵消了 ——
// 但**单个请求**的误差高达 117%（纯英文被多算一倍多）。合计好看、个体失真是
// 计费类逻辑里最糟的一种错，因为学生看到的正好是单个请求的账单。
//
// 注意：这仍然是估算。真正准确的做法是用上游返回的 usage，
// 只有拿不到时才回退到这里（见 turn-runner 里的 estimated 标记）。
var CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g;
var LETTER_RE = /[A-Za-z]/g;

function estimateTokens(text) {
  var s = String(text || '');
  if (!s) return 1;

  var cjk = (s.match(CJK_RE) || []).length;
  var letters = (s.match(LETTER_RE) || []).length;
  var other = s.length - cjk - letters;

  return Math.max(1, Math.round(0.58 * cjk + 0.18 * letters + 0.62 * other));
}

module.exports = {
  isModelFree: isModelFree,
  getOffpeakConfig: getOffpeakConfig,
  setOffpeakConfig: setOffpeakConfig,
  isInOffpeakWindow: isInOffpeakWindow,
  offpeakPolicyForModel: offpeakPolicyForModel,
  modelOffpeakDiscount: modelOffpeakDiscount,
  getBasePrices: getBasePrices,
  parseHm: parseHm,
  parsePeakWindows: parsePeakWindows,
  calcCostMicro: calcCostMicro,
  estimateTokens: estimateTokens
};
