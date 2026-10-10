// 视觉链路：判定模型能否看图、读取图片、必要时缩图、转述回退
//
// 三种模式：
//   native —— 模型本身支持视觉，直接把图片作为 image_url 内容块传给它
//   relay  —— 模型不支持视觉，但管理员配了「转述模型」：
//             先用转述模型把图转成文字，再把文字喂给对话模型
//   none   —— 两者都不行，请求应被拒绝（前端提前灰掉入口，这里是后端兜底）
//
// 为什么需要 relay：教室场景里常用的是便宜的纯文本模型，但它们收图会直接 400。
// 配一个视觉模型专门做「看图转文字」，就能让这些便宜模型也具备拍题能力，
// 且不需要为每个模型单独对接视觉接口。

var db = require('../utils/db');
var config = require('../config');
var constants = require('../utils/constants');
var ai = require('./ai');
var prompts = require('./prompt-registry');
var credit = require('./credit');

// ---- 全局默认值（可被 cluss_meta 覆盖）----
var DEFAULT_MAX_IMAGES = 4;
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;      // 单图 4MB（转 base64 后约 5.4MB 请求体）
var MAX_TEXT_ATTACH_BYTES = 32 * 1024;      // 文本附件截断到 32KB
var SHRINK_THRESHOLD_BYTES = 1.5 * 1024 * 1024;
var RELAY_TIMEOUT_MS = 60000;

// sharp 是原生模块，装不上时不能让整个服务起不来
var sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[vision] sharp 未安装，图片将不做压缩（原图直传）');
}

// ---- 配置读取（cluss_meta）----
function getMeta(key, fallback) {
  try {
    var row = db.prepare('SELECT value FROM cluss_meta WHERE key = ?').get(key);
    return row && row.value !== undefined && row.value !== null && row.value !== '' ? row.value : fallback;
  } catch (e) {
    return fallback;
  }
}

function getVisionConfig() {
  return {
    enabled: getMeta('vision_enabled', '1') !== '0',
    relayModelId: String(getMeta('vision_relay_model_id', '') || ''),
    maxImages: parseInt(getMeta('vision_max_images', String(DEFAULT_MAX_IMAGES)), 10) || DEFAULT_MAX_IMAGES,
    imageMaxEdge: parseInt(getMeta('image_max_edge', '1568'), 10) || 1568,
    imageQuality: parseInt(getMeta('image_quality', '80'), 10) || 80,
    shrinkEnabled: getMeta('image_shrink_enabled', '1') !== '0'
  };
}

// ---- 判定本次请求怎么处理图片 ----
//
// 每个拒绝分支都带两个理由：
//   reason        —— 给管理员/日志看的，写清技术原因（为什么不能用）
//   studentReason —— 给学生看的，只说「现在不能用、找谁」
//
// 为什么要分开：「配置的转述模型不可用（未启用、缺 API Key 或不支持视觉）」
// 这句话学生一个字都看不懂 —— 他没配过 Key，也不知道"转述模型"是什么，
// 看到只会以为软件坏了。技术原因必须留着排障，但不该出现在学生面前。
function resolveVisionMode(mc) {
  if (!mc) {
    return {
      mode: 'none', relay: null,
      reason: '模型不存在',
      studentReason: '这个 AI 暂时不可用，请刷新页面后重试'
    };
  }

  var cfg = getVisionConfig();
  if (!cfg.enabled) {
    return {
      mode: 'none', relay: null, disabled: true,
      reason: '管理员已关闭看图功能',
      studentReason: '看图功能暂时关闭了，请联系管理员'
    };
  }

  // 直接支持视觉：最省事，也不需要额外成本
  if (mc.supportsVision) {
    return { mode: 'native', relay: null, maxImages: mc.visionMaxImages || cfg.maxImages };
  }

  // 转述回退
  var relayId = cfg.relayModelId;
  if (relayId && relayId !== mc.id) {
    var relay = ai.resolveModel(relayId);
    // enabled 也要判：resolveModel 只看"有没有地址和 Key"，
    // 停用的模型照样能解析出来 —— 不管它的话，拍题会一路走到
    // 真正发请求时才失败，而那时错误已经很难解释给学生听了。
    if (relay && relay.enabled && relay.ready && relay.supportsVision) {
      return { mode: 'relay', relay: relay, maxImages: cfg.maxImages };
    }
    return {
      mode: 'none',
      relay: null,
      reason: '配置的转述模型不可用（未启用、缺 API Key 或不支持视觉）',
      studentReason: '看图功能暂时不可用，请联系管理员'
    };
  }

  return {
    mode: 'none',
    relay: null,
    reason: '当前模型不支持看图，且管理员未配置转述模型',
    studentReason: '当前用的 AI 看不了图片，请管理员换一个能看图的'
  };
}

