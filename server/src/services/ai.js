// AI 服务：模型解析 + OpenAI 兼容调用（含流式）
//
// 与 ClassIntra 的差异：Cluss 只保留「对话」这一条主链路（引导式解题），
// 视觉/联网搜索/上下文摘要等能力不进 v1，保持实现精简、故障面小。
// 端点归一化、重试策略沿用 ClassIntra 已验证的规则。

var axios = require('axios');
var db = require('../utils/db');
var config = require('../config');

var MAX_RETRIES = 2;
var RETRY_DELAY = 1000;
var RETRYABLE_STATUS = [429, 500, 502, 503, 504];

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// OpenAI 兼容端点归一化：
//   https://api.x.com          → https://api.x.com/v1/chat/completions
//   https://api.x.com/v1       → https://api.x.com/v1/chat/completions
//   https://api.x.com/v1/chat/completions → 原样
function normalizeEndpoint(url) {
  var u = String(url || '').trim();
  if (!u) return u;
  u = u.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+[a-z]*$/i.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

function rowToModel(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    apiUrl: row.api_url,
    apiKey: row.api_key,
    modelName: row.model_name || row.id,
    apiStyle: row.api_style === 'deepseek' ? 'deepseek' : 'openai',
    supportsStream: row.supports_stream !== 0,
    // 视觉能力（迁移 003）：能否直接收图片内容块；visionMaxImages=0 表示跟随全局默认
    supportsVision: row.supports_vision === 1,
    visionMaxImages: row.vision_max_images || 0,
    price_in: row.price_in || 0,
    price_out: row.price_out || 0,
    price_cache_hit: row.price_cache_hit || 0,
    is_free: row.is_free === 1,
    is_default: row.is_default === 1,
    enabled: row.enabled === 1
  };
}

function getEnabledModels() {
  return db.prepare('SELECT * FROM ai_models WHERE enabled = 1 ORDER BY sort_order ASC, id ASC').all();
}

function getModelRow(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM ai_models WHERE id = ?').get(String(id));
}

function getDefaultModelId() {
  // ORDER BY 不能省：一旦库里出现**两个** is_default=1（管理台之外的脚本、
  // 或并发改配置都可能造成），没有排序时返回哪一行是不确定的 ——
  // 表现就是"同一个请求有时走 mock、有时走真实模型"，极难排查。
  // 这里用 sort_order + id 定序，保证结果稳定可预期。
  var row = db.prepare(
    'SELECT id FROM ai_models WHERE is_default = 1 AND enabled = 1 ORDER BY sort_order ASC, id ASC LIMIT 1'
  ).get();
  if (row) return row.id;
  var any = db.prepare('SELECT id FROM ai_models WHERE enabled = 1 ORDER BY sort_order ASC LIMIT 1').get();
  return any ? any.id : '';
}

// 解析为可直接调用的模型配置（含可用性判定）
function resolveModel(modelId) {
  var row = getModelRow(modelId);
  if (!row) return null;
  var mc = rowToModel(row);
  mc.endpoint = normalizeEndpoint(mc.apiUrl);
  mc.ready = !!(mc.endpoint && mc.apiKey);
  if (!mc.ready) {
    mc.unavailableReason = !mc.endpoint ? '未配置 API 地址' : '未配置 API Key';
  }
  return mc;
}

// 对外暴露给前端的模型列表（不泄露 apiKey）
function listModelsForClient() {
  var vision = null;
  try { vision = require('./vision').getVisionConfig(); } catch (e) { vision = null; }

  var rows = getEnabledModels();
  var list = [];
  for (var i = 0; i < rows.length; i++) {
    var m = rowToModel(rows[i]);
    var ready = !!(m.apiUrl && m.apiKey);

    // 能否用于看图：模型自身支持视觉，或配置了可用的转述模型
    var visionCapable = m.supportsVision;
    var visionViaRelay = false;
    if (!visionCapable && vision && vision.enabled && vision.relayModelId) {
      if (vision.relayModelId !== m.id) {
        var relay = resolveModel(vision.relayModelId);
        // 必须同时看 enabled：停用的转述模型不该再让主模型"看起来能看图"，
        // 否则学生会看到拍题入口可用、点进去才失败
        if (relay && relay.enabled && relay.ready && relay.supportsVision) {
          visionCapable = true;
          visionViaRelay = true;
        }
      }
    }

    list.push({
      id: m.id,
      label: m.label,
      is_free: m.is_free ? 1 : 0,
      is_default: m.is_default ? 1 : 0,
      available: ready,
      unavailable_reason: ready ? '' : (m.apiUrl ? '未配置 Key' : '未配置地址'),
      // 视觉能力透出给前端，用于决定「拍题」入口是否可用
      supports_vision: m.supportsVision ? 1 : 0,
      vision_via_relay: visionViaRelay ? 1 : 0,
      vision_available: visionCapable && ready ? 1 : 0
    });
  }
  return list;
}

