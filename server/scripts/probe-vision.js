// 探测一个上游到底能不能"看见"图片
//
// 为什么需要这个：很多 OpenAI 兼容的上游**接受** image_url 内容块、也回 200，
// 但内部把图片悄悄丢掉。表现是——模型对着一个它根本没看到的题一本正经地作答。
// 对拍题和批改来说，这比直接报错危险得多。
//
// 做法：生成一张带**随机四位数**的图片发过去，问它数字是多少。
//   答对        → 真的能看图
//   答"看不到"  → 不支持（图片被丢弃）
//   答别的      → 存疑，需要人工看原图核对
// 随机数是关键：模型不可能猜中，所以"答对"是有意义的证据。
//
// 用法：
//   node scripts/probe-vision.js <apiUrl> <apiKey> <modelName>
//   node scripts/probe-vision.js --model ds-web        # 直接测库里已配置的模型
//
// 退出码：0 = 支持视觉，1 = 不支持或存疑（可直接用于 CI / 部署前自检）

require('dotenv').config();

var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');

// ---------------- 最小 PNG 编码器（灰度、无滤波，不引第三方依赖） ----------------
var CRC_TABLE = (function() {
  var t = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var t = Buffer.from(type, 'ascii');
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// 5x7 点阵数字
var FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100']
};

function makeDigitPng(code) {
  var scale = 12, pad = 6;
  var glyphW = 5 * scale, glyphH = 7 * scale, gap = scale;
  var w = pad * 2 + code.length * glyphW + (code.length - 1) * gap;
  var h = pad * 2 + glyphH;

  var px = [];
  for (var y = 0; y < h; y++) {
    var row = [];
    for (var x = 0; x < w; x++) row.push(255);
    px.push(row);
  }

  for (var i = 0; i < code.length; i++) {
    var g = FONT[code[i]];
    var ox = pad + i * (glyphW + gap);
    for (var gy = 0; gy < 7; gy++) {
      for (var gx = 0; gx < 5; gx++) {
        if (g[gy][gx] !== '1') continue;
        for (var sy = 0; sy < scale; sy++) {
          for (var sx = 0; sx < scale; sx++) px[pad + gy * scale + sy][ox + gx * scale + sx] = 0;
        }
      }
    }
  }

  var raw = Buffer.alloc(h * (w + 1));
  for (var yy = 0; yy < h; yy++) {
    raw[yy * (w + 1)] = 0;
    for (var xx = 0; xx < w; xx++) raw[yy * (w + 1) + 1 + xx] = px[yy][xx];
  }

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------- 目标解析 ----------------
function resolveTarget() {
  var args = process.argv.slice(2);

  if (args[0] === '--model') {
    var ai = require('../src/services/ai');
    var m = ai.resolveModel(String(args[1] || ''));
    if (!m) {
      console.error('找不到模型：' + args[1]);
      process.exit(1);
    }
    // 用 normalizeEndpoint 同样的规则拼出 chat/completions 路径
    var base = String(m.apiUrl || '').replace(/\/+$/, '');
    if (!/\/chat\/completions$/i.test(base)) {
      base = /\/v\d+[a-z]*$/i.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
    }
    return { url: base, key: m.apiKey, model: m.modelName || m.id, label: m.id };
  }

  if (args.length < 3) {
    console.error('用法：node scripts/probe-vision.js <apiUrl> <apiKey> <modelName>');
    console.error('  或：node scripts/probe-vision.js --model <已配置的模型 ID>');
    process.exit(1);
  }
  var u = args[0].replace(/\/+$/, '');
  if (!/\/chat\/completions$/i.test(u)) {
    u = /\/v\d+[a-z]*$/i.test(u) ? u + '/chat/completions' : u + '/v1/chat/completions';
  }
  return { url: u, key: args[1], model: args[2], label: args[2] };
}

// ---------------- 探测主流程（CLI 与进程内调用共用） ----------------
// opts: { url, key, model } —— url 是补全过的 /chat/completions 端点
// 返回 Promise<{ supported, pngPath }>：
//   supported = true   支持视觉（读出了随机数字）
//   supported = false  确认不支持 / 上游拒绝
//   supported = null   存疑 / 上游不可达
function probe(opts) {
  var target = { url: opts.url, key: opts.key, model: opts.model };
  // 随机数字用密码学随机：虽然这不是密钥，但"猜不中"是整个判定的证据链，
  // 随机源本身不能有可预测性（Math.random 可被还原内部状态）
  var code = String(crypto.randomInt(1000, 10000));
  var png = makeDigitPng(code);

  // 把图落盘：判定为"存疑"时，人需要亲眼看这张图才能下结论。
  // 用一个新建的临时子目录 + 固定文件名：拼进路径的都是本进程生成的字面量，
  // 不把任何外部输入带进文件路径
  var pngPath = '(写入失败)';
  try {
    var probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluss-vision-probe-'));
    pngPath = path.join(probeDir, 'question.png');
    fs.writeFileSync(pngPath, png);
  } catch (e) { /* 写不进去也不影响探测，只是"存疑"时没有图可核对 */ }

  console.log('\n探测上游是否支持视觉');
  console.log('  端点  : ' + target.url);
  console.log('  模型  : ' + target.model);
  console.log('  目标  : 图片内容是四位数 ' + code);
  console.log('  原图  : ' + pngPath + '   ← 存疑时请打开核对\n');

  var payload = {
    model: target.model,
    stream: false,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图里的数字是多少？只回答那几位数字。如果你看不到图片，就只回答四个字：看不到图片' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } }
      ]
    }]
  };

  return fetch(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + target.key },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000)
  }).then(function(r) {
    return r.text().then(function(t) { return { status: r.status, body: t }; });
  }).then(function(res) {
    if (res.status !== 200) {
      console.log('HTTP ' + res.status + ' ' + res.body.slice(0, 200));
      console.log('\n★ 结论：不支持 —— 上游直接拒绝了带图片的请求');
      return { supported: false, pngPath: pngPath };
    }

    var text = '';
    try {
      var j = JSON.parse(res.body);
      if (j.error) console.log('上游返回 error:', JSON.stringify(j.error));
      text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    } catch (e) {
      console.log('非 JSON 响应：' + res.body.slice(0, 200));
    }

    console.log('模型回复：' + JSON.stringify(text) + '\n');

    if (text.indexOf(code) >= 0) {
      console.log('★ 结论：**支持视觉**（读出了随机数字 ' + code + '）');
      console.log('  → 可以在管理台把该模型的「支持视觉」打开');
      return { supported: true, pngPath: pngPath };
    }
    if (/看不到|无法查看|没有收到|未收到|无法识别|不能看到/.test(text)) {
      console.log('★ 结论：**不支持视觉** —— 请求返回 200，但图片被上游丢掉了。');
      console.log('  这类失败最危险：它不会报错，模型会对着没看到的题硬答。');
      console.log('  → 不要打开「支持视觉」；拍题/批改请改用「转述模型」兜底（管理台「视觉配置」）');
      return { supported: false, pngPath: pngPath };
    }

    console.log('★ 结论：**存疑** —— 回复里既没有那个数字，也没明确说看不到。');
    console.log('  请打开原图（' + pngPath + '）确认它是否清晰，再手工判断。');
    return { supported: null, pngPath: pngPath };
  }).catch(function(e) {
    console.log('请求失败：' + e.message);
    console.log('\n★ 结论：无法判定（上游不可达或超时）');
    return { supported: null, pngPath: pngPath };
  });
}

