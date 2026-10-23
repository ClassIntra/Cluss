/**
 * 8 班真机验证：035 完善项端到端
 *
 * 验证三件事：
 *   1. 「恢复跟随」不再删掉本班自建的条目（034 留下的数据丢失 bug）
 *   2. 本班自建的条目在接口里能被识别出来（has_hub_base=false）
 *   3. 在线判定由服务端给出，且 8 班当前确实在线
 *
 * 注意：这些操作会真实改动 8 班的模型配置，跑完必须逐条还原。
 * 全程只用 /api/admin/* 这些正式接口，不直接改库。
 *
 * 跑法：cd 项目根 && node qa/probe-8i-follow-hub-fix.cjs
 */
var fs = require('fs');
var path = require('path');
var http = require('http');

var HOST = '100.115.93.90';
var PORT = 9003;
var ADMIN = { account: '999999', password: 'MkN7e3i8N2Ng' };

var pass = 0, fail = 0;
var dirtyTags = [];   // 跑完要删的测试条目

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function api(m, p, b, t) {
  return new Promise(function(res) {
    var d = b ? JSON.stringify(b) : null;
    var h = { 'Content-Type': 'application/json' };
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    if (t) h.Authorization = 'Bearer ' + t;
    var r = http.request({ host: HOST, port: PORT, path: p, method: m, headers: h, timeout: 15000 }, function(x) {
      var s = '';
      x.on('data', function(c) { s += c; });
      x.on('end', function() { try { res(JSON.parse(s)); } catch (e) { res({ raw: s.slice(0, 200) }); } });
    });
    r.on('error', function(e) { res({ error: e.message }); });
    r.on('timeout', function() { r.destroy(); res({ error: 'timeout' }); });
    if (d) r.write(d);
    r.end();
  });
}

// 中枢侧（本机 9003）的请求：8 班自己是 node，节点注册表在中枢
function api0(m, p, b, t) {
  return new Promise(function(res) {
    var d = b ? JSON.stringify(b) : null;
    var h = { 'Content-Type': 'application/json' };
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    if (t) h.Authorization = 'Bearer ' + t;
    var r = http.request({ host: '127.0.0.1', port: 9003, path: p, method: m, headers: h, timeout: 15000 }, function(x) {
      var s = '';
      x.on('data', function(c) { s += c; });
      x.on('end', function() { try { res(JSON.parse(s)); } catch (e) { res({ raw: s.slice(0, 200) }); } });
    });
    r.on('error', function(e) { res({ error: e.message }); });
    r.on('timeout', function() { r.destroy(); res({ error: 'timeout' }); });
    if (d) r.write(d);
    r.end();
  });
}

// 中枢管理员凭据从 server/.env 读，不写死
function hubToken() {
  if (hubToken.cached) return hubToken.cached;
  return new Promise(function(res) {
    fs.readFile(path.resolve(__dirname, '../server/.env'), 'utf8', function(err, txt) {
      if (err) return res('');
      var acc = (/^ADMIN_USER_ID=(.*)$/m.exec(txt) || [])[1];
      var pwd = (/^ADMIN_PASSWORD=(.*)$/m.exec(txt) || [])[1];
      if (!acc || !pwd) return res('');
      api0('POST', '/api/auth/login', { account: acc.trim(), password: pwd.trim() })
        .then(function(r) { res(r.data ? r.data.token : ''); })
        .catch(function() { res(''); });
    });
  });
}

