// 从对话里自动沉淀长期记忆
//
// 解决什么问题：memories 表建好了、检索与注入也通了，但**没有写入入口** ——
// 学生从没主动"说"过要记什么，于是表里始终是 0 条，"AI 记住你"这件事等于没发生。
//
// 做法：每聊满若干轮，用**最便宜的可用模型**在后台把最近这段对话过一遍，
// 挑出"关于这个学生本人、值得跨会话记住"的事实，写进 memories（source='auto'）。
//
// 五条硬约束：
//   1. **不阻塞主对话**：在 SSE 已 close 之后才跑，学生那边早就看到回答了。
//   2. **失败完全隔离**：任何异常都只记日志。记忆是增强项，不能因为它挂掉一次对话。
//   3. **不向学生计费**：这是我们自己的功能，不是他要的回答。token 成本由我方承担。
//   4. **有节流**：按"该会话已完成的助手消息数 % N == 0"触发，不需要额外状态表，
//      重启也不会重复跑（条数是库里的既成事实）。
//   5. **不碰敏感信息**：提示词里明确排除联系方式、住址、密码、学号等，
//      并且即使学生主动说了也不记 —— 记忆是给他看的，不该成为隐私采集器。
//
// 与 user-profile.js 的分工（刻意不同源）：
//   user-profile 是**行为统计**（错题分布、笔记标签、会话标题），只算不评、不碰对话内容；
//   这里是**对话语义**（他自己说过的偏好与情况），来源是他说的话。
//   两者拼在 system prompt 的末尾，互为补充。

var db = require('../utils/db');
var ai = require('./ai');
var pricing = require('./pricing');
var memory = require('./memory');
var affinity = require('./affinity');

// 每多少轮助手回复触发一次提取。
// 取值权衡：太小会让每轮都多打一次上游（成本翻倍），太大则"记住"来得太慢。
// 4 意味着一次完整对话里通常能提取一到两次，够用且不吵。
var EVERY_N_TURNS = 4;

// 送进去的对话片段上限（条）与单条截断长度
var TRANSCRIPT_MESSAGES = 12;
var TRANSCRIPT_ITEM_CHARS = 500;
var TRANSCRIPT_TOTAL_CHARS = 4000;

// 单次最多写入几条。宁少勿滥 —— 记忆是给模型的背景，多了会喧宾夺主，
// 而且模型偶尔会为凑数硬编几条无关紧要的。
//
// 2026-10-20 调到 8：实测每 4 轮提取一次、单轮 5 条 160 字的额度远远用不满
// 模型能力（一次完整对话里值得记的事实经常 6~8 条），且学生反馈
// "记忆太短、没达到模型能力上限"。8 条仍在"背景"的量级内。
var MAX_ITEMS_PER_RUN = 8;

var MAX_KEY_CHARS = 24;
// 单条记忆正文字数。160 字对"他物理电学吃力，做题漏条件，期末想冲 85"这种
// 颗粒度够用；翻倍到 320 是为了让模型能一次写清"事实 + 上下文"
// （不止干巴巴一个结论）。注入时另有 MAX_INJECT=8 条的条数与
// selectForContext 的字符预算兜底，不会无限膨胀。
var MAX_CONTENT_CHARS = 320;

// 内存级防重入：同一会话正在提取时，下一轮结束不再叠加一次请求。
// 只活到进程重启，够了 —— 节流本来靠上面的条数取模，这里只防"同时跑两份"。
var running = {};

function log(fmt) {
  var args = Array.prototype.slice.call(arguments, 1);
  console.log.apply(console, ['[MemoryExtract] ' + fmt].concat(args));
}

