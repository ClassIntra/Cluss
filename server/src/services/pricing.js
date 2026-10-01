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

function perThousand(priceMicro, tokens) {
  // 先乘后除，保留整数精度；priceMicro 是「每千 token 的微元数」
  return Math.round((Number(priceMicro || 0) * Number(tokens || 0)) / 1000);
}

// usage: { prompt_tokens, completion_tokens, cache_hit_tokens }
// model: { price_in, price_out, price_cache_hit }
function calcCostMicro(model, usage) {
  if (!model) return 0;
  if (model.is_free) return 0;

  var promptTokens = Number(usage.prompt_tokens || 0);
  var completionTokens = Number(usage.completion_tokens || 0);
  var cacheHit = Number(usage.cache_hit_tokens || 0);

  var cacheHitPrice = Number(model.price_cache_hit || 0) || Number(model.price_in || 0);
  var hitPart = Math.min(cacheHit, promptTokens);
  var missPart = Math.max(0, promptTokens - hitPart);

  return perThousand(cacheHitPrice, hitPart) +
    perThousand(model.price_in, missPart) +
    perThousand(model.price_out, completionTokens);
}

// 上游未回 usage 时的粗估：按字符数折算 token
// 中文约 1 字符 ≈ 1 token，英文约 4 字符 ≈ 1 token，这里取折中 2.5
function estimateTokens(text) {
  var len = String(text || '').length;
  return Math.max(1, Math.round(len / 2.5));
}

module.exports = {
  calcCostMicro: calcCostMicro,
  estimateTokens: estimateTokens
};