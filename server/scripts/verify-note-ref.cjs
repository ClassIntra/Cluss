/**
 * 引用笔记两条链路的端到端验证
 *
 * 修的两个 bug：
 *   1. 只引笔记不写字 → 服务端误杀「消息内容不能为空」
 *      （空内容判定只看文字和图片，没算 note_ids）
 *   2. 引用了笔记 AI 却说"看不见" —— 画像段写着
 *      「你只知道笔记的标题与分类，并不知道正文」，与同一条消息里注入的
 *      【我引用的笔记】正文自相矛盾，模型按更保守的那条执行
 *
 * 用回显 mock：它把收到的完整 prompt 原样回吐成回复，
 * 断言「模型实际看到什么」而不是猜。
 *
 * 跑法：node server/scripts/verify-note-ref.cjs [baseUrl]
 * 前置：mock-echo-server(MOCK_ECHO_PORT=9217) + 实例(9060, 模型指向 mock)
 */
const http = require('http');

const BASE = process.argv[2] || 'http://127.0.0.1:9060';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); }
}

function post(path, body, token) {
  return new Promise(function (resolve, reject) {
    const data = JSON.stringify(body);
    const u = new URL(BASE + path);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: headers
    }, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: d }); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// SSE 流式收完，把 delta 拼成整段回复
function sendStream(body, token) {
  return new Promise(function (resolve, reject) {
    const data = JSON.stringify(body);
    const u = new URL(BASE + '/api/chat/stream');
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        token ? { Authorization: 'Bearer ' + token } : {})
    }, function (res) {
      let d = '', reply = '', meta = null, errorEvent = null;
      res.on('data', function (c) {
        d += c;
        let idx;
        while ((idx = d.indexOf('\n\n')) >= 0) {
          const frame = d.slice(0, idx); d = d.slice(idx + 2);
          const evLine = frame.split('\n').find(function (l) { return l.indexOf('event:') === 0; });
          const dataLine = frame.split('\n').find(function (l) { return l.indexOf('data:') === 0; });
          if (!evLine || !dataLine) continue;
          const ev = evLine.slice(6).trim();
          let payload = {};
          try { payload = JSON.parse(dataLine.slice(5).trim()); } catch (e) { continue; }
          if (ev === 'delta') reply += payload.text || '';
          else if (ev === 'meta') meta = payload;
          else if (ev === 'error') errorEvent = payload.message;
        }
      });
      res.on('end', function () { resolve({ status: res.statusCode, reply: reply, meta: meta, error: errorEvent }); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async function () {
  console.log('引用笔记端到端验证\n');

  // 登录
  const login = await post('/api/auth/login', { account: 'uitester', password: 'Test1234' });
  const token = (JSON.parse(login.body).data || {}).token;
  if (!token) { console.error('登录失败'); process.exit(2); }

  // 造一篇云笔记（与前端同口径：客户端生成字符串 id）
  const noteId = 'note_e2e_nr_' + Date.now();
  const mk = await post('/api/notes/notes', {
    id: noteId,
    title: ' NR验证笔记 ',
    content: 'MARKER_NR_7391 这是引用链路验证笔记的正文，包含一个独特标记。',
    tags: [], type: 'note'
  }, token);
  const mkOk = mk.status === 200 && JSON.parse(mk.body).code === 200;
  check('前置：云笔记已创建', mkOk, mk.body.substring(0, 60));

  // ---- 1. 只引笔记，不写字（曾被误杀）----
  console.log('\n【1】只引笔记、不写字（空内容 + note_ids）');
  const r1 = await sendStream({ content: '', note_ids: [noteId] }, token);
  check('请求不被拒（HTTP 200）', r1.status === 200, 'HTTP ' + r1.status);
  check('没有「消息内容不能为空」错误', !(r1.error || '').includes('不能为空'), r1.error || '无错误事件');
  check('回复含笔记正文标记（模型真看到了）', r1.reply.indexOf('MARKER_NR_7391') >= 0,
    r1.reply ? '回复 ' + r1.reply.length + ' 字' : '回复为空');

  // ---- 2. 措辞分流：引用时说"看得到"，未引用说"并不知道正文" ----
  console.log('\n【2】画像措辞随是否引用而分流');
  check('引用时：画像改口「你**看得到**」', r1.reply.indexOf('看得到') >= 0 &&
    r1.reply.indexOf('并不知道正文') < 0,
    r1.reply.indexOf('看得到') >= 0 ? '已改口' : '仍是旧措辞');

  const r2 = await sendStream({ content: '二次函数怎么求最值？', note_ids: [] }, token);
  check('未引用时：保留「并不知道正文」防编造', r2.reply.indexOf('并不知道正文') >= 0 &&
    r2.reply.indexOf('看得到') < 0,
    r2.reply.indexOf('并不知道正文') >= 0 ? '正确' : '措辞异常');

  // ---- 3. 带文字 + 笔记（常规用法不回归）----
  console.log('\n【3】文字 + 笔记常规用法');
  const r3 = await sendStream({ content: '结合我的笔记讲讲', note_ids: [noteId] }, token);
  check('请求成功', r3.status === 200 && !r3.error, r3.error || '');
  check('笔记正文在 prompt 里', r3.reply.indexOf('MARKER_NR_7391') >= 0);
  check('措辞同样是「看得到」', r3.reply.indexOf('看得到') >= 0);

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) { console.error('失败:', e.message); process.exit(2); });