// ------------------------------------------------------------
// 模型选择：挑最便宜的一个可用模型
// ------------------------------------------------------------
// 排序依据：
//   1. 免费优先（永久免费或限免中）—— 成本为 0，没理由不用；
//   2. 其次按 (输入单价 + 输出单价) 升序。
// 抽出来的活儿（读一段对话、输出一小段 JSON）对模型能力要求很低，
// 用最贵的模型做这件事是纯浪费。
function pickCheapestModel() {
  var rows = ai.getEnabledModels();
  var candidates = [];

  for (var i = 0; i < rows.length; i++) {
    var m = ai.resolveModel(rows[i].id);
    // enabled 已在 getEnabledModels 里保证；这里再查 ready（有地址与 Key）
    // 与健康状态（熔断中的不碰 —— 别为一件事务性任务把熔断器搅乱）
    if (!m || !m.ready || !m.enabled) continue;
    if (!ai.isModelAvailable(m.id)) continue;

    var free = pricing.isModelFree(m) ? 0 : 1;
    // 单价可能为 0（管理员没填）：此时按"未知"处理，排在收费模型之后、
    // 免得一个没配价钱的模型因为 0+0 最小而被选中，结果账单上冒出一个大数。
    var hasPrice = (Number(m.price_in) > 0 || Number(m.price_out) > 0) ? 0 : 1;
    var score = free * 1000000 + hasPrice * 100000 + (Number(m.price_in) + Number(m.price_out));

    candidates.push({ model: m, score: score });
  }

  if (!candidates.length) return null;
  candidates.sort(function(a, b) { return a.score - b.score; });
  return candidates[0].model;
}

// ------------------------------------------------------------
// 触发判定
// ------------------------------------------------------------
// 该用户在**全部会话**里已完成的助手回合数。
//
// 为什么按用户而不是按会话（2026-10-20 实测改）：
//   学生是一个会话问几句就换下一个的 —— 实测 251800 有 7 个会话共 22 个助手回合，
//   平均每会话 3 回合，几乎没有一个会话能摸到"第 4 回合"。
//   按单会话计数时，这套长期记忆系统 structural 性地收不到多少料，
//   表现为"聊了很多天，记忆里还是一条都没有"。
//   改成跨会话累计后，学生感知到的规则很简单：**每聊满 4 轮，AI 整理一次**。
function countUserFinishedTurns(userId) {
  var row = db.prepare([
    'SELECT COUNT(*) AS n FROM ai_messages m',
    'JOIN ai_conversations c ON m.conversation_id = c.id',
    "WHERE c.user_id = ? AND m.role = 'assistant' AND m.streaming = 0"
  ].join('\n')).get(String(userId));
  return row ? Number(row.n) : 0;
}

// 距离下次整理还差几轮（给学生看的节奏提示）。
// 刚整理完（n 是 4 的倍数）时返回 4：下一轮就开始从头数。
function nextExtractIn(userId) {
  var n = countUserFinishedTurns(userId);
  if (n <= 0) return EVERY_N_TURNS;
  return EVERY_N_TURNS - (n % EVERY_N_TURNS);
}

// 该不该跑一次提取
//
// 只处理"自由对话"，不处理任务型链路：
//   拍题 / 批改 / 作文的正文里主要是**题目与学生答案**，不是"关于他这个人"的信息；
//   拿那些内容去挖画像，既没营养也容易把题目里的虚构条件当成他的真实情况。
//   判据用 mode + 有没有附件，而不是 source 字符串 —— 更稳。
function shouldExtract(ctx) {
  if (!ctx || !ctx.userId || !ctx.conversationId) return false;
  if (ctx.hasAttachment) return false;

  var mode = String(ctx.mode || 'study');
  if (mode !== 'daily' && mode !== 'study') return false;

  // 触发看**跨会话累计**回合；这一轮合格（上面两个 if）只是入场券。
  var n = countUserFinishedTurns(ctx.userId);
  if (n <= 0 || n % EVERY_N_TURNS !== 0) return false;
  return true;
}

