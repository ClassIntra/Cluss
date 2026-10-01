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
var config = require('../config');

var DEFAULT_CONTEXT_BUDGET = 10000;

function newTraceId() {
  return crypto.randomBytes(8).toString('hex');
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

  // 需要图的任务没带图，直接拦（拍题/批改属于这类）
  if (requiresImage && !hasImages) {
    return fail(res, 400, '请先选择题目图片');
  }
  if (!task.kind && !content && !hasImages) {
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
    titleFrom: content || (task.kind === 'grade' ? '作业批改' : '拍题解答'),
    taskKind: task.kind
  });

  var effectiveModelId = String(ctx.modelId || convRow.model_id || ai.getDefaultModelId());
  var model = ai.resolveModel(effectiveModelId);
  if (!model) {
    return fail(res, 404, '模型不存在，请选择其他模型');
  }

  // ---- 2) 视觉判定 ----
  // 必须先于闸门：因为走转述时「实际出钱的」是转述模型，
  // 闸门要判的是真正会产生费用的那个模型
  var visionPlan = { mode: 'none', relay: null };
  if (hasImages) {
    visionPlan = vision.resolveVisionMode(model);
    if (visionPlan.mode === 'none') {
      return fail(res, 400, visionPlan.reason || '当前模型不支持看图，请联系管理员配置');
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
    return fail(res, 503, 'AI 服务未配置完成（' + model.unavailableReason + '），请联系管理员');
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

  // ---- 5) 图片缩图（在写 SSE 头之前完成，失败回退原图不阻断）----
  var shrinkChain = imageItems.length
    ? vision.shrinkAll(imageItems, null)
    : Promise.resolve([]);

  return shrinkChain.then(function(shrunkItems) {
    // ---- 6) 写 SSE 头（此后不能再改 HTTP 状态码）----
    var sse = conv.createSseWriter(ctx.req, res);
    sse.headers();

    sse.send('meta', {
      conversation_id: convRow.id,
      model_id: effectiveModelId,
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

      var systemPrompt = prompts.getSystemPrompt({
        mode: convRow.mode || 'study',
        studyStyle: convRow.study_style || 'guided',
        taskKind: task.kind === 'solve' ? task.paperMode : task.kind,
        writing: task.writing || null,
        hasAttachment: attachmentMeta.length > 0
      });

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
        textAttachmentText: textAttachmentText,
        budgetTokens: DEFAULT_CONTEXT_BUDGET
      });

      // ---- 10) 流式生成 ----
      var promptText = flattenForEstimate(built.messages);
      var handle = ai.chatStream(model, built.messages, {
        onDelta: function(text) {
          sse.send('delta', { text: text });
        }
      });

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
                console.log('[Turn] 批改提取错题 %d 道（用户 %s）', wrongAdded, userId);
              }
            }
          } catch (e) {
            console.warn('[Turn] 错题提取失败（不影响批改）:', e.message);
          }
        }

        // ---- 12) 存档助手消息（存的是剥离后的正文）----
        if (finalText) {
          conv.appendMessage(convRow.id, 'assistant', finalText, effectiveModelId, {
            attachments: [],
            source: source
          });
        }

        // ---- 13) 记账 ----
        var usage = extractUsage(result.usage, promptText, result.text);
        var costMicro = pricing.calcCostMicro(model, usage);
        credit.recordUsage({
          user_id: userId,
          conversation_id: convRow.id,
          model_id: effectiveModelId,
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

        var state = credit.getState(userId);
        sse.send('done', {
          conversation_id: convRow.id,
          cost_micro: costMicro,
          cost_yuan: config.microToYuan(costMicro).toFixed(4),
          balance: {
            available_micro: state.available_micro,
            available_yuan: config.microToYuan(state.available_micro).toFixed(2),
            weekly_remaining_yuan: state.weekly_unlimited
              ? null : config.microToYuan(state.weekly_remaining_micro).toFixed(2)
          },
          estimated: usage.estimated === 1,
          image_count: imageHashes.length,
          vision_mode: visionPlan.mode,
          // 批改时有意义：本次自动收录了几道错题到错题本
          wrong_added: wrongAdded,
          context: built.stats
        });
        sse.close();
      }).catch(function(err) {
        console.error('[Turn] 流式调用失败:', err.message, err.detail || '');
        sse.send('error', { message: err.message || 'AI 服务暂时不可用，请稍后重试' });
        sse.close();
      });
    });
  }).catch(function(err) {
    // 缩图等前置阶段的异步异常也要有兜底出口
    console.error('[Turn] 前置处理失败:', err.message);
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
  extractUsage: extractUsage
};