function buildRequestOptions(model, messages, options) {
  var headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + model.apiKey
  };
  var body = {
    model: model.modelName,
    messages: messages,
    stream: !!(options && options.stream)
  };
  if (options && typeof options.temperature === 'number') {
    body.temperature = options.temperature;
  }
  if (body.stream) {
    // 让上游在流末尾回 usage（OpenAI 兼容端点默认不带）
    body.stream_options = { include_usage: true };
  }
  return { headers: headers, body: body };
}

// 非流式调用（含重试）
function chatOnce(model, messages, options) {
  var opts = buildRequestOptions(model, messages, options);
  var attempt = 0;

  function run() {
    return axios.post(model.endpoint, opts.body, {
      headers: opts.headers,
      timeout: (options && options.timeout) || 120000
    }).then(function(resp) {
      return resp.data;
    }).catch(function(err) {
      var status = err.response && err.response.status;
      if (RETRYABLE_STATUS.indexOf(status) !== -1 && attempt < MAX_RETRIES) {
        attempt++;
        var wait = RETRY_DELAY * attempt;
        console.warn('[AI] 上游 ' + status + '，' + wait + 'ms 后重试（第 ' + attempt + ' 次）');
        return sleep(wait).then(run);
      }
      throw normalizeUpstreamError(err);
    });
  }

  return run();
}

// 把上游错误转成用户可读的中文
function normalizeUpstreamError(err) {
  var status = err.response && err.response.status;
  var detail = '';
  if (err.response && err.response.data) {
    var d = err.response.data;
    if (typeof d === 'string') detail = d.slice(0, 200);
    else if (d.error && d.error.message) detail = String(d.error.message).slice(0, 200);
    else if (d.message) detail = String(d.message).slice(0, 200);
  }

  var message = 'AI 服务暂时不可用，请稍后重试';
  if (status === 401) message = 'AI 服务认证失败，请联系管理员检查模型配置';
  else if (status === 402) message = '上游账户余额不足，请联系管理员';
  else if (status === 404) message = 'AI 模型地址无效，请联系管理员检查配置';
  else if (status === 429) message = 'AI 服务请求过于频繁，请稍后再试';
  else if (status >= 500) message = 'AI 服务暂时不可用，请稍后重试';
  else if (err.code === 'ECONNABORTED') message = 'AI 响应超时，请重试';
  else if (!err.response) message = '无法连接 AI 服务，请检查网络';

  var out = new Error(message);
  out.status = status || 0;
  out.detail = detail;
  return out;
}

// 流式调用：返回 { stream } —— 调用方逐块消费
// onDelta(text) 会在每个增量片段到达时调用；resolve 时给出 usage
function chatStream(model, messages, handlers) {
  var opts = buildRequestOptions(model, messages, { stream: true });
  var controller = new AbortController();
  var buffer = '';
  var usage = null;
  var fullText = '';

  var promise = axios.post(model.endpoint, opts.body, {
    headers: opts.headers,
    timeout: 300000,
    responseType: 'stream',
    signal: controller.signal
  }).then(function(resp) {
    return new Promise(function(resolve, reject) {
      resp.data.on('data', function(chunk) {
        buffer += chunk.toString('utf8');

        // SSE 以空行分隔事件
        var parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (var i = 0; i < parts.length; i++) {
          var lines = parts[i].split('\n');
          for (var j = 0; j < lines.length; j++) {
            var line = lines[j].trim();
            if (!line || line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;

            var json;
            try { json = JSON.parse(payload); } catch (e) { continue; }

            // 用量块（stream_options 生效时由上游在最后给出）
            if (json.usage) usage = json.usage;

            var delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (delta && delta.content) {
              fullText += delta.content;
              if (handlers && handlers.onDelta) handlers.onDelta(delta.content);
            }
          }
        }
      });

      resp.data.on('end', function() {
        resolve({ text: fullText, usage: usage });
      });
      resp.data.on('error', function(err) {
        reject(normalizeUpstreamError(err));
      });
    });
  }).catch(function(err) {
    throw normalizeUpstreamError(err);
  });

  return {
    promise: promise,
    abort: function() {
      try { controller.abort(); } catch (e) {}
    }
  };
}

module.exports = {
  normalizeEndpoint: normalizeEndpoint,
  getEnabledModels: getEnabledModels,
  getModelRow: getModelRow,
  getDefaultModelId: getDefaultModelId,
  resolveModel: resolveModel,
  listModelsForClient: listModelsForClient,
  chatOnce: chatOnce,
  chatStream: chatStream,
  normalizeUpstreamError: normalizeUpstreamError
};