// ------------------------------------------------------------
// 取对话片段
// ------------------------------------------------------------
// 与触发统计一致：跨会话取该用户最近的若干条。
// 单会话的片段撑不起一份"长期记忆"——学生把"我下周要期中考"这件事
// 分散在三四个会话里说过，只有跨会话拼起来才看得见。
function loadTranscript(userId) {
  var rows = db.prepare([
    'SELECT m.role, m.content FROM ai_messages m',
    'JOIN ai_conversations c ON m.conversation_id = c.id',
    "WHERE c.user_id = ? AND m.streaming = 0 AND m.content <> ''",
    'ORDER BY m.id DESC LIMIT ?'
  ].join('\n')).all(String(userId), TRANSCRIPT_MESSAGES);
  rows.reverse();

  var chunks = [];
  var total = 0;
  for (var i = 0; i < rows.length; i++) {
    var who = rows[i].role === 'user' ? '学生' : '助手';
    var text = String(rows[i].content || '').trim();
    if (!text) continue;
    if (text.length > TRANSCRIPT_ITEM_CHARS) text = text.slice(0, TRANSCRIPT_ITEM_CHARS) + '…';
    var line = who + '：' + text;
    if (total + line.length > TRANSCRIPT_TOTAL_CHARS) break;
    total += line.length;
    chunks.push(line);
  }
  return chunks.join('\n');
}

// ------------------------------------------------------------
// 提取提示词
// ------------------------------------------------------------
var EXTRACT_SYSTEM = [
  '你在为学习助手维护一份关于某个学生的「长期记忆」。',
  '从给定的对话片段里，找出**关于这个学生本人、值得跨会话记住**的事实。',
  '',
  '值得记：',
  '- 稳定的偏好与爱好：喜欢的科目/运动/游戏/音乐/动漫/明星、讨厌什么。',
  '- 学习情况：哪一科吃力、哪种题型常错、作息习惯、学习目标、复习方式。',
  '- 个人情况：年级、大致地区、想考的学校或专业、在参加的活动或竞赛。',
  '- 反复提到的状态：压力大、容易分心、需要被鼓励之类，但必须是**多次出现**的。',
  '',
  '不要记：',
  '- 一次性的知识问答内容（某个概念的答案、某道题的解法）——那属于会话，不属于他。',
  '- 你自己说过的话、寒暄、以及他一时的情绪化措辞。',
  '- 对话里作为**举例或题目设定**出现的虚构信息（"假如我是小明""题里说有 3 个班"）。',
  '- 任何联系方式与身份标识：电话、微信、QQ、邮箱、住址、身份证、学号、真实姓名。',
  '  **即使他主动说了也不要记** —— 这条没有例外。',
  '',
  '输出要求：',
  '1. 只输出一个 JSON 数组，不要解释、不要 Markdown 代码块围栏、不要多余文字。',
  '2. 每项形如：{"key":"偏好_游戏","content":"喜欢玩射击类游戏","tags":"游戏 爱好"}',
  '3. key 用「类别_主题」，2~12 个字。**类别只能从下面四个词里选一个**：',
  '   偏好（喜好、爱好、作息、交流方式与性格）、学习（科目、题型、目标、成绩、薄弱点）、',
  '   情绪（长期的状态与压力来源）、事实（家庭、人际、经历）。',
  '   不要自创类别词 —— 系统按类别决定这条记忆什么时候生效，自创的会被漏掉。',
  '   **同一类信息必须用同一个 key**，这样再次提到时会覆盖旧内容而不是堆积成多条。',
  '4. content 用第三人称（"他…"）说清，不超过 160 字：结论 + 支撑它的上下文。',
  '5. 没有任何值得记的内容时，输出 []。',
  '',
  '示例：',
  '[{"key":"偏好_游戏","content":"喜欢射击类游戏，常和朋友一起玩","tags":"游戏 爱好"},',
  ' {"key":"学习_薄弱科目","content":"物理的电学部分比较吃力，做题容易漏条件","tags":"物理 薄弱"}]'
].join('\n');