function maxImagesFor(mc) {
  var cfg = getVisionConfig();
  var n = mc && mc.visionMaxImages ? mc.visionMaxImages : cfg.maxImages;
  return Math.max(1, Math.min(6, n));
}

// ---- 图片读取与缩图 ----
// 校验并读取云盘图片：只认「该用户云盘里确实有」的文件，避免越权读别人的文件
function loadImageItems(userId, hashes, opts) {
  if (!hashes || !hashes.length) return { items: [] };

  var cloudStore;
  try {
    cloudStore = require('./cloud-store');
  } catch (e) {
    return { error: '云盘功能未启用，请联系管理员' };
  }

  var items = [];
  for (var i = 0; i < hashes.length; i++) {
    var hash = String(hashes[i] || '').trim();
    if (!hash) continue;

    var r = cloudStore.readUserFile(hash, userId, MAX_IMAGE_BYTES);
    if (r.error) return { error: r.error };
    if (!cloudStore.isImageMime(r.mime)) {
      return { error: '「' + (r.name || hash) + '」不是图片，只有图片能交给 AI 识别' };
    }

    items.push({
      hash: hash,
      name: r.name || hash,
      mime: r.mime,
      buffer: r.buffer
    });
  }
  return { items: items };
}

// 文本附件读取（截断）
function loadTextItems(userId, hashes) {
  if (!hashes || !hashes.length) return { texts: [] };

  var cloudStore;
  try {
    cloudStore = require('./cloud-store');
  } catch (e) {
    return { texts: [] };
  }

  var texts = [];
  for (var i = 0; i < hashes.length; i++) {
    var hash = String(hashes[i] || '').trim();
    if (!hash) continue;
    var r = cloudStore.readUserFile(hash, userId, MAX_TEXT_ATTACH_BYTES);
    if (r.error) continue;   // 文本读取失败不阻断整轮对话

    var text = r.buffer.toString('utf8');
    var truncated = false;
    if (text.length > MAX_TEXT_ATTACH_BYTES) {
      text = text.slice(0, MAX_TEXT_ATTACH_BYTES);
      truncated = true;
    }
    texts.push({
      name: r.name || hash,
      text: text,
      truncated: truncated
    });
  }
  return { texts: texts };
}

// 服务端缩图
// 手机拍的题图常在 3~8MB，直接传给上游会明显变慢且更贵。
// 用 sharp 压到长边 1568（多数视觉模型的有效输入尺寸上限）以内。
// 失败一律回退原图——宁可慢一点，也不能因为缩图失败让对话不可用。
function shrinkImage(buffer, opts) {
  var o = opts || {};
  var cfg = getVisionConfig();
  var maxEdge = o.maxEdge || cfg.imageMaxEdge || 1568;
  var quality = o.quality || cfg.imageQuality || 80;

  if (!sharp || cfg.shrinkEnabled === false) {
    return Promise.resolve({ buffer: buffer, shrunk: false, reason: 'sharp 不可用或已关闭压缩' });
  }

  // 小于阈值的不折腾（重编码反而可能变大）
  if (buffer.length <= SHRINK_THRESHOLD_BYTES) {
    return Promise.resolve({ buffer: buffer, shrunk: false, reason: '体积已足够小' });
  }

  return sharp(buffer, { limitInputPixels: 40 * 1000 * 1000, failOn: 'none' })
    .rotate()   // 按 EXIF 方向摆正：手机竖拍的照片常带旋转标记
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: quality, mozjpeg: true })
    .toBuffer()
    .then(function(out) {
      var meta = null;
      return sharp(out).metadata().then(function(m) {
        meta = m;
        return {
          buffer: out,
          mime: 'image/jpeg',
          width: m.width || 0,
          height: m.height || 0,
          shrunk: true,
          before: buffer.length,
          after: out.length
        };
      }).catch(function() {
        return { buffer: out, mime: 'image/jpeg', shrunk: true, before: buffer.length, after: out.length };
      });
    })
    .catch(function(err) {
      console.warn('[vision] 缩图失败，回退原图:', err.message);
      return { buffer: buffer, shrunk: false, reason: '压缩失败：' + err.message };
    });
}

// 全部图片并发受限地依次缩图（教室机器内存有限，不做并发）
function shrinkAll(items, onProgress) {
  var out = [];
  var chain = Promise.resolve();

  items.forEach(function(item, idx) {
    chain = chain.then(function() {
      return shrinkImage(item.buffer, {}).then(function(r) {
        out.push({
          hash: item.hash,
          name: item.name,
          mime: r.mime || item.mime,
          buffer: r.buffer,
          shrunk: r.shrunk,
          before: r.before || item.buffer.length,
          after: r.after || r.buffer.length
        });
        if (onProgress) onProgress(idx + 1, items.length);
      });
    });
  });

  return chain.then(function() { return out; });
}

