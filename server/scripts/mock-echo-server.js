/**
 * 抓包式 mock 上游：原样回显 Cluss 发来的完整请求体
 *
 * 用途：验证「引用笔记 → 发送」端到端时，笔记正文是否真的进了发给上游的
 * messages 里。普通 mock 只回固定答案，看不出上下文装了什么；
 * 这个版本把收到的 prompt 原样吐回来，作为直接证据。
 *
 * 起法：node server/scripts/mock-echo-server.js
 * 然后把模型的 API 地址指向 http://127.0.0.1:9201
 *
 * 同时支持两种模式：
 *   - 非流式：直接返回 JSON
 *   - 流式（body.stream=true）：按 SSE 分片吐回，最后一个分片带 usage
 */
const http = require('http');

const PORT = Number(process.env.MOCK_ECHO_PORT || 9201);

function readBody(req) {
  return new Promise(function (resolve) {
    let d = '';
    req.on('data', function (c) { d += c; });
    req.on('end', function () { resolve(d); });
  });
}

// 把整个请求渲染成一段人类可读的文本，便于 grep 断言
function renderPrompt(body) {
  const lines = [];
  lines.push('=== MOCK-ECHO 收到的完整请求 ===');
  lines.push('model: ' + (body.model || '(none)'));
  lines.push('stream: ' + !!body.stream);
  const msgs = body.messages || [];
  lines.push('messages 条数: ' + msgs.length);
  msgs.forEach(function (m, i) {
    const c = m.content;
    let text;
    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      text = c.map(function (part) {
        if (part && part.type === 'text') return part.text;
        if (part && part.type === 'image_url') return '[image_url]';
        return '[other:' + (part && part.type) + ']';
      }).join('\n');
    } else {
      text = String(c);
    }
    lines.push('');
    lines.push('--- [' + i + '] role=' + m.role + ' ---');
    lines.push(text);
  });
  lines.push('');
  lines.push('=== 请求结束 ===');
  return lines.join('\n');
}

const server = http.createServer(async function (req, res) {
  if (req.method !== 'POST') {
    res.writeHead(404).end('not found');
    return;
  }

  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }

  const rendered = renderPrompt(body);
  // 服务端日志里留一份，便于事后 grep
  console.log(rendered);

  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 500,
    total_tokens: 1500,
    prompt_cache_hit_tokens: 0
  };

  if (body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    // 分三片吐回，最后一片带 finish_reason 与 usage
    res.write('data: ' + JSON.stringify({
      id: 'echo-1', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    }) + '\n\n');

    res.write('data: ' + JSON.stringify({
      id: 'echo-1', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: { content: rendered }, finish_reason: null }]
    }) + '\n\n');

    res.write('data: ' + JSON.stringify({
      id: 'echo-1', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: usage
    }) + '\n\n');

    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'echo-1',
    object: 'chat.completion',
    model: body.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: rendered },
      finish_reason: 'stop'
    }],
    usage: usage
  }));
});

server.listen(PORT, function () {
  console.log('[mock-echo] 已启动: http://127.0.0.1:' + PORT + '（原样回显收到的 prompt）');
});