// ------------------------------------------------------------
// 隐私兜底过滤
// ------------------------------------------------------------
// ⚠️ 为什么提示词里已经写了"不要记联系方式"，这里还要再来一道：
//   实测证明把"排除隐私"只写成模型指令是不可靠的 —— 用打桩响应喂一条
//   「他的手机号是13800000000」，它照样会被写进 memories 表。
//   提示词是"请求"，代码才是"保证"。产品红线（不采集隐私）必须落在代码上。
//
// 判据分两类：
//   key 命中敏感词  → 整条丢掉（"联系方式"这种 key 本身就是信号）；
//   正文/标签里出现疑似隐私串 → 整条丢掉（哪怕 key 看着无害）。
// 宁严勿松：记忆是增强项，少记一条几乎没有代价，记错一条隐私是不可逆的。
var SENSITIVE_KEY_RE = /(联系|电话|手机|号码|微信|wechat|qq|邮箱|email|邮件|住址|地址|家庭|身份证|证件|密码|口令|账号|帐号|银行卡|学号|真实姓名|真名|姓名|隐私)/i;

var SENSITIVE_VALUE_RES = [
  // 中国大陆手机号
  /1[3-9]\d{9}/,
  // 固话（带区号）
  /0\d{2,3}-?\d{7,8}/,
  // 邮箱
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  // 身份证（18 位，末位可为 X）
  /\d{17}[\dXx]/,
  // 疑似 QQ / 微信号串：字母数字混合且带明确前缀
  /(微信号?|qq号?|wechat|weixin|vx)\s*[:：]?\s*[a-z0-9_-]{5,}/i
];

function looksSensitive(key, content, tags) {
  if (SENSITIVE_KEY_RE.test(String(key || ''))) return true;
  var hay = String(content || '') + ' ' + String(tags || '');
  for (var i = 0; i < SENSITIVE_VALUE_RES.length; i++) {
    if (SENSITIVE_VALUE_RES[i].test(hay)) return true;
  }
  return false;
}

// ------------------------------------------------------------
// 解析模型输出
// ------------------------------------------------------------
// 模型偶尔会加代码块围栏或前后废话，所以不能直接 JSON.parse。
// 策略：剥围栏 → 取第一个 '[' 到最后一个 ']' → parse。失败即放弃本次（不猜）。
function parseItems(text) {
  var s = String(text || '').trim();
  if (!s) return [];

  // 剥掉 ```json ... ``` 围栏
  var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();

  var start = s.indexOf('[');
  var end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  s = s.slice(start, end + 1);

  var arr;
  try { arr = JSON.parse(s); } catch (e) {
    log('JSON 解析失败，放弃本次提取：%s', e.message);
    return [];
  }
  if (!Array.isArray(arr)) return [];

  var out = [];
  var dropped = 0;
  for (var i = 0; i < arr.length && out.length < MAX_ITEMS_PER_RUN; i++) {
    var it = arr[i];
    if (!it || typeof it !== 'object') continue;
    var key = String(it.key == null ? '' : it.key).trim().slice(0, MAX_KEY_CHARS);
    var content = String(it.content == null ? '' : it.content).trim().slice(0, MAX_CONTENT_CHARS);
    var tags = String(it.tags == null ? '' : it.tags).trim().slice(0, 100);
    // 归一化后为空 = 不可用（normKey 会剔掉纯符号）
    if (!key || !content) continue;
    if (!memory.normKey(key)) continue;
    // 隐私兜底：命中就整条丢弃。日志留痕，便于事后审计"模型想记但被拦了什么"。
    if (looksSensitive(key, content, tags)) {
      dropped++;
      continue;
    }
    out.push({ key: key, content: content, tags: tags });
  }
  if (dropped > 0) log('拦下 %d 条疑似隐私内容（未写入）', dropped);
  return out;
}

// 从上游响应里取正文（OpenAI 兼容两种写法都认）
function readContent(resp) {
  if (!resp) return '';
  var choices = resp.choices;
  if (!choices || !choices.length) return '';
  var c = choices[0];
  if (c.message && typeof c.message.content === 'string') return c.message.content;
  if (typeof c.text === 'string') return c.text;
  return '';
}

