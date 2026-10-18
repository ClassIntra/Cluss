// 一次对话回合的完整编排 —— 对话链路与学习链路共用的唯一入口
//
// 为什么要有这一层：会话管理、上下文组装、视觉判定、流式、记账这五件事
// 原本全塞在 chat.js 的单个路由函数里。若为学习模式再复制一份，
// 两处的「SSE 收尾」「闸门顺序」「记账字段」必然逐渐不一致。
// 所以统一到这里，路由只剩参数校验与调用。
//
// 固定执行顺序（**顺序本身就是正确性的一部分**）：
//   会话兜底 → 模型解析 → 视觉判定 → 额度闸门 → 附件校验/缩图
//   → 写 SSE 头 → 存档用户消息 → 转述（如需）→ 组装上下文
//   → 流式 → 存档助手消息 → 记账 → done
//
// 关键约束：**所有可能失败的校验都必须在 writeHeaders 之前完成**。
// 一旦写了 SSE 头，HTTP 状态码就固定为 200，错误只能塞进事件流，
// 前端拿到的是「200 但内容是错误」这种别扭结果。

var crypto = require('crypto');
var ai = require('./ai');
var credit = require('./credit');
var pricing = require('./pricing');
var prompts = require('./prompt-registry');
var conv = require('./conversation-core');
var builder = require('./context-builder');
var vision = require('./vision');
var userProfile = require('./user-profile');
// 自定义人格的持久化。与 prompt-registry 的分工：那边管"内置人格定义与渲染"（纯函数），
// 这边管"学生自建人格的存取"。turn-runner 是把两者接起来的地方。
var personaStore = require('./persona-store');
// 对话里自动沉淀长期记忆（后台跑、失败隔离、不阻塞主链路）
var memoryExtractor = require('./memory-extractor');
// ClassIntra 联动桥：用于取"Cluss 自己没有的那一维"画像素材（校园社区活动痕迹）。
// 注意它**不读** ClassIntra 的数据库，只是调用 CI 侧的只读接口（见该文件顶部说明）。
var ciBridge = require('./ci-bridge');
var campusContext = require('./campus-context');
var modelHealth = require('../utils/model-health');
var config = require('../config');

var DEFAULT_CONTEXT_BUDGET = 10000;

function newTraceId() {
  return crypto.randomBytes(8).toString('hex');
}

// ------------------------------------------------------------
// 会话级在途锁
//
// 为什么需要：同一个会话同时跑两轮流式，会在库里留下**两条** streaming=1 的占位行。
// 前端恢复路径（Chat.vue 的 applyServerStreaming）是按"助手消息下标"对齐的，
// 多出一条之后下标整体错位，正文会被写到错的节点上 —— 表现成"答案串行了"。
// 而且两轮各记一次账，学生为同一件事被扣两份积分。
//
// 为什么锁在进程内而不是库里加一列：PM2 是单实例（见 ops 文档）。
// ⚠️ 真要做横向扩容的话这里必须换实现，所以把这句话留在代码里。
//
// 三条防呆（缺一不可）：
//   1. 持有者的 SSE 客户端**已经断开** → 允许接管。
//      这是"点了停止生成又马上重发"的路径：客户端一断 res 的 close 就触发，
//      但上游那一轮未必立刻结束（服务端没有主动 abort），锁还在它手上。
//      此时若死等，学生会觉得"停一下之后就再也发不出去了"。
//   2. TTL 兜底：任何未预期路径漏了释放，10 分钟后自动失效，
//      不让一个陈旧的锁永久堵死这个会话（宁可偶尔放行两次，也不能卡住发不出去）。
//   3. 释放时比对 traceId：被接管的那一轮收尾时**不能**把接管者的锁删掉。
// ------------------------------------------------------------
var IN_FLIGHT_TTL_MS = 10 * 60 * 1000;
var inFlightTurns = new Map();

// 返回 true = 拿到了锁；false = 同一会话已有在途生成，调用方应拒绝本次请求
function acquireTurn(convId, traceId) {
  var id = String(convId);
  var prev = inFlightTurns.get(id);
  if (prev) {
    var expired = Date.now() - prev.startedAt > IN_FLIGHT_TTL_MS;
    var gone = !!(prev.sse && prev.sse.isClientGone && prev.sse.isClientGone());
    if (!expired && !gone) return false;
    console.warn('[Turn] 会话 %s 上一轮仍在途（trace %s，%s）→ 本次接管',
      id, prev.traceId, expired ? '锁已超时' : '上一个客户端已断开');
  }
  inFlightTurns.set(id, { traceId: traceId, startedAt: Date.now(), sse: null });
  return true;
}

// SSE 写手建好之后回填进去 —— 锁的"持有者是否还活着"靠它判断
function bindTurnSse(convId, traceId, sse) {
  var cur = inFlightTurns.get(String(convId));
  if (cur && cur.traceId === traceId) cur.sse = sse;
}

function releaseTurn(convId, traceId) {
  var id = String(convId);
  var cur = inFlightTurns.get(id);
  if (cur && cur.traceId === traceId) inFlightTurns.delete(id);
}

// 只给验证脚本用：确认没有锁泄漏
function inFlightSnapshot() {
  var out = [];
  inFlightTurns.forEach(function(v, k) { out.push({ conv_id: k, trace_id: v.traceId }); });
  return out;
}

// 统一失败出口：SSE 头未写时返回 JSON，已写时降级为事件
function fail(res, status, message) {
  if (res.headersSent) return false;
  res.status(status).json({ code: status, message: message });
  return true;
}

// 从上游 usage 提取令牌数（兼容 OpenAI 与 DeepSeek 两种缓存字段写法）
function extractUsage(usage, fallbackPromptText, fallbackCompletionText) {
  if (!usage) {
    // 上游没回 usage：按字符数粗估，并打 estimated 标记（非精确账）
    var p = pricing.estimateTokens(fallbackPromptText);
    var c = pricing.estimateTokens(fallbackCompletionText);
    return {
      prompt_tokens: p, completion_tokens: c,
      cache_hit_tokens: 0, cache_miss_tokens: p,
      total_tokens: p + c, estimated: 1
    };
  }
  var promptTokens = Number(usage.prompt_tokens || 0);
  var completionTokens = Number(usage.completion_tokens || 0);
  var cacheHit = Number(
    usage.prompt_cache_hit_tokens ||
    (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0
  );
  cacheHit = Math.min(cacheHit, promptTokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cache_hit_tokens: cacheHit,
    cache_miss_tokens: promptTokens - cacheHit,
    total_tokens: Number(usage.total_tokens || (promptTokens + completionTokens)),
    estimated: 0
  };
}

// 把上下文里的纯文本汇总出来（供上游未回 usage 时估算）
function flattenForEstimate(messages) {
  var out = [];
  for (var i = 0; i < messages.length; i++) {
    var c = messages[i].content;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) {
      for (var j = 0; j < c.length; j++) {
        if (c[j].type === 'text') out.push(c[j].text || '');
      }
    }
  }
  return out.join('\n');
}