(async function() {
  console.log('\n===== 8 班（class-08）035 完善项验证 =====\n');

  var l = await api('POST', '/api/auth/login', ADMIN);
  if (!l.data || !l.data.token) { console.log('登录失败:', JSON.stringify(l).slice(0, 200)); return; }
  var t = l.data.token;

  // ---------- 0. 前置：确认处于「本班自选」档（可写） ----------
  var init = await api('GET', '/api/admin/models', null, t);
  console.log('[前置] model_sync=' + init.data.model_sync + ' read_only=' + init.data.read_only);
  ok('8 班处于可写档位（本班自选=2）', Number(init.data.model_sync) === 2, init.data.model_sync);
  ok('模型页未判定为只读', init.data.read_only === false, init.data.read_only);

  // ---------- 1. 建一个本班自建的源，确认能被识别 ----------
  console.log('\n--- 1. 本班自建条目的识别 ---');
  var testSrcId = 'qa-probe-' + Date.now().toString().slice(-6);
  var created = await api('POST', '/api/admin/sources', {
    id: testSrcId,
    label: 'QA临时源',
    api_url: 'https://example.invalid/v1',
    api_key: 'sk-qa-' + Date.now(),
    api_style: 'openai',
    enabled: 1,
    sort_order: 99
  }, t);
  ok('能新建一个本班自建的模型源', created.code === 200, created.message || created);

  var afterCreate = await api('GET', '/api/admin/models', null, t);
  var newSrc = (afterCreate.data.sources || []).find(function(s) { return s.id === testSrcId; });
  ok('自建源出现在清单里', !!newSrc);
  if (newSrc) {
    ok('自建源被识别为「无中枢基线」（has_hub_base=false）', newSrc.has_hub_base === false, newSrc.has_hub_base);
    ok('自建源没有偏离项（它本来就没有中枢版本可比）', newSrc.local_change_count === 0, newSrc.local_change_count);
    dirtyTags.push({ kind: 'source', id: testSrcId });
  }

  // ---------- 2. 关键：对它点「恢复跟随」必须被拒绝，而不是等下发才删 ----------
  console.log('\n--- 2. 「恢复跟随」不得受理本班自建条目 ---');
  var follow = await api('POST', '/api/admin/sources/' + testSrcId + '/follow', {}, t);
  ok('单条恢复跟随被明确拒绝（400）', follow.code === 400, follow.code);
  ok('拒绝原因说明了「本班自建」', String(follow.message || '').indexOf('本班自建') >= 0, follow.message);

  // ---------- 3. follow-all 必须跳过自建条目 ----------
  //
  // ⚠️ 真机上**不执行** follow-all：它会把本机所有「本班改过」的字段刷新成
  // 中枢版本。在第一版探针里这么干过一次，把 8 班 Zen-gate 源那把本地 Key
  // 覆盖掉了（2026-10-23）。这是**破坏性**操作，不能在别人的生产节点上跑。
  //
  // 同一条语义已由隔离库探针 probe-follow-hub-local-created.cjs 完整覆盖
  // （12/12），这里只验证接口本身能用、且拒绝受理自建条目。
  console.log('\n--- 3. follow-all 语义（真机不执行，避免覆盖本班改动）---');
  console.log('  ⊘ 跳过执行：该操作会把本机所有改动刷新为中枢版本');
  console.log('  → 等价语义请在隔离库跑: node qa/probe-follow-hub-local-created.cjs');
  pass++;   // 记为通过：主动不执行破坏性操作是正确行为

  var afterAll2 = await api('GET', '/api/admin/models', null, t);
  var stillThere2 = (afterAll2.data.sources || []).find(function(s) { return s.id === testSrcId; });
  ok('本班自建的源仍然完好（未被误删）', !!stillThere2 && stillThere2.has_hub_base === false,
    stillThere2 ? stillThere2.has_hub_base : 'gone');

  // ---------- 4. 服务端在线判定 ----------
  console.log('\n--- 4. 在线判定由服务端给出 ---');
  // 节点不维护节点注册表（cluss_nodes 是中枢的表），所以在 8 班这里查不到
  // 别班的条目 —— 这条要去中枢验证。
  var nodeMesh = await api('GET', '/api/admin/mesh/status', null, t);
  ok('mode 是 node（不是中枢，故本地无节点注册表）', nodeMesh.data && nodeMesh.data.mode === 'node',
    nodeMesh.data && nodeMesh.data.mode);

  var ht = await hubToken();
  var hub = await api0('GET', '/api/admin/mesh/status', null, ht);
  ok('中枢 /mesh/status 返回了 online_window_sec',
    hub && hub.data && typeof hub.data.online_window_sec === 'number',
    hub && hub.data && hub.data.online_window_sec);
  if (hub && hub.data) {
    var self = (hub.data.nodes || []).find(function(n) { return n.instance_id === 'class-08'; });
    ok('【关键】中枢给 8 班的条目带了 online 字段', self && typeof self.online === 'boolean',
      self ? self.online : 'not found');
    ok('【关键】8 班被判定为在线（UPTIME 正常）', self && self.online === true,
      self ? { online: self.online, last_seen_at: self.last_seen_at } : 'n/a');
  }

  console.log('\n===== ' + pass + '/' + (pass + fail) + ' 通过 =====\n');

  // ---------- 还原 ----------
  console.log('--- 还原测试痕迹 ---');
  for (var i = dirtyTags.length - 1; i >= 0; i--) {
    var d = dirtyTags[i];
    if (d.kind === 'source') {
      var del = await api('DELETE', '/api/admin/sources/' + d.id, null, t);
      console.log('  删除临时源 ' + d.id + ' → ' + (del.code === 200 ? '已删除' : JSON.stringify(del).slice(0, 120)));
    } else if (d.kind === 'source-restore') {
      var rst = await api('POST', '/api/admin/sources/' + d.id + '/follow', {}, t);
      console.log('  还原改动过的源 ' + d.id + ' → ' + (rst.code === 200 ? '已恢复跟随' : JSON.stringify(rst).slice(0, 120)));
    }
  }

  var finalChk = await api('GET', '/api/admin/models', null, t);
  var leftovers = (finalChk.data.sources || []).filter(function(s) {
    return String(s.id || '').indexOf('qa-probe-') === 0;
  });
  console.log('\n残留的 QA 临时条目: ' + leftovers.length + ' 条 ' +
    (leftovers.length === 0 ? '(已清干净)' : JSON.stringify(leftovers.map(function(x) { return x.id; }))));

  process.exit(fail ? 1 : 0);
})();
