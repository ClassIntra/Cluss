// 端到端测试用的 mock AI 上游（OpenAI 兼容，支持流式与非流式）
//
// 用途：在没有真实 API Key 的情况下验证完整链路
//       「流式解析 → 用量提取 → 计费扣减 → 余额更新」，
//       以及视觉链路（native 收图 / relay 收转述文字）。
//
// 它会根据请求内容回不同的固定答案，方便断言「模型到底收到了什么」：
//   - 收到 image_url 内容块        → 回复里注明「收到了 N 张图」
//   - system 提示词含「批改」      → 返回批改表格
//   - system 提示词含「转述」      → 返回题目文字的转述结果
//   - 其余                         → 普通解题回复
//
// 起法：node scripts/mock-ai-server.js
// 然后把模型的 API 地址指向 http://127.0.0.1:9200

var http = require('http');

var PORT = Number(process.env.MOCK_AI_PORT || 9200);
// 每个流式分片的间隔（毫秒）。默认 6ms 贴近真实节奏；调大可以把流拉长，
// 方便手工验证「停止生成」「上滚不回弹」这类依赖"流还在跑"的交互。
var CHUNK_MS = Number(process.env.MOCK_CHUNK_MS || 6);

// 固定用量，便于断言计费结果
// usage 字段名必须走 OpenAI 兼容口径（prompt_cache_hit_tokens）：
// extractUsage 只认 DeepSeek 的 prompt_cache_hit_tokens 与 OpenAI 的
// prompt_tokens_details.cached_tokens，用别的字段名等于"上游没回缓存命中"，
// 计费会全部按输入价（6000 而不是 5700）——曾让冒烟断言错位一轮
var USAGE_TEXT = { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 200, total_tokens: 1500 };
var USAGE_VISION = { prompt_tokens: 2400, completion_tokens: 600, prompt_cache_hit_tokens: 0, total_tokens: 3000 };

var REPLY_TEXT = '这道题的关键是**先确定受力方向**。\n\n' +
  '提示一：把 $F$ 沿水平和竖直分解，得到 $F_x = F\\cos\\theta$。\n\n' +
  '```js\nconst fx = F * Math.cos(theta);\n```\n\n' +
  '你先按这个思路试一步，把结果发我。';

var REPLY_GRADE = '## 批改结果\n\n' +
  '| 题号 | 学生答案 | 判定 | 错因 | 正确解法 |\n' +
  '| --- | --- | --- | --- | --- |\n' +
  '| 1 | $x=3$ | ✓ | — | 移项后除以 2 |\n' +
  '| 2 | $x=5$ | ✗ | 混淆了位移与路程，第二步用了 $s=vt$ 而非 $s=\\frac{1}{2}at^2$ | 先求加速度再回代 |\n' +
  '| 3 | □(看不清) | 无法判读 | 第 3 题字迹被涂改遮挡 | — |\n\n' +
  '**小结**：对 1 题 / 共 2 题（1 题无法判读）。错题集中在运动学公式的选择上，' +
  '建议专项练「已知初速度与时间求位移」这一类题。\n\n' +
  // 这段是给后端解析用的：模拟真实模型对 <wrong-items> 约定的遵守情况
  '<wrong-items>\n' +
  '[{"subject":"物理","question":"一物体以 2 m/s 初速度匀加速运动，加速度 1 m/s²，求 3 秒内位移。",' +
  '"student_answer":"x = 5","correct_answer":"s = v₀t + ½at² = 2×3 + ½×1×9 = 10.5 m",' +
  '"reason":"混淆了位移与路程，第二步用了 s=vt 而非 s=v₀t+½at²","tag":"✗"},' +
  '{"subject":"物理","question":"求 3 秒末速度。","student_answer":"未作答",' +
  '"correct_answer":"v = v₀ + at = 2 + 1×3 = 5 m/s","reason":"漏做该小问","tag":"△"}]\n' +
  '</wrong-items>';

var REPLY_WRITING_GEN = '# 那一刻我长大了\n\n' +
  '那天傍晚，我站在厨房门口，看着母亲弯着腰在案板前切菜。\n\n' +
  '刀落下的声音一下一下，很轻，像怕吵到谁。我忽然注意到她右手的虎口有一道浅浅的疤——' +
  '那是去年冬天我发烧的那个夜里，她削苹果时划的。当时我烧得昏沉，第二天醒来只看见床头摆着一盘切好的苹果。\n\n' +
  '我走过去，从她手里接过刀。她愣了一下，说"你去写作业"。我没松手，只说了一句"今天我来"。\n\n' +
  '菜切得歪歪扭扭，但那天饭桌上的菜是热的。\n\n' +
  '（本文共约 480 字）\n\n' +
  '写作思路：用"切菜时看到虎口的疤"这个具体细节切入，把"长大"落在"接过刀"这个动作上，' +
  '而不是空洞地抒情。';