// ------------------------------------------------------------
// 主入口
// ------------------------------------------------------------
// ctx: { userId, conversationId, mode, hasAttachment }
// 返回 undefined —— 调用方**不该**等待它，这是纯粹的"发射后不管"。
function maybeExtractAfterTurn(ctx) {
  var c = ctx || {};
  var convId = String(c.conversationId || '');

  // 触发判定本身可能抛（查库），整体包一层，绝不让它影响调用方
  var go = false;
  try {
    go = shouldExtract(c);
  } catch (e) {
    log('触发判定失败：%s', e.message);
    return;
  }
  if (!go) return;
  if (running[convId]) return;
  running[convId] = true;

  // setImmediate：把这一坨推到本轮事件循环之外。
  // 虽然 SSE 已经 close，但同步往下走仍会占着这次请求的调用栈。
  setImmediate(function() {
    run(c).then(function() {
      delete running[convId];
    }).catch(function(err) {
      delete running[convId];
      log('提取异常（已忽略）：%s', err && err.message);
    });
  });
}

function run(c) {
  var userId = String(c.userId);
  var convId = String(c.conversationId);

  var transcript;
  try {
    transcript = loadTranscript(userId);
  } catch (e) {
    log('读取对话片段失败：%s', e.message);
    return Promise.resolve();
  }
  // 片段太短说明没有可提取的信息量，别浪费一次上游调用
  if (transcript.length < 60) return Promise.resolve();

  var model = pickCheapestModel();
  if (!model) {
    log('没有可用的模型，跳过本次提取');
    return Promise.resolve();
  }

  var messages = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: '下面是一段对话，请提取值得长期记住的关于这个学生的信息：\n\n' + transcript }
  ];

  var startedAt = Date.now();
  return ai.chatOnce(model, messages, {
    // 低温度：这是"抽事实"，不是"创作"，输出越稳定越好
    temperature: 0.2,
    timeout: 60000,
    // 提取器每次最多吐一小组 JSON 条目。
    // 2026-10-20 从 1024 提到 2048：条数上限调到 8 条、单条 320 字后，
    // 1024 会把输出截断在 JSON 中间（模型吐到一半没 token 了），
    // 解析失败即整轮白跑 —— 那是"额度给大了反而一条不剩"。
    maxTokens: 2048
  }).then(function(resp) {
    var text = readContent(resp);
    var items = parseItems(text);
    if (!items.length) {
      log('本轮无可记内容（模型 %s，%dms）', model.id, Date.now() - startedAt);
      return;
    }

    var added = 0;
    var updated = 0;
    for (var i = 0; i < items.length; i++) {
      // 单条失败不影响其余的
      var r = memory.upsert(userId, {
        key: items[i].key,
        content: items[i].content,
        tags: items[i].tags,
        source: 'auto'
      });
      if (r.ok) {
        if (r.updated) updated++; else added++;
      } else {
        log('写入失败（%s）：%s', items[i].key, r.message);
      }
    }
    log('用户 %s 会话 %s：新增 %d 条、更新 %d 条（模型 %s，%dms）',
      userId, convId, added, updated, model.id, Date.now() - startedAt);

    // 好感度：「被 AI 记住」是学生对这套系统最直接的感知，值得单独加分。
    // 只挂在这里（不挂路由层的手动添加）—— 这是"它自己记下的"，
    // 不是"我教它记的"，加分理由才对得上。affinity 内部有每日一次与封顶。
    if (added + updated > 0) {
      try { affinity.noteNewMemory(userId); } catch (e) { /* 好感度绝不拖累记忆 */ }
    }
  });
}

module.exports = {
  EVERY_N_TURNS: EVERY_N_TURNS,
  maybeExtractAfterTurn: maybeExtractAfterTurn,
  // 给学生看的节奏："再聊几轮会整理一次"。
  // 路由层用它把后台节奏变成明示承诺 —— 后台悄悄跑却不告诉学生，
  // 学生看到的就是"设了/聊了，但它什么都没记"。
  nextExtractIn: nextExtractIn,
  // 以下导出仅为可测性（探针要用），业务代码不要依赖
  _internal: {
    pickCheapestModel: pickCheapestModel,
    shouldExtract: shouldExtract,
    countUserFinishedTurns: countUserFinishedTurns,
    loadTranscript: loadTranscript,
    parseItems: parseItems,
    readContent: readContent,
    run: run
  }
};
