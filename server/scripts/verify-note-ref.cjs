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
 * ⚠️ 为什么不用管理员账号跑对话：
 *    user-profile.buildProfile 对 is_admin=1 的账号**直接返回 null**（管理员不刷题，
 *    给他算画像没有意义）。用管理员登录时画像段整段缺席，第 2 组措辞断言必然失败，
 *    而且失败信息会指向"措辞没改口"，完全误导。
 *    所以本脚本自建一个探针学生（register + 复用），由管理员给它充值，
 *    再用学生身份发问 —— 这样断言的才是真实学生的链路。
 *
 * 跑法：node server/scripts/verify-note-ref.cjs [baseUrl]
 * 前置：mock-echo-server(MOCK_ECHO_PORT=9217) + 实例(9050, 模型指向 mock)，
 *       且实例的管理员账号为 uitester/Test1234（用于给探针学生充值）
 */
const http = require('http');

const BASE = process.argv[2] || 'http://127.0.0.1:9060';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); }
}

function post(path, body, token) {
  return request('POST', path, body, token);
}

function request(method, path, body, token) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : '';
    const u = new URL(BASE + path);
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method,
      headers: headers
    }, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: d }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function dataOf(res) {
  try { return (JSON.parse(res.body) || {}).data || {}; } catch (e) { return {}; }
}

// 探针学生：固定网名/姓名，重复跑不重复建号（register 冲突则直接登录）。
const STU_NET = 'nr_probe_student';
const STU_NAME = '笔记引用探针';
const STU_PWD = 'Test1234';

// 拿到一个**学生**身份（不是管理员）。返回 { token, userId }。
async function ensureStudent(adminToken) {
  const lg = await post('/api/auth/login', { account: STU_NET, password: STU_PWD });
  const lgData = dataOf(lg);
  if (lgData.token) {
    return { token: lgData.token, userId: (lgData.user_info || {}).user_id, created: false };
  }

  const reg = await post('/api/auth/register', {
    net_name: STU_NET, real_name: STU_NAME, password: STU_PWD, confirm_password: STU_PWD,
    enrollment_year: new Date().getFullYear(), class_no: 9
  });
  const regData = dataOf(reg);
  if (!regData.token) {
    throw new Error('探针学生注册失败：' + (JSON.parse(reg.body) || {}).message);
  }
  const userId = (regData.user_info || {}).user_id;

  // 充值：对话要扣费，余额为 0 会直接 402。
  // 只在余额确实不够时充，避免反复跑把额度越堆越高。
  const put = await request('PUT', '/api/admin/users/' + encodeURIComponent(userId) + '/quota',
    { quota_yuan: 100, reason: 'verify-note-ref 探针学生' }, adminToken);
  if (put.status !== 200) {
    throw new Error('探针学生充值失败：HTTP ' + put.status + ' ' + put.body.substring(0, 120));
  }
  return { token: regData.token, userId: userId, created: true };
}

// 老账号复跑时余额可能已被上一轮用掉，补一次（够用就不补）。
async function ensureBalance(adminToken, userId) {
  const q = await request('GET', '/api/admin/users?keyword=' + encodeURIComponent(userId), null, adminToken);
  const list = (dataOf(q).users || []);
  const row = list.filter(function (u) { return u.user_id === userId; })[0];
  if (row && (row.allocated_micro - row.used_micro) >= 5000000) return 0;
  const put = await request('PUT', '/api/admin/users/' + encodeURIComponent(userId) + '/quota',
    { quota_yuan: 100, reason: 'verify-note-ref 探针学生补额' }, adminToken);
  return put.status === 200 ? 100 : -1;
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

  // 管理员只用来给探针学生充值；对话一律用学生身份（管理员没有画像）
  const adminLogin = await post('/api/auth/login', { account: 'uitester', password: 'Test1234' });
  const adminToken = dataOf(adminLogin).token;
  if (!adminToken) { console.error('管理员登录失败（需要 uitester/Test1234 给探针学生充值）'); process.exit(2); }

  const stu = await ensureStudent(adminToken);
  console.log('探针学生：' + stu.userId + (stu.created ? '（本轮新建）' : '（复用）'));
  const topped = await ensureBalance(adminToken, stu.userId);
  if (topped < 0) { console.error('探针学生余额不足且充值失败'); process.exit(2); }
  console.log('余额：' + (topped > 0 ? '已充值 ¥' + topped : '充足') + '\n');
  const token = stu.token;

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
  // 前置断言：画像段真的进了 prompt。缺席时下面的措辞断言会以"仍是旧措辞"报错，
  // 把根因（账号没有画像 / 开关关了 / 学生偏好关掉了学习记录）掩盖成措辞问题。
  check('前置：画像段已进 prompt', r1.reply.indexOf('【关于这个学生】') >= 0,
    r1.reply.indexOf('【关于这个学生】') >= 0 ? '在场' : '缺席（查 is_admin / useRecords 开关）');
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