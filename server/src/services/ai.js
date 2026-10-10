// AI 服务：模型解析 + OpenAI 兼容调用（含流式）
//
// 与 ClassIntra 的差异：Cluss 只保留「对话」这一条主链路（引导式解题），
// 视觉/联网搜索/上下文摘要等能力不进 v1，保持实现精简、故障面小。
// 端点归一化、重试策略沿用 ClassIntra 已验证的规则。

var axios = require('axios');
var db = require('../utils/db');
var time = require('../utils/time');
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

// ------------------------------------------------------------
// 模型源（迁移 022）：地址 / 密钥 / 风格沉到「源」上，一个源供多个模型共享
//
// 选源的模型，连接信息**只认源**，不回退模型自身字段 —— 否则管理员改了源的
// Key、模型上却还留着一份旧 Key 静默胜出，会出现"改了没生效"这种最难查的 bug。
// 不挂源（source_id = ''）的模型继续用自己的 api_url / api_key，
// 存量数据零迁移、行为不变。
// ------------------------------------------------------------
function loadSourcesMap() {
  var map = {};
  try {
    var rows = db.prepare('SELECT * FROM ai_sources').all();
    for (var i = 0; i < rows.length; i++) map[rows[i].id] = rows[i];
  } catch (e) { /* 迁移前该表可能不存在：视为无源，全部回退模型自身字段 */ }
  return map;
}

function getSourceRow(id) {
  if (!id) return null;
  try {
    return db.prepare('SELECT * FROM ai_sources WHERE id = ?').get(String(id)) || null;
  } catch (e) {
    return null;
  }
}

// 列表页/管理台用的源清单（含停用的，前端要能提示"所挂源已停用"）
function listSources() {
  try {
    return db.prepare('SELECT * FROM ai_sources ORDER BY sort_order ASC, id ASC').all();
  } catch (e) {
    return [];
  }
}

