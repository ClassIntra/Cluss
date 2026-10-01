// 端到端测试用的 mock AI 上游（OpenAI 兼容，SSE 流式）
//
// 用途：在没有真实 API Key 的情况下验证 Cluss 的完整链路
//       「流式解析 → 用量提取 → 计费扣减 → 余额更新」。
// 不属于生产代码，正式部署不需要启动它。
//
// 启动：node scripts/mock-ai-server.js
// 然后把模型的 API 地址指向 http://127.0.0.1:9200

var http = require('http');

var PORT = Number(process.env.MOCK_AI_PORT || 9200);

// 固定用量，便于断言计费结果
var USAGE = { prompt_tokens: 1000, completion_tokens: 500, cache_hit_tokens: 200, total_tokens: 1500 };

var REPLY = '这道题的关键是**先确定受力方向**。\n\n' +
  '提示一：把 $F$ 沿水平和竖直分解，得到 $F_x = F\\cos\\theta$。\n\n' +
  '```js\nconst fx = F * Math.cos(theta);\n```\n\n' +
  '你先按这个思路试一步，把结果发我。';

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

    if (!payload.stream) {
      // 非流式（保留支持，便于将来测试降级路径）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        model: payload.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
        usage: USAGE
      }));
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // 1) 逐块下发正文（模拟真实流式的到达节奏）
    var chunks = REPLY.match(/[\s\S]{1,24}/g) || [];
    var i = 0;
    var timer = setInterval(function() {
      if (i >= chunks.length) {
        clearInterval(timer);
        // 2) 末尾用量块（对应 stream_options.include_usage）
        res.write('data: ' + JSON.stringify({
          id: 'mock-1', object: 'chat.completion.chunk', model: payload.model || 'mock',
          choices: [], usage: USAGE
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
    }, 8);
  });
});

server.listen(PORT, '127.0.0.1', function() {
  console.log('[mock-ai] 已启动: http://127.0.0.1:' + PORT);
  console.log('[mock-ai] 固定用量: prompt=' + USAGE.prompt_tokens +
    ' completion=' + USAGE.completion_tokens + ' cache_hit=' + USAGE.cache_hit_tokens);
});