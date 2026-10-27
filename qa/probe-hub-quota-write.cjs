// 端到端验：中枢给 8 班学生改额度 —— 目标学号 250801（陈玥，现 ¥1）
//
// 「管死」有两个半边：① 节点不能自充（已验）；② 中枢能改、且改得动。
// 只验①那叫冻死，不是管死。这里验②。
//
// 用的是 HTTP 打本机 9003（真实链路，不是直接改库），测完严格复位。
// 注意：只动 250801 这种小额账号，绝不碰那两个 6667。
const http = require('http');
const fs = require('fs');
const path = require('path');

var ROOT = path.join(__dirname, '..');
var SERVER = path.join(ROOT, 'server');
fs.readFileSync(path.join(SERVER, '.env'), 'utf8').split(/\r?\n/).forEach(function (line) {
  var m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
});
process.env.DB_PATH = path.join(SERVER, 'database', 'cluss.db');

var BASE = 'http://127.0.0.1:9003';
var TARGET = '250801';

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

function req(method, p, body) {
  return new Promise(function (res, rej) {
    var data = body ? JSON.stringify(body) : null;
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    var r = http.request(BASE + p, opts, function (s) {
      var b = '';
      s.on('data', d => b += d);
      s.on('end', () => res({ status: s.statusCode, body: b }));
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

var loginCookie = '';
async function login() {
  var r = await req('POST', '/api/auth/login', { account: '999999', password: 'admin12345' });
  var d = JSON.parse(r.body || '{}');
  var token = (d.data && (d.data.token || d.data.access_token)) || d.token || d.access_token || '';
  loginCookie = token ? ('token=' + token + '; cluss_token=' + token) : '';
  ok('中枢管理员登录', r.status === 200 && !!token, 'HTTP ' + r.status + ' token=' + (token ? '有' : '无'));
  return token;
}

(async function () {
  console.log('=== 中枢侧：给 8 班学生改额度 ===\n');
  var token = await login();
  if (!token) { console.log('登录失败，中止'); process.exit(1); }

  // 带 token 的请求
  function areq(method, p, body) {
    return new Promise(function (res, rej) {
      var data = body ? JSON.stringify(body) : null;
      var opts = { method: method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token } };
      if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
      var r = http.request(BASE + p, opts, function (s) {
        var b = ''; s.on('data', d => b += d); s.on('end', () => res({ status: s.statusCode, body: b }));
      });
      r.on('error', rej);
      if (data) r.write(data);
      r.end();
    });
  }

  // 1. 中枢用户列表里能看到 8 班学生吗
  var lu = await areq('GET', '/api/admin/users?keyword=' + TARGET);
  var d1 = JSON.parse(lu.body || '{}');
  var list = (d1.data && (d1.data.users || d1.data.list)) || d1.users || [];
  var row = list.filter(function (x) { return String(x.user_id) === TARGET; })[0];
  ok('中枢能看到 8 班学号 ' + TARGET, !!row,
    row ? (row.real_name + ' 现 ¥' + (row.allocated_yuan !== undefined ? row.allocated_yuan : (Number(row.allocated_micro || 0) / 1e6).toFixed(2))) : 'HTTP ' + lu.status + ' ' + String(lu.body).slice(0, 120));

  if (!row) {
    // 也许字段不同，把第一条打出来看看结构
    if (list.length) console.log('  样例行: ' + JSON.stringify(list[0]).slice(0, 300));
    console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(0);
  }

  var beforeMicro = Number(row.allocated_micro !== undefined ? row.allocated_micro : Math.round(Number(row.allocated_yuan || 0) * 1e6));

  // 2. 中枢给这个 8 班学生追加 1 元
  var top = await areq('PUT', '/api/admin/users/' + TARGET + '/quota', { quota_yuan: 1, reason: '锁的连通性验证（验完复位）' });
  var d2 = JSON.parse(top.body || '{}');
  ok('中枢追加充值返回 200', top.status === 200, 'HTTP ' + top.status + ' ' + (d2.message || '').slice(0, 100));

  // 3. 账本上真的加了吗
  var lu2 = await areq('GET', '/api/admin/users?keyword=' + TARGET);
  var d3 = JSON.parse(lu2.body || '{}');
  var list2 = (d3.data && (d3.data.users || d3.data.list)) || d3.users || [];
  var row2 = list2.filter(function (x) { return String(x.user_id) === TARGET; })[0];
  var afterMicro = row2 ? Number(row2.allocated_micro !== undefined ? row2.allocated_micro : Math.round(Number(row2.allocated_yuan || 0) * 1e6)) : -1;
  ok('账本 +1 元生效', afterMicro === beforeMicro + 1000000,
    beforeMicro / 1e6 + ' → ' + afterMicro / 1e6);

  // 4. 复位：收回这 1 元，回到原值
  //    收回接口会归零，所以这里改用「先收回再补回原值」两步
  var rev = await areq('DELETE', '/api/admin/users/' + TARGET + '/quota', { reason: '验证复位' });
  ok('中枢收回返回 200', rev.status === 200, 'HTTP ' + rev.status + ' ' + (JSON.parse(rev.body || '{}').message || '').slice(0, 80));

  if (beforeMicro > 0) {
    var back = await areq('PUT', '/api/admin/users/' + TARGET + '/quota', { quota_yuan: beforeMicro / 1e6, reason: '验证复位' });
    ok('复位到原值', back.status === 200, 'HTTP ' + back.status);
  }
  var lu3 = await areq('GET', '/api/admin/users?keyword=' + TARGET);
  var d4 = JSON.parse(lu3.body || '{}');
  var list3 = (d4.data && (d4.data.users || d4.data.list)) || d4.users || [];
  var row3 = list3.filter(function (x) { return String(x.user_id) === TARGET; })[0];
  var finalMicro = row3 ? Number(row3.allocated_micro !== undefined ? row3.allocated_micro : Math.round(Number(row3.allocated_yuan || 0) * 1e6)) : -1;
  ok('最终复位到原值 ' + beforeMicro / 1e6 + ' 元', finalMicro === beforeMicro, beforeMicro / 1e6 + ' → ' + finalMicro / 1e6);

  console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
})().catch(function (e) {
  console.error('探针异常:', e.message);
  process.exit(1);
});