function rowToModel(row, source) {
  if (!row) return null;

  var sourceId = String(row.source_id || '');
  var sourceRow = source === undefined ? (sourceId ? getSourceRow(sourceId) : null) : source;
  var useSource = !!(sourceId && sourceRow && sourceRow.enabled !== 0);

  return {
    id: row.id,
    label: row.label,
    // 连接信息：挂源且源可用 → 用源的；否则用模型自身的（源可选，向后兼容）
    apiUrl: useSource ? (sourceRow.api_url || '') : (row.api_url || ''),
    apiKey: useSource ? (sourceRow.api_key || '') : (row.api_key || ''),
    sourceId: sourceId,
    sourceLabel: useSource ? (sourceRow.label || sourceRow.id) : '',
    // 挂了源但源不存在 / 已停用：需要一条明确的不可用原因，而不是含糊的"未配置地址"
    sourceMissing: !!(sourceId && !useSource),
    modelName: row.model_name || row.id,
    apiStyle: (useSource && sourceRow.api_style) ? sourceRow.api_style
      : (row.api_style === 'deepseek' ? 'deepseek' : 'openai'),
    supportsStream: row.supports_stream !== 0,
    // 视觉能力（迁移 003）：能否直接收图片内容块；visionMaxImages=0 表示跟随全局默认
    supportsVision: row.supports_vision === 1,
    visionMaxImages: row.vision_max_images || 0,
    // 深度思考能力：能否用 enable_thinking 参数强制上游先输出思维链。
    // 必须实测标记（管理台表单可勾）：同一个聚合上游下不同模型行为完全不同 ——
    // 实测 deepseek-v4-flash-vision 开启后稳定吐 reasoning，
    // 而 ds-v41 传了也无效（还疑似变慢）。
    supportsThinking: row.supports_thinking === 1,
    price_in: row.price_in || 0,
    price_out: row.price_out || 0,
    price_cache_hit: row.price_cache_hit || 0,
    // 积分策略（迁移 014）：倍率万分比（10000 = 1.0 倍）与限时免费截止
    price_multiplier_bp: row.price_multiplier_bp > 0 ? row.price_multiplier_bp : 10000,
    free_until: row.free_until || '',
    is_free: row.is_free === 1,
    is_default: row.is_default === 1,
    // 峰谷（迁移 022）：逐模型声明是否参与、自己的峰窗与折扣。
    // has_offpeak 用 undefined 表达"该数据没有这个字段"（纯计算/旧调用），
    // 与 0（管理员明确关闭）区分开 —— pricing 依赖这个区分。
    has_offpeak: row.has_offpeak === undefined || row.has_offpeak === null
      ? undefined : Number(row.has_offpeak),
    offpeak_peak_windows: row.offpeak_peak_windows || '',
    offpeak_discount_bp: row.offpeak_discount_bp || 0,
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

var healthMod = null;

function health() {
  healthMod = healthMod || require('../utils/model-health');
  return healthMod;
}

function getModelHealth(id) {
  return health().getHealthRow(id);
}

// 这个模型现在能不能用
function isModelAvailable(id) {
  return health().getHealthRow(id).health_status !== 'down';
}
// 学生选到坏模型时，替他换一个还能用的
function pickFallbackModel(id) {
  if (!id || isModelAvailable(id)) return null;
  var defId = getDefaultModelId();
  if (!defId || defId === id) return null;
  if (!isModelAvailable(defId)) return null;
  return getModelRow(defId);
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

function resolveModel(modelId) {
  var row = getModelRow(modelId);
  if (!row) return null;
  var mc = rowToModel(row);
  mc.endpoint = normalizeEndpoint(mc.apiUrl);
  mc.ready = !!(mc.endpoint && mc.apiKey);
  if (!mc.ready) {
    // 挂了源但源不存在/停用时，给出这条更具体的原因 ——
    // 说"未配置 API 地址"会把管理员引向错误的方向（模型上的地址明明是好的）
    mc.unavailableReason = mc.sourceMissing
      ? ('所挂模型源「' + mc.sourceId + '」不存在或已停用')
      : (!mc.endpoint ? '未配置 API 地址' : '未配置 API Key');
  }
  return mc;
}

// 对外暴露给前端的模型列表（不泄露 apiKey）
function listModelsForClient() {
  var vision = null;
  try { vision = require('./vision').getVisionConfig(); } catch (e) { vision = null; }
  var pricing = require('./pricing');
  var offpeak = pricing.getOffpeakConfig();
  var offpeakNow = pricing.isInOffpeakWindow(offpeak);
  var nowForOffpeak = new Date();

  var rows = getEnabledModels();
  // 源映射一次性载入：避免每个模型各查一次库（模型多时是 N 次往返）
  var sourcesMap = loadSourcesMap();
  var list = [];
  for (var i = 0; i < rows.length; i++) {
    var m = rowToModel(rows[i], sourcesMap[rows[i].source_id] || null);
    var ready = !!(m.apiUrl && m.apiKey);
    // 熔断的模型不进学生能选的清单。注意与 ready 分开表达：
    // ready 是配置问题（管理员一眼能修），熔断是运行时事实（会自动恢复），
    // 混成一种文案，管理员和学生都不知所措。
    var down = !isModelAvailable(m.id);
    var hRow = getModelHealth(m.id);

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

    // 限免信息（到期自动恢复计费，前端按 free_active 挂「限免」标）
    var freeActive = !m.is_free && pricing.isModelFree(m);
    var freeUntilIso = '';
    if (m.free_until) {
      try { freeUntilIso = time.toISO(m.free_until) || ''; } catch (e) { freeUntilIso = ''; }
    }

    // 该模型此刻的谷时折扣（万分比 → 小数，如 0.5）。**逐模型**解析：
    // 有的模型根本不参与峰谷，全局开关不能替它决定。
    var offpeakBp = pricing.modelOffpeakDiscount(m, offpeak, nowForOffpeak);

    // 健康是最后一道关口：模型被熔断就标记为不可用。
    // 配置类原因（缺 Key / 缺地址）优先展示，那是管理员能立刻修的事。
    list.push({
      id: m.id,
      label: m.label,
      is_free: m.is_free ? 1 : 0,
      // effective_free 是学生端判断文案的依据（免费 = 永久免费 或 限免中）
      free_active: freeActive ? 1 : 0,
      free_until: freeUntilIso,
      effective_free: (m.is_free || freeActive) ? 1 : 0,
      // 倍率只透出倍数（如 1.5），不透出单价 —— 学生端不出现价格概念，
      // 但"这个模型扣积分更快"需要让他知道，否则余额消耗快得莫名其妙
      price_multiplier: Math.round(m.price_multiplier_bp) / 10000,
      is_default: m.is_default ? 1 : 0,
      // 逐模型谷时折扣（0 = 此刻无优惠）。学生端的"优惠时段"提示按**当前选中
      // 的模型**取这个值，而不是全局开关 —— 否则会给不参与峰谷的模型错误地
      // 显示"现在打折"，学生一算账发现没便宜，信任度就掉了。
      offpeak_discount: offpeakBp / 10000,
      available: ready && !down,
      unavailable_reason: down
        ? '这个模型暂时没有回应，已自动切到其他模型'
        : (ready ? '' : (m.sourceMissing ? '所挂模型源不可用' : (m.apiUrl ? '未配置 Key' : '未配置地址'))),
      // 视觉能力透出给前端，用于决定「拍题」入口是否可用
      // 学生能看到的最后一道可见性信息：不说地址与配置细节，
      // 但"能不能用、为什么不能用"必须说清 —— 选到不可用的模型直接掉满意度
      health_status: hRow.health_status,
      availability_tip: down
        ? '这个模型最近没有回应，已自动替你换其他模型'
        : (hRow.fail_count >= 1 ? '最近偶有失败，正在观察' : ''),
      supports_vision: m.supportsVision ? 1 : 0,
      vision_via_relay: visionViaRelay ? 1 : 0,
      vision_available: visionCapable && ready && !down ? 1 : 0,
      // 深度思考能力：1 = 前端可显示「深度思考」开关，且开启后真的会吐思维链。
      // 由管理员在模型表单里实测后勾选（见 supports_thinking 说明），
      // 不靠文档猜测 —— 同一上游里不同模型的参数支持完全不一样。
      supports_thinking: m.supportsThinking ? 1 : 0
    });
  }

  // 顶层 offpeak 保留（老前端兼容）：语义是「全局默认配置此刻是否处于谷时」。
  // 真正的逐模型优惠在 models[].offpeak_discount，前端应优先用它。
  return { models: list, offpeak: offpeakNow ? { discount: offpeak.discountBp / 10000 } : null };
}

function buildRequestOptions(model, messages, options) {
  var headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + model.apiKey
  };

  // 会话标识：告诉上游"这一轮属于同一个对话"。
  //
  // 为什么必须传：web 反代类上游（deepseek-web2api 等）会把 OpenAI 的无状态
  // 请求映射成 DeepSeek 的**有状态会话**，而映射键来自这个标识。
  // 不传的后果实测有三条，都会真的发生：
  //   1. 每次请求新建一路 DeepSeek 会话 —— 账号的会话列表被灌满一次性对话
  //   2. 拿不到上游的前缀缓存，每轮全量重算，慢且贵
  //   3. 上游会把"整段历史每轮重发一遍"看在眼里（平方级膨胀），
  //      在其风控视角下像机器人刷屏，**有被禁言的风险**
  //
  // 传 conversationId 而不是 studentId：一个学生可能有多个对话，
  // 用学生 ID 会让它们共享同一路上游上下文，互相串味。
  //
  // 这个头是 web2api 约定的（它优先读 X-Conversation-Id，其次读 body.user）。
  // 对不认识它的标准上游只是个被忽略的自定义头，无副作用。
  if (options && options.conversationId) {
    headers['X-Conversation-Id'] = String(options.conversationId);
  }

  var body = {
    model: model.modelName,
    messages: messages,
    stream: !!(options && options.stream)
  };
  if (options && typeof options.temperature === 'number') {
    body.temperature = options.temperature;
  }
  // 输出长度上限：由调用方按场景给（见 prompt-registry 的 outputCapFor）。
  //
  // 为什么必须透传到请求体而不是只在提示词里写"请简短"：
  //   提示词是**请求**，max_tokens 才是**保证**。实测存在单轮 completion_tokens
  //   18431 的样本（14.9 积分），提示词对这种跑飞毫无约束力。
  // 为什么条件化而不是写死：不同场景的"合理长度"差一个数量级
  //   （闲聊几百 token vs 作文几千 token），写死一个值必然在某一端断掉。
  // 上游不认识这个字段时会被忽略，无副作用。
  if (options && Number(options.maxTokens) > 0) {
    body.max_tokens = Math.floor(Number(options.maxTokens));
  }
  // 深度思考开关：用户在前端点开「深度思考」时，对**实测支持**的模型
  // （supports_thinking=1）透传 enable_thinking=true。为什么条件化：
  // 实测发现这个参数不是所有模型都认 —— 传错的模型有的直接忽略，
  // 有的反而拖慢首字。只对确认支持的模型生效，其余模型视为不支持、
  // 前端也不会显示开关（见 listModelsForClient 透出的 supports_thinking）。
  if (options && options.thinking && model.supportsThinking) {
    body.enable_thinking = true;
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
//
// onReasoning(text)：模型「想的内容」（reasoning_content / reasoning）逐块透出。
//   为什么必须透出：推理型模型在给正文之前会先流式输出一大段思考过程，
//   实测默认模型在难题上要 14 秒才吐出正文第一个字。这段 thinking 若直接丢掉，
//   学生看到的就是"点了发送 → 干等 14 秒"，多半会以为卡死而反复点或关掉。
//
// onStall(ms)：首个令牌迟迟不来的熔断回调。上游「连得上但永远不出东西」
//   是最伤的一种故障 —— HTTP 200 已经返回，前端 SSE 一直开着，
//   学生能盯着"正在思考"看满 5 分钟（axios 超时是 300s）。
//   这里单独用一条看门狗提前掐断，并把失败交给上层走「不计费 + 可重试」的降级。
function chatStream(model, messages, handlers) {
  var opts = buildRequestOptions(model, messages, {
    stream: true,
    // handlers 挂在调用方（turn-runner）上，把会话 ID 透传给上游做会话复用
    conversationId: handlers && handlers.conversationId,
    // 深度思考：turn-runner 已判过「用户开了 + 模型支持」，这里只透传
    thinking: !!(handlers && handlers.thinking),
    // ⚠️ 输出上界必须在这里**显式转发**。这里是白名单式构造 options，
    //    调用方传了但没在此列出的键会被静默丢弃 —— 那种坑的表现是
    //    "代码里写了 max_tokens，线上却一点没生效"，排查代价极高。
    maxTokens: handlers && handlers.maxTokens
  });
  var controller = new AbortController();
  var buffer = '';
  var usage = null;
  var fullText = '';
  var fullReasoning = '';

  // 首令牌看门狗：默认 45 秒。取值理由 —— 正常模型首字在 1~5 秒，
  // 推理模型预热也就 10 秒上下；45 秒还一字未出基本可以判定上游废了，
  // 再等下去只是让学生干耗（而且会一直占着连接池）。
  var STALL_MS = Number(process.env.AI_FIRST_TOKEN_TIMEOUT_MS) || 45000;
  var gotAnyToken = false;
  var stalled = false;
  var watchdog = setTimeout(function() {
    if (gotAnyToken) return;
    stalled = true;
    console.warn('[AI] 模型 %s 在 %dms 内未返回任何内容，主动中断', model.id, STALL_MS);
    try { controller.abort(); } catch (e) {}
    if (handlers && handlers.onStall) handlers.onStall(STALL_MS);
  }, STALL_MS);

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
            if (!delta) continue;

            // 思维链：各家字段名不统一，两种都认（reasoning_content 是 DeepSeek 系，
            // reasoning 是 OpenAI 兼容层的另一种写法）。拿到就立刻透出去，
            // 让前端在正文到来之前就有东西可显示 —— 等待感直接转化为"它在推演"。
            var think = delta.reasoning_content || delta.reasoning || (delta.thinking && delta.thinking.content) || '';
            if (think) {
              gotAnyToken = true;
              fullReasoning += think;
              if (handlers && handlers.onReasoning) handlers.onReasoning(think);
            }

            if (delta.content) {
              gotAnyToken = true;
              fullText += delta.content;
              if (handlers && handlers.onDelta) handlers.onDelta(delta.content);
            }
          }
        }
      });

      resp.data.on('end', function() {
        clearTimeout(watchdog);
        resolve({ text: fullText, reasoning: fullReasoning, usage: usage });
      });
      resp.data.on('error', function(err) {
        clearTimeout(watchdog);
        // 看门狗自己掐断的：给一句学生能懂、且有出路的错误，
        // 而不是抛一句网络层术语（他既看不懂也不知道该干嘛）
        if (stalled) {
          reject(makeStallError(STALL_MS));
          return;
        }
        reject(normalizeUpstreamError(err));
      });
    });
  }).catch(function(err) {
    clearTimeout(watchdog);
    if (stalled) throw makeStallError(STALL_MS);
    throw normalizeUpstreamError(err);
  });

  return {
    promise: promise,
    abort: function() {
      clearTimeout(watchdog);
      try { controller.abort(); } catch (e) {}
    }
  };
}

// 「模型连上了但一个字都不出」的专用错误
// 单独造一个是为了让编排层能认出它：这类失败**不该扣学生的积分**（什么都没生成），
// 而且提示里要明确给出下一步动作（换模型 / 再问一次），
// 而不是抛一句他也看不懂的网络层术语。
function makeStallError(ms) {
  var err = new Error('这个模型迟迟没有回应。可以点「停止生成」换个模型再问一次。');
  err.code = 'AI_STALLED';
  err.status = 504;
  err.stallMs = ms;
  return err;
}

module.exports = {
  normalizeEndpoint: normalizeEndpoint,
  getEnabledModels: getEnabledModels,
  getModelRow: getModelRow,
  getDefaultModelId: getDefaultModelId,
  resolveModel: resolveModel,
  listModelsForClient: listModelsForClient,
  // 模型源（迁移 022）
  getSourceRow: getSourceRow,
  loadSourcesMap: loadSourcesMap,
  listSources: listSources,
  rowToModel: rowToModel,
  chatOnce: chatOnce,
  chatStream: chatStream,
  normalizeUpstreamError: normalizeUpstreamError,
  getModelHealth: getModelHealth,
  isModelAvailable: isModelAvailable,
  pickFallbackModel: pickFallbackModel
};