// 英文请求要回英文范文。
// 这个区分本身也是测试点：如果 Cluss 没把 language 传进提示词，
// mock 就收不到英文任务标记，测试会立刻发现。
var REPLY_WRITING_GEN_EN = '# A Memorable Trip\n\n' +
  'We left before dawn, when the streets were still empty and the air smelled of rain.\n\n' +
  'My father drove without speaking. I watched the fields slide past and thought about how little ' +
  'I knew of the road he had taken every week for twenty years.\n\n' +
  'At a small station we stopped for noodles. He ordered for both of us without asking, and I realized ' +
  'he had been doing this my whole life.\n\n' +
  'We reached the coast by noon. The sea was louder than I expected.\n\n' +
  '(Word count: 96)\n\n' +
  'Approach: The essay avoids stating "this trip was meaningful". Instead it builds meaning through ' +
  'three small concrete details, letting the reader draw the conclusion.';


var REPLY_WRITING_GRADE = '### 逐段点评\n\n' +
  '| 段落 | 写得好的地方 | 存在的问题 | 具体建议 |\n' +
  '| --- | --- | --- | --- |\n' +
  '| 第 1 段 | 开头用场景切入，画面感强 | 转折突然，缺少过渡 | 补一句交代"我"当时的心境 |\n' +
  '| 第 2 段 | 细节真实 | 段落过长，一个自然段塞了三件事 | 拆成两段 |\n\n' +
  '### 三个维度\n\n' +
  '- 内容与立意：**良**，主题清晰，但立意停留在表层\n' +
  '- 结构与逻辑：**待改进**，第 2 段信息过载\n' +
  '- 语言表达：**优**，用词准确，句式有变化\n\n' +
  '### 润色示例\n\n' +
  '- 原文：我很感动。\n' +
  '- 改后：喉咙像被什么堵住，我别过头去。\n' +
  '- 为什么这样改：直接说"感动"是结论，读者感受不到；用生理反应替代判断，画面才立得住。\n\n' +
  '### 总评\n\n' +
  '最该改的是第 2 段——把它拆成两段，让"看到疤"和"接过刀"各自成一节，节奏会好很多。';

var REPLY_WRITING_OUTLINE = '## 写作提纲\n\n' +
  '### 开头（约 100 字）\n' +
  '- 要做的事：用一个具体场景切入，不要先讲道理\n' +
  '- 素材方向：一个动作、一个物件、一个声音（如"刀落在案板上的声音"）\n' +
  '- 可选切入：① 从声音写起 ② 从一个物件写起\n\n' +
  '### 主体一（约 200 字）\n' +
  '- 要做的事：交代"我"原本的状态与那个细节的相遇\n' +
  '- 素材方向：写自己当时的走神、漠然，与后来注意到细节形成对照\n\n' +
  '### 主体二（约 200 字）\n' +
  '- 要做的事：写出转变的那个动作\n' +
  '- 素材方向：一个具体的动作（接过刀 / 倒了杯水 / 说了某句话），不要写"我突然懂了"这类心理独白\n\n' +
  '### 结尾（约 100 字）\n' +
  '- 要做的事：收在具体的画面上\n' +
  '- 升华方向：① 回到开头的意象 ② 用一个日常细节收束\n\n' +
  '写的时候按这个提纲自己展开，写完可以发来批改。';

var REPLY_DESCRIBE = '这是一张数学题目照片。\n' +
  '1) 题目内容：已知函数 $f(x)=x^2-2ax+3$，求其在区间 $[0,2]$ 上的最小值。\n' +
  '2) 图中标注：题号 3，配有一个抛物线示意图。\n' +
  '3) 无手写笔迹。';