// ------------------------------------------------------------
// ctx 说明
//   userId            string
//   res               express response
//   content           string   用户正文（可为空，拍题时可只发图）
//   modelId           string
//   conversation      { id?, mode?, study_style? }
//   attachmentHashes  [string] 云盘文件 hash（图片与文本混排）
//   noteIds           [string] 引用的笔记 id（正文取自云盘 .md）
//     ⚠️ 自迁移 018 起为客户端生成的字符串（'note_<ts>_<rand>'），不是自增整数。
//        这条链路历史上按 number 归一化，导致字符串 id 全变 NaN 被丢弃
//        （见 4.5 步注释）—— 已改为字符串口径，不要改回去。
//     ⚠️ 为什么笔记不走 attachmentHashes：笔记正文虽然也是云盘里的 .md 文件，
//        但它是"学生自己写的东西"，不是外部资料。走独立通道才能用不同的措辞
//        注入（"我引用的笔记" vs "附带的文件"），模型对两者的用法完全不同。
//   task              { kind, requiresImage?, paperMode?, writing? }
//     kind: '' | 'solve' | 'grade' | 'writing_generate' | 'writing_grade' | 'writing_outline'
//     requiresImage: 显式声明「没有图就不许提交」。
//       为什么不用 kind 推断：作文也有图片（看图作文 / 手写稿批改）但图是可选的，
//       靠 kind 前缀判断迟早会误伤新任务类型。
//     writing: { language, genre, style, wordLimit }
//   source            'chat' | 'study' | 'solve' | 'grade' | 'writing'
// ------------------------------------------------------------
function runStreamTurn(ctx) {
  var userId = String(ctx.userId);
  var res = ctx.res;
  var content = String(ctx.content || '').trim();
  var task = ctx.task || { kind: '' };
  var source = String(ctx.source || 'chat');
  var attachmentHashes = Array.isArray(ctx.attachmentHashes) ? ctx.attachmentHashes.filter(Boolean) : [];
  var hasImages = attachmentHashes.length > 0;
  var requiresImage = !!task.requiresImage;
  // 深度思考开关（用户在前端选）：真值时请求上游先输出思维链。
  // 这里只做"用户想不想要"的表达，"这个模型认不认"由 ai.buildRequestOptions
  // 按 supports_thinking 二次把关——包括下面可能发生的熔断换模型，
  // 换到的模型不支持时参数会被自动丢弃，不会把请求打坏。
  var thinking = ctx.thinking === true;

  // 需要图的任务没带图，直接拦（拍题/批改属于这类）
  if (requiresImage && !hasImages) {
    return fail(res, 400, '请先选择题目图片');
  }
  // ⚠️ 空内容判定必须把**引用的笔记**也算作输入 ——
  //   只引了笔记不写字是完全合法的用法（"帮我讲讲这篇笔记"都不用写），
  //   之前这里只看文字和图片，note-only 的请求被误杀
  //   「消息内容不能为空」（实测踩到）。客户端 canSend 早已放行，
  //   服务端这里却拦下，表现为"按钮能点、一发就报错"。
  var hasNotes = Array.isArray(ctx.noteIds) && ctx.noteIds.length > 0;
  if (!task.kind && !content && !hasImages && !hasNotes) {
    return fail(res, 400, '消息内容不能为空');
  }

  var traceId = newTraceId();

  // ---- 1) 模型解析 ----
  // 会话要在解析前拿到，因为会话里存了上次用的模型
  var conversationInput = ctx.conversation || {};
  var convRow = conv.ensureConversation(userId, {
    id: conversationInput.id,
    modelId: ctx.modelId,
    mode: conversationInput.mode,
    studyStyle: conversationInput.study_style,
    // 人格：客户端传了就归一化后落库（'buddy' = 回到默认语气的显式表达，
    // 是有效值），不传（undefined）表示"别动这一列"。
    //
    // ⚠️「只在日常模式生效」的判定已**下沉到 ensureConversation** ——
    //   只有那里同时看得到"客户端想设什么"与"会话本来是什么模式"。
    //   原先在这里用 `conversationInput.mode === 'daily'` 把关，会漏掉
    //   「前端只换人格、没带 mode」的请求：那种情况下改动被静默丢弃，
    //   学生表现为"点了没反应"。
    persona: conversationInput.persona !== undefined
      ? prompts.normalizePersona(conversationInput.persona)
      : undefined,
    // 无限制风格：与 persona 完全同规则（undefined = 别动；
    //   '' = 回到受限，是有效值）。归一化交给 prompt-registry，判据同上了。
    dailyStyle: conversationInput.daily_style !== undefined
      ? prompts.normalizeDailyStyle(conversationInput.daily_style)
      : undefined,
    titleFrom: content || (task.kind === 'grade' ? '作业批改' : '拍题解答'),
    taskKind: task.kind
  });

  var requestedModelId = String(ctx.modelId || convRow.model_id || ai.getDefaultModelId());
  // 模型被熔断时替学生换一个还能用的：他选的是"某个模型"这个功能，
  // 而不是具体的某一家供应商 —— 换过去这件事不该由他承担。
  var fallbackRow = ai.pickFallbackModel(requestedModelId);
  var downgradedFrom = fallbackRow ? requestedModelId : '';
  var effectiveModelId = fallbackRow ? fallbackRow.id : requestedModelId;
  if (downgradedFrom) {
    console.warn('[Turn] 模型 %s 已被熔断，本次自动改用 %s', downgradedFrom, effectiveModelId);
  }
  var model = ai.resolveModel(effectiveModelId);
  // enabled 必须查：resolveModel 只看"有没有地址和 Key"，已停用的模型照样能解析出来。
  // 不查的话，客户端只要显式传一个停用模型的 model_id 就能绕开管理员的停用决定。
  if (!model || !model.enabled) {
    // 「模型」是系统词汇，学生看到"模型不存在"只会困惑。
    // 对他来说这就是"AI 突然用不了了"，刷新一下多半就好。
    console.warn('[Turn] 模型不可用:', effectiveModelId, model ? '（已停用）' : '（不存在）');
    return fail(res, 404, '这个 AI 暂时不可用，请刷新页面后重试');
  }

  // ---- 2) 视觉判定 ----
  // 必须先于闸门：因为走转述时「实际出钱的」是转述模型，
  // 闸门要判的是真正会产生费用的那个模型
  var visionPlan = { mode: 'none', relay: null };
  if (hasImages) {
    visionPlan = vision.resolveVisionMode(model);
    if (visionPlan.mode === 'none') {
      // 技术原因（visionPlan.reason）只记日志，给学生的是人话版本
      console.warn('[Turn] 视觉链路不可用:', visionPlan.reason || '未知');
      return fail(res, 400, visionPlan.studentReason || '当前用的 AI 看不了图片，请联系管理员');
    }
    var maxImages = vision.maxImagesFor(model);
    if (attachmentHashes.length > maxImages) {
      return fail(res, 400, '单次最多 ' + maxImages + ' 张图，你选了 ' + attachmentHashes.length + ' 张');
    }
  }

  // ---- 3) 额度闸门 ----
  // 主模型与转述模型都要过闸门：否则「免费主模型 + 收费转述模型」会被白嫖
  var gateMsg = credit.checkGate(userId, model);
  if (gateMsg) return fail(res, 402, gateMsg);

  if (visionPlan.mode === 'relay' && visionPlan.relay) {
    var relayGate = credit.checkGate(userId, visionPlan.relay);
    if (relayGate) return fail(res, 402, relayGate);
  }

  if (!model.ready) {
    // 「未配置 Key / 未配置地址」是管理员的排查信息，不是给学生的解释。
    // 学生在管理台那边看不到、也改不了，界面上一句"暂时不可用"就够了。
    console.warn('[Turn] AI 服务未就绪:', model.unavailableReason);
    return fail(res, 503, 'AI 服务暂时不可用，请联系管理员');
  }

  // ---- 4) 附件读取与校验（失败可干净返回 400）----
  // 图片与文本分开处理：文本附件不参与视觉链路，直接作为资料注入上下文
  var imageItems = [];
  var textItems = [];
  var imageHashes = [];
  var textHashes = [];
  var attachmentMeta = [];

  if (hasImages) {
    // 先按云盘记录的 mime 分流出图片与文本
    var cloudStore = null;
    try { cloudStore = require('./cloud-store'); } catch (e) { cloudStore = null; }

    for (var h = 0; h < attachmentHashes.length; h++) {
      var hash = String(attachmentHashes[h]);
      var info = cloudStore ? cloudStore.getUserFile(hash, userId) : null;
      if (!info) return fail(res, 400, '附件不存在或无权访问');

      if (cloudStore.isImageMime(info.mime)) {
        imageHashes.push(hash);
        attachmentMeta.push({ hash: hash, name: info.name, mime: info.mime, size: info.size, kind: 'image' });
      } else {
        textHashes.push(hash);
        attachmentMeta.push({ hash: hash, name: info.name, mime: info.mime, size: info.size, kind: 'text' });
      }
    }

    if (imageHashes.length) {
      var loaded = vision.loadImageItems(userId, imageHashes, {});
      if (loaded.error) return fail(res, 400, loaded.error);
      imageItems = loaded.items;
    }
    if (textHashes.length) {
      textItems = vision.loadTextItems(userId, textHashes).texts;
    }

    // 需要图的任务如果所选附件里一张图都没有，明确拒绝并指出问题。
    // 用户可能错把文本文件当题目传上来，此时放行会得到一段「没有题目可解」的胡说。
    if (requiresImage && !imageHashes.length) {
      return fail(res, 400, '所选附件中没有图片。拍题与批改需要图片，请从云盘选择题目照片');
    }
  }

  // ---- 4.5) 笔记引用读取 ----
  // 与附件同阶段（写 SSE 头之前）：笔记不存在/无权访问要能干净返回 400，
  // 不能等到流已经开始了才发现引用的是别人的笔记。
  //
  // ⚠️ 笔记 id 自迁移 018 起是客户端生成的字符串（'note_<ts>_<rand>'），
  //    不是自增整数。这里曾经 map(Number)，'note_xxx' 会变成 NaN 而被 filter 掉，
  //    note_ids 静默变成空数组 —— 笔记正文永远进不了上下文，
  //    表现就是"引用了笔记但模型完全没反应"。旧路由（notes.js）已统一用
  //    noteIdFromParam 的字符串口径，这里保持一致。
  var noteIds = normalizeNoteIds(ctx.noteIds);
  var noteText = '';
  if (noteIds.length) {
    var loadedNotes = loadNoteRefs(userId, noteIds);
    if (loadedNotes.error) return fail(res, 400, loadedNotes.error);
    noteText = loadedNotes.text;
    // 笔记也进 attachmentMeta：历史消息里要留下「当时引用了笔记」的占位，
    // 否则学生下次问「我刚才引的那篇」时，模型在历史里看不到任何痕迹。
    for (var ni = 0; ni < loadedNotes.meta.length; ni++) {
      attachmentMeta.push(loadedNotes.meta[ni]);
    }
  }

  // ---- 5) 图片缩图（在写 SSE 头之前完成，失败回退原图不阻断）----
  var shrinkChain = imageItems.length
    ? vision.shrinkAll(imageItems, null)
    : Promise.resolve([]);

  return shrinkChain.then(function(shrunkItems) {
    // ---- 5.5) 会话级在途互斥 ----
    // 放在写 SSE 头**之前**：409 只能以普通 JSON 返回；一旦写了头，HTTP 状态码
    // 就固定成 200，学生拿到的会是"200 但内容是错误"这种别扭结果。
    //
    // 放在缩图之后是有意的：这一层唯一的职责是阻止"同一会话出现两条占位行"，
    // 而占位行在第 10 步才写。把它提到前面的校验之前，只会让每条错误路径
    // 都得记得放锁 —— 而"记得放锁"正是最容易漏的事。
    if (!acquireTurn(convRow.id, traceId)) {
      return fail(res, 409, '上一条回复还在生成中，等它写完再发；或者先点「停止生成」再重发。');
    }

    // ---- 6) 写 SSE 头（此后不能再改 HTTP 状态码）----
    var sse = conv.createSseWriter(ctx.req, res);
    bindTurnSse(convRow.id, traceId, sse);
    // 把"放锁"和收尾绑死：本轮无论怎么结束（成功 / 失败 / 被上游中断），
    // 只要走到 sse.close() 就一定释放，不依赖每个分支各自记得释放。
    var closeSse = sse.close;
    sse.close = function() { closeSse(); releaseTurn(convRow.id, traceId); };
    sse.headers();

// ---- 6.5) 客户端断开 → 立刻中断上游（不等它跑完）----
    //
    // ⚠️ 这是踩过的真实事故，与「零产出不记账」是同一类问题的另一半：
    //   学生在等首字时关掉页面（推理型模型实测可达 14 秒首字，等得不耐烦很常见），
    //   服务端此前**不会**中断上游：ai.chatStream 返回的 handle.abort 从未被调用，
    //   res 的 close 回调只置一个标志，那个标志只用于判断锁能否被接管。
    //   结果是上游继续跑完、token 继续产生、recordUsage 照常记账 ——
    //   学生什么都没看到，积分照扣。ai.js 的 axios timeout 是 5 分钟，
    //   意味着一个放弃了的学生可以让这个连接占满 5 分钟。
    //
    // 口径与「零产出不记账」一致：**没有交付就不记账**。
    // 上游已烧掉的那点 token 由我方承担 —— 学生看不到的东西让他付钱，
    // 是比多花一次上游调用严重得多的问题。
    //
    // 三个状态变量声明在这一层（而不是下面的流式段里），因为 close 回调
    // 与流式段是两兄弟，改的是同一批变量：放错作用域会出现
    // 「回调改了另一个变量、静默失效」这种最难查的情况。
    //
    // 用 res.writableEnded 区分「正常收尾」与「学生跑了」：
    // 正常收尾也会触发 close，但它先走 sse.close()，那时该标记已置位。
    var upstreamHandle = null;   // 上游句柄：SSE 写出后才赋值，close 回调要靠它 abort
    var turnDone = false;         // 本轮是否已收尾：拦掉已排定的落库定时器
    var flushTimer = null;        // 中间态落库定时器：断开时要清掉
    var clientGone = false;       // 学生是否中途离开：记账时据此不扣费

    res.on('close', function() {
      if (res.writableEnded) return;   // 正常收尾，不是断开
      if (clientGone) return;          // 只处理一次
      clientGone = true;
      turnDone = true;                 // 别让已排定的落库定时器再写
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      console.warn('[Turn] 客户端断开（trace %s），中断上游请求且本轮不计费', traceId);
      if (upstreamHandle && upstreamHandle.abort) {
        try { upstreamHandle.abort(); } catch (e) {}
      }
      // 立刻放锁：学生可能马上重发同一条会话。
      // 不放的话他要等 abort 真正生效（下一个 tick）之后才能重试，
      // 而 abort 是同步调用 controller.abort()，这里放锁是安全的。
      releaseTurn(convRow.id, traceId);
    });

    sse.send('meta', {
      conversation_id: convRow.id,
      model_id: effectiveModelId,
      // 学生选的那个模型被熔断了、我们替他换了 —— 这件事要透明告知：
      // 否则他明明选了"A 模型"却看到"B 模型"的回答，会以为是 Bug。
      downgraded_from: downgradedFrom,
      mode: convRow.mode || 'study',
      study_style: convRow.study_style || 'guided',
      trace_id: traceId
    });

    // ---- 7) 存档用户消息（只存附件元信息，绝不存 base64）----
    conv.appendMessage(convRow.id, 'user', content || tasksDefaultText(task), effectiveModelId, {
      attachments: attachmentMeta,
      source: source
    });

    // ---- 8) 转述（如需）----
    var relayPromise = Promise.resolve(null);
    if (visionPlan.mode === 'relay' && shrunkItems.length) {
      sse.send('status', { stage: 'vision', message: '正在识别图片…', done: 0, total: shrunkItems.length });
      relayPromise = vision.describeImages(visionPlan.relay, shrunkItems, function(done, total, name) {
        sse.send('status', {
          stage: 'vision',
          message: '正在识别图片 ' + done + '/' + total,
          done: done, total: total, name: name
        });
      }).then(function(r) {
        // 转述消耗单独记账（source='vision_relay'），共享同一 trace_id
        if (r.usages && r.usages.length) {
          var relayCost = vision.recordRelayUsage(visionPlan.relay, r.usages, {
            userId: userId,
            conversationId: convRow.id,
            traceId: traceId
          });
          sse.send('status', {
            stage: 'vision_done',
            message: r.succeeded + '/' + r.total + ' 张识别成功',
            cost_micro: relayCost,
            failed: r.failed.length
          });
        }
        return r;
      });
    }

    return relayPromise.then(function(relayResult) {
      // ---- 9) 组装上下文 ----
      var imageDataUrls = [];
      if (visionPlan.mode === 'native') {
        for (var i = 0; i < shrunkItems.length; i++) {
          imageDataUrls.push(vision.toImageDataUrl(shrunkItems[i].buffer, shrunkItems[i].mime));
        }
      }

      // 学生偏好：他在设置里选的回复风格 / 常学科目 / 是否允许参考学习记录。
      // 解析放在这一层而不是各路由：chat / study / writing / notes 全部经由本函数，
      // 这里改一处四条链路一起生效，不必在四个路由里各抄一遍归一化逻辑。
      var studentPrefs = prompts.normalizeStudentPrefs(
        ctx.req && ctx.req.body && ctx.req.body.student_prefs
      );
      // 「参考学习记录」关掉 = 不要用系统从他的使用记录里推断出来的东西
      //（画像 / 校园素材 / 长期记忆）。
      // ⚠️ 关掉时**连取都不取**：只过滤提示词是不够的 —— 那等于每轮仍去算画像、
      //    仍向 ClassIntra 发一次请求，数据照样在流动，开关就成了安慰按钮。
      //    理由与校园开关（campus-context.applyOpt）完全一致。
      var useRecords = studentPrefs.useRecords !== false;

      // 学生画像：让模型知道他在跟谁说话（年级、薄弱学科、常错类型、最近在问什么）。
      // 构建失败只降级为空画像，绝不能因此中断对话。
      var profile = null;
      if (useRecords) {
        try {
          profile = userProfile.buildProfile(userId);
        } catch (e) {
          console.warn('[Turn] 学生画像构建失败（不影响对话）:', e.message);
        }
      }

      // ClassIntra 活动素材：**只读缓存**（同步、零延迟），再"发射后不管"地触发一次
      // 后台刷新，让下一轮对话能用上最新值。
      //
      // 为什么不在这里 await 一次 CI 请求：这是增强项，CI 慢 2 秒学生的首字就慢 2 秒，
      // CI 挂掉还要吃满超时 —— 为一个"锦上添花"把主链路绑上别人的可用性不划算。
      // 代价是"新数据晚一轮生效"，对画像完全可接受。详见 ci-bridge 的说明。
      // refreshStudentProfile **永不抛**，但仍包一层 try：这里的任何异常都不该中断对话。
      //
      // ---- 学生侧的开关（2026-10-12 加）----
      // 学生在设置里可以关掉"让 AI 参考我的校园信息"（整体或逐项）。
      // 关掉后这里**连取都不去取** —— 只过滤提示词是不够的：学生表达的是
      // "不要用我的校园信息"，若仍每轮向 CI 发一次请求，数据还是在流动，
      // 开关就成了安慰按钮。见 campus-context.applyOpt 的说明。
      var ciProfile = null;
      if (useRecords) {
        try {
          var campusOpt = ciBridge.isEnabled() ? campusContext.getOpt(userId) : null;
          if (!campusOpt || campusOpt.enabled) {
            ciProfile = ciBridge.getCachedStudentProfile(userId);
            // 只在"整体开启"时才刷新；逐项关闭不影响刷新（那些项仍可能在别处用）
            ciBridge.refreshStudentProfile(userId);
            ciProfile = campusContext.applyOpt(ciProfile, campusOpt);
          }
        } catch (e) {
          console.warn('[Turn] ClassIntra 画像读取失败（不影响对话）:', e.message);
        }
      }

      // 余额也交给模型一把：学生问「我还有多少积分」时能直接答，
      // 不用让他自己去看侧栏。BASE 第 14 条禁止模型主动播报。
      var walletView = credit.toPointsView(credit.getState(userId));

      // 跨会话记忆：只取与本次提问相关的几条（检索命中，否则退化到最近更新）。
      // 全量塞进上下文既费 token，也会让陈年旧事被当成当前语境。
      // 构建失败只降级为空 —— 记忆是增强项，不该因为它挂掉整轮对话。
      var memories = [];
      if (useRecords) {
        try {
          var memorySvc = require('./memory');
          memories = memorySvc.selectForContext(userId, content, memorySvc.MAX_INJECT);
        } catch (e) {
          console.warn('[Turn] 记忆检索失败（不影响对话）:', e.message);
        }
      }

      // 人格：把会话里存的 id 解析成一条可渲染的记录。
      //   内置 id（buddy/humor/...）→ prompt-registry 自带；
      //   'p:数字' → 该学生自己的自定义人格（从库里取）。
      //   自定义人格取不到（已被删）时 resolvePersona 返回 null，
      //   人格段自然为空 = 回到默认语气，对话照常能开。
      var personaRecord = null;
      if ((convRow.mode || 'study') === 'daily' && convRow.persona) {
        try {
          personaRecord = prompts.resolvePersona(convRow.persona, personaStore.listForResolve(userId));
        } catch (e) {
          console.warn('[Turn] 人格解析失败（回落默认语气）:', e.message);
        }
      }

      var promptOpts = {
        mode: convRow.mode || 'study',
        studyStyle: convRow.study_style || 'guided',
        // 无限制风格：仅日常模式生效。值已在落库时归一化过（'' | 'free'）。
        dailyStyle: (convRow.mode || 'study') === 'daily' ? (convRow.daily_style || '') : '',
        personaRecord: personaRecord,
        taskKind: task.kind === 'solve' ? task.paperMode : task.kind,
        writing: task.writing || null,
        hasAttachment: attachmentMeta.length > 0,
        studentProfile: profile,
        // 学生偏好（他自己在设置里选的）：回复风格 / 常学科目。
        // 与画像分开传：画像可能因"不参考学习记录"被清空，偏好则始终生效
        //（他明确设定的东西不该被"隔离推断数据"的开关一起关掉）。
        studentPrefs: studentPrefs,
        // 本轮是否注入了引用笔记正文（'……' 非空即真）。
        // 画像段里"你并不知道笔记正文"那句要据此改口 —— 不然与注入的
        // 【我引用的笔记】自相矛盾，模型会声称看不到笔记（实测踩到）。
        noteText: noteText,
        // ClassIntra 侧脱敏活动素材（可能为 null = CI 未联动 / 取不到）
        ciProfile: ciProfile,
        memories: memories,
        pointsBalance: walletView.available_points,
        weeklyRemainingPoints: walletView.weekly_unlimited ? null : walletView.weekly_remaining_points
      };

      // 恒定段 / 逐轮变化段分开取（见 prompt-registry 的 getSystemPromptParts）：
      //   stable   → 作为 system 消息。同一会话内逐字节不变，上游前缀缓存才对
      //              **历史消息**也生效（实测未拆前命中率仅 10.2%）。
      //   dynamic  → 画像/CI/记忆/余额/时间。拼到本轮用户消息末尾且**不落库**，
      //              这样 system 不再被它们污染。
      var sysParts = prompts.getSystemPromptParts(promptOpts);
      var systemPrompt = sysParts.stable;
      var trailingContext = sysParts.dynamic;

      // 输出长度硬上限：按场景定档（见 prompt-registry 的 OUTPUT_CAP）。
      // 为什么放在这里算而不是在 ai 层默认：档位取决于"这一轮的产出物本来该有多长"，
      // 只有 turn-runner 同时知道 mode 与 taskKind。
      // 这是防跑飞的**兜底**，不是"逼短"的手段——正常回答碰不到它。
      var outputCap = prompts.outputCapFor(promptOpts);

      var userContent = content || tasksDefaultText(task);
      var taskHint = buildTaskHint(task, imageHashes.length);
      if (taskHint) userContent = taskHint + '\n\n' + userContent;

      // 文本附件拼接
      var textAttachmentText = '';
      if (textItems.length) {
        var chunks = [];
        for (var t = 0; t < textItems.length; t++) {
          chunks.push('【' + textItems[t].name + '】\n' + textItems[t].text +
            (textItems[t].truncated ? '\n（内容过长已截断）' : ''));
        }
        textAttachmentText = chunks.join('\n\n');
      }

      var history = conv.loadContextMessages(
        convRow.id,
        conv.DEFAULT_CONTEXT_MESSAGES
      );
      // 去掉刚写入的这条用户消息（它会被当作本轮输入重新拼装）
      if (history.length && history[history.length - 1].role === 'user') {
        history = history.slice(0, -1);
      }

      var built = builder.buildMessages({
        systemPrompt: systemPrompt,
        history: history,
        userContent: userContent,
        imageDataUrls: imageDataUrls,
        relayText: relayResult ? relayResult.text : '',
        noteText: noteText,
        textAttachmentText: textAttachmentText,
        // 系统注入的背景块（画像/CI/记忆/余额/时间）：拼到本轮用户消息末尾，不落库
        trailingContext: trailingContext,
        budgetTokens: DEFAULT_CONTEXT_BUDGET
      });

      // 会话历史总条数（不受「最近 20 条」限制）—— 前端上下文圆环的分母。
      //
      // 为什么必须单独查一次：loadContextMessages 只取最近 20 条，
      // 拿它当分母的话，聊到第 21 条之后分母就永远卡在 20，
      // 圆环会一直显示 100%（"AI 记得全部"），而实际上更早的内容早就被裁掉了。
      //
      // 减 1：本轮刚落库的那条 user 消息不算「已聊过的历史」，
      // 它正是这一轮要问的东西（loadContextMessages 那边也把它 slice 掉了）。
      // Math.max 兜底：极端情况下（并发/边界）不让分母小于已纳入条数，
      // 否则比例会超过 100%，圆环画出一圈不可能的进度。
      if (built.stats) {
        built.stats.history_total = Math.max(
          built.stats.history_included,
          conv.countMessages(convRow.id) - 1
        );
      }

      // 历史被 token 预算裁掉时，明确告诉模型"你看不到更早的内容"。
      // 不说明的话学生问「刚才那道题」时它会硬编一个答案。
      // 挂在 system 消息末尾而不是 user 正文里，避免污染存档的用户消息。
      var contextNote = prompts.buildContextNote(built.stats);
      if (contextNote && built.messages.length && built.messages[0].role === 'system') {
        built.messages[0].content += contextNote;
      }

      // ---- 10) 流式生成 ----
      var promptText = flattenForEstimate(built.messages);

      // 先**预留**一条助手消息（streaming=1），边生成边把内容写进去。
      // 为什么不等结束再一次性 INSERT：学生切页面 / 关掉应用时，库里必须有
      // "已经写到哪"的中间态，回来（哪怕换了设备）才能接着看。
      // 位置也有讲究：必须在 loadContextMessages 之后，且那条查询已按
      // streaming=0 过滤，双保险防止空占位被当成历史喂回去。
      //
      // 写之前先收敛本会话**遗留**的占位行：走到这里说明在途锁在手上，
      // 这个会话不可能有别的活生成者，所以任何 streaming=1 都是死的
      //（上一轮客户端断开后服务端仍在跑、或上一轮异常收尾没走干净）。
      // 不收敛的话库里会攒出两条 streaming=1，前端按下标对齐就会串行。
      var stale = conv.settleStreamingMessages(convRow.id);
      if (stale.total) {
        console.warn('[Turn] 会话 %s 收敛了 %d 条遗留的"生成中"占位（保留 %d / 删除 %d）',
          convRow.id, stale.total, stale.kept, stale.dropped);
      }

      var assistantMsgId = conv.appendMessage(convRow.id, 'assistant', '', effectiveModelId, {
        attachments: [], source: source, streaming: 1
      });

      // 增量落库要**节流**：better-sqlite3 是同步写，每个token 写一次会阻塞
      // 事件循环，把读取上游那段也一起拖慢 —— 那就本末倒置了。
      // 200ms 一次足够让"切回来看到进度"这件事成立。
      //
      // ⚠️ 但节流只降低频率，**不足以**解决问题：onDelta 跑在同一个事件循环上，
      // 一次同步 UPDATE 执行期间，全班其他人的流式推送全部停摆
      // （content 是完整累加文本，上下文长了就是几万字符的一次写）。
      // 这个症状还会误触发 ai.js 的首令牌看门狗，把好模型误判为卡死而熔断。
      // 所以这里用「定时器 + setImmediate」把写让出当前 tick：
      //   setTimeout —— 已经是节流，不必同步写
      //   setImmediate —— 让 onDelta 先返回，再排到下一轮事件循环执行写
      var accText = '';
      var FLUSH_MS = 200;
      // 中间态落库失败的次数：连续失败说明不是偶发，收尾时要走另一条路
      //（否则这条消息会永远停在 streaming=1，前端每次进来都看到一只转圈的气泡）
      var flushFailed = 0;

      function scheduleFlush() {
        if (flushTimer || turnDone) return;
        flushTimer = setTimeout(function() {
          flushTimer = null;
          if (turnDone) return;
          // 快照当前文本，让出这一 tick 后再写：
          // 期间 accText 可能继续增长，那部分由下一次调度或收尾兜底。
          var snapshot = accText;
          setImmediate(function() {
            if (turnDone) return;
            try { conv.updateMessageContent(assistantMsgId, snapshot); }
            catch (e) { flushFailed++; }
          });
        }, FLUSH_MS);
        if (flushTimer.unref) flushTimer.unref();
      }

      // 句柄同时接到外层，供 res.on('close') 回调 abort 用
      //（ai.js 已经实现了 abort，只是此前从没人调用它）
      var handle = ai.chatStream(model, built.messages, {
        // 让上游按会话复用它那一侧的上下文（详见 buildRequestOptions 里的说明）
        conversationId: convRow.id,
        // 用户开的「深度思考」：只有模型实测支持时 ai 层才会真的透传参数
        thinking: thinking,
        // 输出上界（防跑飞）。实测单轮最高 18431 token / 14.9 积分，
        // 提示词对这类失控没有约束力，只有请求体里的 max_tokens 才有。
        maxTokens: outputCap,
        onDelta: function(text) {
          accText += text;
          sse.send('delta', { text: text });
          scheduleFlush();
        },
        // 思维链单独走一条事件：正文之前那段「正在推演」要有去处，
        // 否则推理型模型的首字延迟（实测难题可达 14 秒）全变成干等。
        onReasoning: function(text) {
          sse.send('reasoning', { text: text });
        },
        // 上游卡住不出字：告诉前端一声，让它把等待提示换成明确的失败提示。
        // 这里不发 error 事件——真正的收尾统一走 .catch，避免发两次。
        onStall: function() {
          console.warn('[Turn] 模型 %s 首令牌超时（trace %s）', effectiveModelId, traceId);
        }
      });
      upstreamHandle = handle;

      return handle.promise.then(function(result) {
        // ---- 11) 错题提取（仅批改）----
        // 模型在批改结果末尾额外输出了一段 <wrong-items>JSON</wrong-items>。
        // 这里把它解出来入错题本，并从正文里剥掉——否则学生会在回复末尾看到一坨 JSON。
        // 解析失败只记日志：拿不到错题是可以接受的降级，不该让整次批改失败。
        var finalText = result.text || '';
        var wrongAdded = 0;
        if (source === 'grade' && finalText) {
          try {
            var wrongBook = require('./wrong-book');
            var extracted = wrongBook.extractAndStrip(finalText);
            finalText = extracted.text;
            if (extracted.items.length) {
              wrongAdded = wrongBook.saveExtracted(extracted.items, {
                userId: userId,
                conversationId: convRow.id,
                // 用第一张题图作为错题的来源图，复习时能原图回看
                imageHash: imageHashes.length ? imageHashes[0] : ''
              });
              if (wrongAdded) {
                // 错题变了，画像缓存立刻失效，下一轮就能带上新的薄弱点
                userProfile.invalidate(userId);
                console.log('[Turn] 批改提取错题 %d 道（用户 %s）', wrongAdded, userId);
              }
            }
          } catch (e) {
            console.warn('[Turn] 错题提取失败（不影响批改）:', e.message);
          }
        }

        // ---- 12) 助手消息定稿（存的是剥离后的正文，并清掉"生成中"标记）----
        // 占位消息在第 10 步就写好了，这里只做最后那次 UPDATE。
        // 一个字都没生成（极少见：上游返回成功但内容为空）→ 删掉占位，
        // 免得留下一只空白气泡，比"什么都没发生"更像坏了。
        //
        // turnDone 在这里置位：此后不该再有落库定时器跑起来，
        // 否则已排定的 setImmediate 可能在定稿之后把中间态覆盖回去。
        turnDone = true;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

        // 学生中途走了：他没看到内容，但服务端可能已经收到了部分结果。
        // 仍然定稿（下次打开能看到已生成的部分，而不是一只永远转圈的气泡），
        // 只是**不记账** —— 口径与「零产出不记账」一致：没交付就不收费。
        // 上游已烧掉的 token 由我方承担。
        if (finalText) {
          conv.updateMessageContent(assistantMsgId, finalText, { streaming: 0 });
        } else {
          conv.deleteMessage(assistantMsgId);
        }

        // 中间态落库连续失败：收尾这次也大概率写不进去。
        // 与其留一条永远 streaming=1 的消息（学生每次打开都看到一只
        // 转圈的气泡，settleStreamingMessages 只能在**下一轮**才收敛它），
        // 不如现在就删掉 —— 空着比「卡住了」诚实。
        if (flushFailed >= 3) {
          console.error('[Turn] 中间态落库连续失败 %d 次（trace %s），删除占位消息避免留下"生成中"气泡',
            flushFailed, traceId);
          try { conv.deleteMessage(assistantMsgId); } catch (e) { /* 已尽力 */ }
        }

        // ---- 12.5) 零产出 = 失败，**绝不记账** ----
        // ⚠️ 这里曾是线上事故点（2026-10-10 定位）：
        // 上游可能「HTTP 200 + 流正常结束，但正文一个字都没给」——
        // 常见于内容被上游静默清空，或推理型模型只吐思维链、不出正文。
        // 此时 ai.chatStream 的 promise 是 **resolve**（不是 reject），
        // 旧代码于是当成功一路走下去：删占位消息 → 照常 recordUsage 扣费 → 发 done。
        // 学生端什么都没看见（前端判定「未收到回复内容」），积分却被实打实扣掉；
        // 他误以为坏了而反复重试，就成了重试风暴（实测一个会话 18 秒扣了 16 笔）。
        //
        // 正确语义是「没有正文就没有交付」，这是故障而非成功。所以这里**提前返回**：
        // 不记账、不发 done，把出路明确告诉学生。
        // 刻意**不动模型健康状态** —— 零产出更接近「上游对某类请求的策略问题」，
        // 与 401/402/429 同类，自动熔断只会把真实原因藏起来（见 utils/model-health）。
        // 上游确实消耗的 token 由我方承担：相对「白扣学生积分」，这个代价小得多，
        // 也符合「学生体验优先于成本」的既定取舍。
        if (!finalText) {
          console.warn('[Turn] 模型 %s 零产出（trace %s，思维链 %d 字）→ 判定失败且不计费',
            effectiveModelId, traceId, (result.reasoning || '').length);
          sse.send('error', {
            message: (result.reasoning || '')
              ? '模型只输出了思考过程、没有给出正式回答。换个模型再问一次通常就好了。'
              : '模型这次没有返回任何内容，可能是它暂时不稳定。换个模型再问一次通常就好了。'
          });
          sse.close();
          return;
        }

        // ---- 13) 记账 ----
        var usage = extractUsage(result.usage, promptText, result.text);

        // 这一轮跑通了：把连续失败计数清零。
        // 放在这里而不是 streaming 末尾 —— 上游返回 usage 之后才算真的成功，
        // 中途断开（done 没到）不应该洗白一个坏模型。
        modelHealth.recordSuccess(effectiveModelId);
        var costMicro = pricing.calcCostMicro(model, usage);
        var booked = null;
        if (clientGone) {
          // 学生中途离开，内容没送达 —— 不记账。
          // 上游那点 token 我方承担；让他为没看到的东西付钱是不可接受的。
          console.warn('[Turn] 客户端已断开（trace %s），本轮不扣学生积分（上游成本 %.0f 微元自担）',
            traceId, costMicro);
        } else {
          booked = credit.recordUsage({
            user_id: userId,
            conversation_id: convRow.id,
            model_id: effectiveModelId,
            // 判定「这一轮扣不扣钱」必须用完整的 model 对象（is_free / free_until 都在里面）。
            // recordUsage 内部要在事务里复核一遍余额，不能只靠发起前的 checkGate。
            model: model,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            cache_hit_tokens: usage.cache_hit_tokens,
            cache_miss_tokens: usage.cache_miss_tokens,
            total_tokens: usage.total_tokens,
            cost_micro: costMicro,
            estimated: usage.estimated,
            source: source,
            trace_id: traceId,
            image_count: imageHashes.length
          });

          // 记账被拒：这笔已交付的回答不入账（上游那 token 我方自付）。
          //
          // 为什么已经答完了还要报错：学生确实拿到了答案，如果悄悄当成功，
          // 他会觉得「积分扣了但余额没变」是账坏了，下次对账更难解释。
          // 但也**不能**改成「把答案撤回」—— 内容已经发到浏览器了。
          // 所以口径是：内容照给、账照记（真实流水在 usage 侧），
          // 明确告诉学生这一轮没扣他的积分，并给出下一步。
          if (booked && booked.ok === false) {
            console.warn('[Turn] 记账被拒（%s，trace %s）——本轮不扣学生积分', booked.reason, traceId);
          }
        }

        // 回给前端的额度一律积分口径：这是学生端的流，不带元。
        // 前端目前并不展示「本次消耗」（刻意不展示：强调消耗会让学生不敢提问），
        // 数据带上是为了将来要做「积分明细」时不用再改协议。
        var pointsView = credit.toPointsView(credit.getState(userId));
        sse.send('done', {
          conversation_id: convRow.id,
          // 用精确口径（保留两位小数）而不是整数取整：
          // 单轮真实消耗常在0.3~1.4 积分，取整后多半变成 0，
          // 于是"明明用了一次，返回的消耗是 0"——将来做积分明细时账目对不上。
          // ⚠️ 记账被拒、或学生中途断开（booked 为 null）时这一栏报 0：
          //   账本上确实没扣，报真实成本只会让学生看到「明明没扣款却说用了 1.4 积分」。
          //   本轮真实成本已记在服务端日志里，对账看得到。
          cost_points: booked && booked.ok === false ? 0
            : (clientGone ? 0 : config.microToPointsExact(costMicro)),
          balance: {
            available_points: pointsView.available_points,
            weekly_remaining_points: pointsView.weekly_unlimited
              ? null : pointsView.weekly_remaining_points
          },
          // 免费模型（永久免费或限免中）不上报 estimated：用量估算只影响计费，
          // 而这类模型不产生费用，弹「本次用量为估算值」只会让学生困惑
          // （他既没被扣钱，也无从处理）。
          // 数据库里仍如实记录 estimated —— 对账要看真话，那是管理端的事。
          estimated: usage.estimated === 1 && !pricing.isModelFree(model),
          image_count: imageHashes.length,
          vision_mode: visionPlan.mode,
          // 批改时有意义：本次自动收录了几道错题到错题本
          wrong_added: wrongAdded,
          context: built.stats
        });
        sse.close();

        // ---- 14) 长期记忆自动沉淀（发射后不管）----
        // 放在 sse.close() **之后**：学生那边已经完整收到回答，这一步是纯后台事务，
        // 无论跑多久、成功还是失败，都不影响这次对话的结果。
        // 触发条件（每 N 轮一次、排除任务型对话）与模型选择都在 memory-extractor 里。
        try {
          memoryExtractor.maybeExtractAfterTurn({
            userId: userId,
            conversationId: convRow.id,
            mode: convRow.mode || 'study',
            // 带附件 / 引用笔记的都是任务型对话，正文是"题目与他写的答案"，
            // 不是"关于他这个人"的信息 —— 拿去挖画像没营养，还可能把题目里的
            // 虚构条件误当成他的真实情况。
            hasAttachment: attachmentMeta.length > 0 || noteIds.length > 0
          });
        } catch (e) {
          console.warn('[Turn] 记忆提取触发失败（不影响对话）:', e.message);
        }
      }).catch(function(err) {
        console.error('[Turn] 流式调用失败:', err.message, err.detail || '');

        // 失败 / 卡死也要给占位消息收尾：保留已经生成的部分（学生看到多少就留多少，
        // 这正是"不丢内容"的含义），并清掉 streaming —— 否则这条会永远显示成"生成中"，
        // 前端每次打开都会去轮询一个不会再动的会话。
        try {
          if (accText) conv.updateMessageContent(assistantMsgId, accText, { streaming: 0 });
          else conv.deleteMessage(assistantMsgId);
        } catch (e) { /* 收尾失败不要掩盖真正的错误 */ }

        // 「连上了但一个字都不出 / 直接断开」计一次失败，连续到阈值就熔断，
        // 让它从学生的下拉框里消失。401/402/429 不走这条 —— 那不是模型坏了。
        if (modelHealth.isFusableError(err && err.code)) {
          modelHealth.recordFailure(effectiveModelId, err.code);
        }

        // 学生端的错误文案必须带下一步动作（见 utils/model-health 的说明）；
        // stall 类错误的 message 已经写好了「点停止生成换个模型再问一次」。
        sse.send('error', { message: err.message || 'AI 服务暂时不可用，请稍后重试' });
        sse.close();
      });
    });
  }).catch(function(err) {
    // 缩图等前置阶段的异步异常也要有兜底出口
    console.error('[Turn] 前置处理失败:', err.message);
    // 这条路径走的是 res.end() 而不是 sse.close()，所以要单独放锁。
    // 没事也调到：traceId 不匹配时 releaseTurn 什么都不做，不会误删别人的锁。
    releaseTurn(convRow.id, traceId);
    if (res.headersSent) {
      try {
        res.write('event: error\ndata: ' + JSON.stringify({ message: '处理失败，请重试' }) + '\n\n');
      } catch (e) { /* 已断开 */ }
      if (!res.writableEnded) res.end();
    } else {
      res.status(500).json({ code: 500, message: '处理失败，请重试' });
    }
  });
}

