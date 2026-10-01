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

// 固定用量，便于断言计费结果
var USAGE_TEXT = { prompt_tokens: 1000, completion_tokens: 500, cache_hit_tokens: 200, total_tokens: 1500 };
var USAGE_VISION = { prompt_tokens: 2400, completion_tokens: 600, cache_hit_tokens: 0, total_tokens: 3000 };

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
  '建议专项练「已知初速度与时间求位移」这一类题。';

var REPLY_DESCRIBE = '这是一张数学题目照片。\n' +
  '1) 题目内容：已知函数 $f(x)=x^2-2ax+3$，求其在区间 $[0,2]$ 上的最小值。\n' +
  '2) 图中标注：题号 3，配有一个抛物线示意图。\n' +
  '3) 无手写笔迹。';

function detectKind(messages, rawBody) {
  var hasImage = false;
  var texts = [];
  var systemText = '';

  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.role === 'system') systemText += ' ' + String(m.content || '');
    if (typeof m.content === 'string') {
      texts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (var j = 0; j < m.content.length; j++) {
        if (m.content[j].type === 'image_url') hasImage = true;
        if (m.content[j].type === 'text') texts.push(m.content[j].text || '');
      }
    }
  }

  // 判定优先级很重要：先看 system 提示词（决定任务类型），再看有没有图。
  // 反过来的话，「带图批改」会被误判成「看图解题」——
  // 真实模型是按提示词走的，mock 必须复现这个行为，否则测试会给出假阴性。
  if (/转述器/.test(systemText)) return { kind: 'describe', hasImage: hasImage, systemText: systemText };
  if (/批改/.test(systemText)) return { kind: 'grade', hasImage: hasImage, systemText: systemText };
  if (hasImage) return { kind: 'native_vision', hasImage: true, systemText: systemText };
  return { kind: 'text', hasImage: false, systemText: systemText };
}

function pickReply(info) {
  if (info.kind === 'native_vision') {
    return '【已收到图片】本次共收到 ' + '1 张图' + '。\n\n' + REPLY_TEXT;
  }
  if (info.kind === 'describe') return REPLY_DESCRIBE;
  if (info.kind === 'grade') return REPLY_GRADE;
  return REPLY_TEXT;
}

function pickUsage(info) {
  return info.hasImage ? USAGE_VISION : USAGE_TEXT;
}

var server = http.createServer(function(req, res) {
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

    // 逐块下发正文，模拟真实流式的到达节奏
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
    }, 6);
  });
});

server.listen(PORT, '127.0.0.1', function() {
  console.log('[mock-ai] 已启动: http://127.0.0.1:' + PORT);
  console.log('[mock-ai] 文本用量: prompt=' + USAGE_TEXT.prompt_tokens + ' completion=' + USAGE_TEXT.completion_tokens);
  console.log('[mock-ai] 视觉用量: prompt=' + USAGE_VISION.prompt_tokens + ' completion=' + USAGE_VISION.completion_tokens);
  console.log('[mock-ai] 支持识别: native_vision / describe / grade / text');
});