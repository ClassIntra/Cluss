// SSE 流式读取
//
// 为什么用 fetch 而不是 axios：axios 在浏览器端拿不到响应体的增量，
// 只能等整个响应结束才拿到全部内容 —— 那样就没有「流式」可言了。
// fetch + ReadableStream 才能逐块消费。
//
// 抽成工具是因为对话页与学习页都要用；两份实现迟早会在
// 「分帧边界处理」这种细节上出现差异。

// 解析单帧（一个 SSE event 块）
function parseFrame(frame, handlers) {
  var lines = String(frame).split('\n');
  var event = 'message';
  var dataLines = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf('event:') === 0) event = line.slice(6).trim();
    else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
  }

  if (!dataLines.length) return;

  var payload;
  try { payload = JSON.parse(dataLines.join('\n')); } catch (e) { return; }

  if (event === 'meta' && handlers.onMeta) handlers.onMeta(payload);
  else if (event === 'delta' && handlers.onDelta) handlers.onDelta(payload.text || '');
  // 思维链单独的事件：不是正文，不能被拼进回答里
  else if (event === 'reasoning' && handlers.onReasoning) handlers.onReasoning(payload.text || '');
  else if (event === 'status' && handlers.onStatus) handlers.onStatus(payload);
  else if (event === 'done' && handlers.onDone) handlers.onDone(payload);
  else if (event === 'error' && handlers.onError) handlers.onError(payload.message || '生成失败');
}

// 读取一个 SSE 响应流
// handlers: { onMeta, onDelta, onStatus, onDone, onError }
function readSseStream(resp, handlers) {
  var h = handlers || {};
  var reader = resp.body.getReader();
  var decoder = new TextDecoder('utf-8');
  var buffer = '';

  function pump() {
    return reader.read().then(function(result) {
      if (result.done) {
        // 收尾：可能还有没被空行分隔的尾帧
        if (buffer.trim()) parseFrame(buffer, h);
        return;
      }

      buffer += decoder.decode(result.value, { stream: true });

      // SSE 以空行分帧；最后一段可能不完整，留在 buffer 里等下一个 chunk
      var frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (var i = 0; i < frames.length; i++) {
        if (frames[i].trim()) parseFrame(frames[i], h);
      }

      return pump();
    });
  }

  return pump();
}

// 构造带鉴权的 POST 请求并发起流式对话
// 返回 Promise<Response>，调用方自行接 readSseStream
function postStream(url, token, body, signal) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  return fetch(url, {
    method: 'POST',
    headers: headers,
    credentials: 'same-origin',
    body: JSON.stringify(body),
    signal: signal
  }).then(function(resp) {
    if (resp.ok) return resp;

    // 非 2xx：后端返回 JSON 错误（402 额度不足 / 400 参数错 / 503 未配置）
    return resp.json().then(function(data) {
      var err = new Error(data.message || '请求失败');
      err.status = resp.status;
      throw err;
    }).catch(function(e) {
      if (e.status) throw e;
      var err = new Error('请求失败（' + resp.status + '）');
      err.status = resp.status;
      throw err;
    });
  });
}

export { readSseStream, postStream };