// 归一化请求带来的笔记 id 列表
//
// 一律按字符串处理（迁移 018 起笔记 id 由客户端生成，见 cloud_notes 表）。
// 这里只做「取字符串 → 去空白 → 截长 → 去重」，不校验格式：
// id 是否存在、是否属于本人，由 loadNoteRefs 查库判定 —— 在那里失败才能给出
// 「引用的笔记不存在或无权访问」这种学生看得懂的话；
// 在这里猜格式只会把正常 id 误杀。
function normalizeNoteIds(input) {
  if (!Array.isArray(input)) return [];
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < input.length; i++) {
    if (input[i] === null || input[i] === undefined) continue;
    var id = String(input[i]).trim().slice(0, 64);
    if (!id || seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

// 读取被引用的笔记
//
// 返回 { text, meta, error }：
//   text  —— 拼好的笔记正文（每篇带标题，超长截断）
//   meta  —— [{ id, name, kind:'note' }]，用于存档与历史占位
//   error —— 非空表示应当拒绝这次请求（笔记不存在或不属于该用户）
//
// 两处必须校验：笔记 id 属于本人（SQL 里带 user_id），
// 且正文文件确实在该用户云盘里（readUserFile 内部校验归属）。
function loadNoteRefs(userId, noteIds) {
  var MAX_NOTES = 5;
  var PER_NOTE_CHARS = 4000;   // 单篇正文截断长度
  var TOTAL_CHARS = 12000;     // 全部笔记正文合计上限

  if (noteIds.length > MAX_NOTES) {
    return { error: '单次最多引用 ' + MAX_NOTES + ' 篇笔记' };
  }

  var db = require('../utils/db');
  var cloudStore = require('./cloud-store');

  var chunks = [];
  var meta = [];
  var total = 0;

  for (var i = 0; i < noteIds.length; i++) {
    var row = db.prepare('SELECT * FROM cloud_notes WHERE id = ? AND user_id = ?')
      .get(noteIds[i], String(userId));
    if (!row) return { error: '引用的笔记不存在或无权访问' };

    var res = cloudStore.readUserFile(row.file_hash, userId);
    if (res.error) {
      // 笔记还在、正文文件没了：不让学生白等一整轮才发现引用是空的
      return { error: '笔记「' + (row.title || '未命名笔记') + '」的正文已丢失' };
    }

    var text = res.buffer.toString('utf8');
    var truncated = false;
    if (text.length > PER_NOTE_CHARS) {
      text = text.slice(0, PER_NOTE_CHARS);
      truncated = true;
    }
    // 合计也要卡：五篇各 4000 就是两万字，足以把上下文预算吃光
    var remain = TOTAL_CHARS - total;
    if (remain <= 0) break;
    if (text.length > remain) {
      text = text.slice(0, remain);
      truncated = true;
    }

    var title = row.title || '未命名笔记';
    chunks.push('### 笔记：' + title +
      (truncated ? '\n（内容过长已截断）' : '') + '\n' + text);
    meta.push({ id: row.id, hash: row.file_hash, name: title, kind: 'note' });
    total += text.length;
  }

  return { text: chunks.join('\n\n'), meta: meta, error: '' };
}

// 用户只发图/只给参数、没写正文时，给一个兜底的任务性提示
function tasksDefaultText(task) {
  if (!task || !task.kind) return '';

  if (task.kind === 'grade') return '请批改图里学生的作答。';
  if (task.kind === 'solve') {
    if (task.paperMode === 'multi') return '请解答图里的所有题目。';
    if (task.paperMode === 'cross_page') return '这几张图是同一道题的连续部分，请拼接后解答。';
    return '请解答图里的题目。';
  }
  if (task.kind === 'writing_generate') return '请按上面的要求写一篇作文。';
  if (task.kind === 'writing_grade') return '请批改上面的作文。';
  if (task.kind === 'writing_outline') return '请按上面的要求列一份写作提纲。';
  return '';
}

// 任务前缀：让模型明确本次任务边界，尤其在会话内切换过模式之后
function buildTaskHint(task, imageCount) {
  if (!task || !task.kind) return '';

  var writingKind = task.kind.indexOf('writing_') === 0;
  var base = prompts.getTaskHint(task.kind);

  if (task.kind === 'solve' && task.paperMode === 'cross_page') {
    base += prompts.buildCrossPageHint(imageCount);
  }
  // 题量模式显式告知，避免模型自行猜测切题方式
  if (task.kind === 'solve') {
    if (task.paperMode === 'single') base += '（本次为单题模式：图片中是一道完整的题）';
    else if (task.paperMode === 'multi') base += '（本次为多题模式：图片中包含多道题，请逐题作答）';
  }

  // 看图作文：明确告诉模型图是什么用途，否则它会自行猜测该描述还是该批改
  if (writingKind && imageCount > 0) {
    if (task.kind === 'writing_grade') {
      base += '（附带的 ' + imageCount + ' 张图是学生手写的作文稿，请识别后批改）';
    } else {
      base += '（附带的 ' + imageCount + ' 张图是题目素材，请据此写作）';
    }
  }

  return base;
}

module.exports = {
  runStreamTurn: runStreamTurn,
  extractUsage: extractUsage,
  // 下划线前缀 = 仅给验证脚本用（确认在途锁拿了会放、没有泄漏），业务代码不要调
  _acquireTurn: acquireTurn,
  _releaseTurn: releaseTurn,
  _inFlightSnapshot: inFlightSnapshot
};