function detectKind(messages, rawBody) {
  var hasImage = false;
  var texts = [];
  var systemText = '';
  var userText = '';

  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.role === 'system') systemText += ' ' + String(m.content || '');
    if (m.role === 'user') {
      if (typeof m.content === 'string') userText += ' ' + m.content;
      else if (Array.isArray(m.content)) {
        for (var u = 0; u < m.content.length; u++) {
          if (m.content[u].type === 'text') userText += ' ' + (m.content[u].text || '');
        }
      }
    }
    if (typeof m.content === 'string') {
      texts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (var j = 0; j < m.content.length; j++) {
        if (m.content[j].type === 'image_url') hasImage = true;
        if (m.content[j].type === 'text') texts.push(m.content[j].text || '');
      }
    }
  }

  // 判定优先级：先看 system 提示词（决定任务类型），再看有没有图。
  // 反过来的话，「带图批改」「看图作文」都会被误判成「看图解题」——
  // 真实模型是按提示词走的，mock 必须复现这个行为，否则测试会给出假阴性。
  //
  // 作文要在「批改」之前判：写作批改的提示词里也含「批改」二字。
  if (/列写作提纲/.test(systemText)) {
    return { kind: 'writing_outline', hasImage: hasImage, systemText: systemText, userText: userText };
  }
  if (/批改作文/.test(systemText)) {
    return { kind: 'writing_grade', hasImage: hasImage, systemText: systemText, userText: userText };
  }
  if (/写一篇作文|Write an essay/.test(systemText)) {
    // 用是否带英文任务标记来区分中英文——这同时验证了 Cluss 把 language 传进了提示词
    var isEnglish = /Write an essay in English|Write the entire response in English/.test(systemText);
    return {
      kind: isEnglish ? 'writing_generate_en' : 'writing_generate',
      hasImage: hasImage, systemText: systemText, userText: userText
    };
  }
  if (/转述器/.test(systemText)) {
    return { kind: 'describe', hasImage: hasImage, systemText: systemText, userText: userText };
  }
  if (/批改下面图片|任务：作业批改/.test(systemText)) {
    return { kind: 'grade', hasImage: hasImage, systemText: systemText, userText: userText };
  }
  if (hasImage) {
    return { kind: 'native_vision', hasImage: true, systemText: systemText, userText: userText };
  }
  return { kind: 'text', hasImage: false, systemText: systemText, userText: userText };
}

function pickReply(info) {
  if (info.kind === 'native_vision') {
    return '【已收到图片】本次共收到 1 张图。\n\n' + REPLY_TEXT;
  }
  if (info.kind === 'describe') return REPLY_DESCRIBE;
  if (info.kind === 'grade') return REPLY_GRADE;
  if (info.kind === 'writing_generate') return REPLY_WRITING_GEN;
  if (info.kind === 'writing_generate_en') return REPLY_WRITING_GEN_EN;
  if (info.kind === 'writing_grade') return REPLY_WRITING_GRADE;
  if (info.kind === 'writing_outline') return REPLY_WRITING_OUTLINE;
  return REPLY_TEXT;
}

function pickUsage(info) {
  return info.hasImage ? USAGE_VISION : USAGE_TEXT;
}

// 最近一次收到的请求。用途：验证脚本可以断言「模型到底收到了什么」，
// 而不是只看「有没有返回 200」——提示词改动是否真的生效，只能这样验。
var lastRequest = null;

var server = http.createServer(function(req, res) {
  // GET /__last：回放最近一次请求（messages 原样返回）
  if (req.method === 'GET' && req.url.indexOf('/__last') === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(lastRequest || {}));
  }

  if (req.method !== 'POST') {
    res.writeHead(404);
    return res.end('not found');
  }

  var body = '';
  req.on('data', function(c) { body += c; });
  req.on('end', function() {
    var payload = {};
    try { payload = JSON.parse(body); } catch (e) {}

    var messages = payload.messages || [];
    // 记录请求头，好让验证脚本能断言"会话标识有没有发出来"。
    // authorization 脱敏：它虽然是测试用的假 key，但没必要进回放。
    var safeHeaders = {};
    Object.keys(req.headers || {}).forEach(function(k) {
      if (k.toLowerCase() === 'authorization') return;
      safeHeaders[k] = req.headers[k];
    });
    lastRequest = {
      at: new Date().toISOString(),
      model: payload.model || '',
      headers: safeHeaders,
      messages: messages
    };
    var info = detectKind(messages, payload);
    var reply = pickReply(info);
    var usage = pickUsage(info);

    if (!payload.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        model: payload.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: usage
      }));
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // 逐块下发正文，模拟真实流式的到达节奏。
    // MOCK_CHUNK_MS 可放大间隔，用来测「停止生成」这类需要流还在跑的场景。
    var chunks = reply.match(/[\s\S]{1,24}/g) || [];
    var i = 0;
    var timer = setInterval(function() {
      if (i >= chunks.length) {
        clearInterval(timer);
        // 末尾用量块（对应 stream_options.include_usage）
        res.write('data: ' + JSON.stringify({
          id: 'mock-1', object: 'chat.completion.chunk', model: payload.model || 'mock',
          choices: [], usage: usage
        }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.write('data: ' + JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion.chunk',
        model: payload.model || 'mock',
        choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }]
      }) + '\n\n');
      i++;
    }, CHUNK_MS);
  });
});

server.listen(PORT, '127.0.0.1', function() {
  console.log('[mock-ai] 已启动: http://127.0.0.1:' + PORT);
  console.log('[mock-ai] 文本用量: prompt=' + USAGE_TEXT.prompt_tokens + ' completion=' + USAGE_TEXT.completion_tokens);
  console.log('[mock-ai] 视觉用量: prompt=' + USAGE_VISION.prompt_tokens + ' completion=' + USAGE_VISION.completion_tokens);
  console.log('[mock-ai] 支持识别: native_vision / describe / grade / text');
});