// 转成 data URL（只存在于内存，绝不落库）
function toImageDataUrl(buffer, mime) {
  return 'data:' + (mime || 'image/jpeg') + ';base64,' + buffer.toString('base64');
}

// ---- 转述：把图片转成文字 ----
// 必须**串行**：同一个 API Key 并发调用大概率撞上游限流（429）
function describeImages(relayModel, items, onProgress) {
  var results = [];
  var usages = [];
  var failed = [];
  var chain = Promise.resolve();

  items.forEach(function(item, idx) {
    chain = chain.then(function() {
      var dataUrl = toImageDataUrl(item.buffer, item.mime);
      var messages = [{
        role: 'user',
        content: [
          { type: 'text', text: prompts.VISION_RELAY_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }];

      // 转述要抄录整页文字，确实会长，但有天然上界（一页纸的字量）。
      // 给 3072 是防它把"描述图片"写成"解题+讲解"（转述器越界解题会挤掉正文模型）。
      return ai.chatOnce(relayModel, messages, {
        timeout: RELAY_TIMEOUT_MS, temperature: 0.2, maxTokens: 3072
      })
        .then(function(data) {
          var text = data && data.choices && data.choices[0] &&
            data.choices[0].message && data.choices[0].message.content;
          if (!text) throw new Error('转述结果为空');
          results.push({ index: idx, name: item.name, text: String(text) });
          if (data.usage) usages.push(data.usage);
        })
        .catch(function(err) {
          console.warn('[vision] 第 %d 张转述失败: %s', idx + 1, err.message);
          failed.push({ index: idx, name: item.name, message: err.message || '转述失败' });
          results.push({
            index: idx,
            name: item.name,
            text: '（第 ' + (idx + 1) + ' 张图无法识别：' + (err.message || '转述失败') + '）',
            error: true
          });
        })
        .then(function() {
          if (onProgress) onProgress(idx + 1, items.length, item.name);
        });
    });
  });

  return chain.then(function() {
    results.sort(function(a, b) { return a.index - b.index; });

    var parts = [];
    for (var i = 0; i < results.length; i++) {
      parts.push('第 ' + (i + 1) + ' 张（' + results[i].name + '）：\n' + results[i].text);
    }

    return {
      text: parts.join('\n\n'),
      usages: usages,
      failed: failed,
      succeeded: results.length - failed.length,
      total: results.length
    };
  });
}

// 转述消耗单独记账（source='vision_relay'），共享同一条 trace_id
function recordRelayUsage(relayModel, usages, meta) {
  var pricing = require('./pricing');
  var total = 0;
  for (var i = 0; i < usages.length; i++) {
    var u = usages[i];
    var usage = {
      prompt_tokens: Number(u.prompt_tokens || 0),
      completion_tokens: Number(u.completion_tokens || 0),
      cache_hit_tokens: Number(
        u.prompt_cache_hit_tokens ||
        (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
      )
    };
    usage.cache_hit_tokens = Math.min(usage.cache_hit_tokens, usage.prompt_tokens);
    usage.cache_miss_tokens = usage.prompt_tokens - usage.cache_hit_tokens;
    usage.total_tokens = Number(u.total_tokens || (usage.prompt_tokens + usage.completion_tokens));

    var cost = pricing.calcCostMicro(relayModel, usage);
    total += cost;

    credit.recordUsage({
      user_id: meta.userId,
      conversation_id: meta.conversationId,
      model_id: relayModel.id,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cache_hit_tokens: usage.cache_hit_tokens,
      cache_miss_tokens: usage.cache_miss_tokens,
      total_tokens: usage.total_tokens,
      cost_micro: cost,
      estimated: 0,
      source: 'vision_relay',
      trace_id: meta.traceId,
      image_count: 1
    });
  }
  return total;
}

module.exports = {
  MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
  MAX_TEXT_ATTACH_BYTES: MAX_TEXT_ATTACH_BYTES,
  getVisionConfig: getVisionConfig,
  resolveVisionMode: resolveVisionMode,
  maxImagesFor: maxImagesFor,
  loadImageItems: loadImageItems,
  loadTextItems: loadTextItems,
  shrinkImage: shrinkImage,
  shrinkAll: shrinkAll,
  toImageDataUrl: toImageDataUrl,
  describeImages: describeImages,
  recordRelayUsage: recordRelayUsage,
  sharpAvailable: !!sharp
};