// ---------------- CLI 入口 ----------------
// 也支持从环境变量读目标（CLUS_PROBE_URL / CLUS_PROBE_KEY / CLUS_PROBE_MODEL）：
// 方便其它进程内脚本复用探测能力，也方便 shell 一键调用
if (require.main === module) {
  var target;
  if (process.env.CLUS_PROBE_URL) {
    var u = process.env.CLUS_PROBE_URL.replace(/\/+$/, '');
    if (!/\/chat\/completions$/i.test(u)) {
      u = /\/v\d+[a-z]*$/i.test(u) ? u + '/chat/completions' : u + '/v1/chat/completions';
    }
    target = { url: u, key: process.env.CLUS_PROBE_KEY || '', model: process.env.CLUS_PROBE_MODEL || '' };
  } else {
    target = resolveTarget();
  }
  probe(target).then(function(r) {
    // 用 exitCode + 自然退出，**不要** process.exit()。
    // 原因：fetch 的连接句柄在 process.exit() 时还没关，Windows 上会触发
    // libuv 断言（Assertion failed: UV_HANDLE_CLOSING）并让进程以**非 0 退出**——
    // 于是调用方（connect-*.js）把"探测通过"误读成"不支持"，静默写成视觉=关。
    // 这个 bug 真发生过：探针明明读出了随机数字，落库却是「视觉=关」。
    process.exitCode = r.supported === true ? 0 : 1;
  });
}

module.exports = { probe: probe };
