// ClassIntra 联动桥（客户端方向）
//
// 作用：联动部署时，让 ClassIntra 的账号能在 Cluss 登录。
// 关键设计——**Cluss 绝不读 ClassIntra 的数据库**，只调用它的只读接口：
//   POST /api/cluss-bridge/verify  校验账号口令
// 校验通过后把用户落库到 Cluss 本地（source='classintra'），此后可离线登录。
//
// 独立性保证：CI_BRIDGE_URL 未配置时，本模块所有函数立即返回「不可用」，
// Cluss 完全走本地账号体系，不受任何影响。

var axios = require('axios');
var config = require('../config');

var TIMEOUT_MS = 5000;

function isEnabled() {
  return !!(config.ci.bridgeUrl && config.ci.secret);
}

// 调用 ClassIntra 的委托认证接口
// 返回 { ok: true, user } | { ok: false, reason: 'disabled'|'notfound'|'badpassword'|'network', message }
function verifyWithClassIntra(account, password) {
  if (!isEnabled()) {
    return Promise.resolve({ ok: false, reason: 'disabled', message: '未配置 ClassIntra 联动' });
  }

  return axios.post(
    config.ci.bridgeUrl + '/api/cluss-bridge/verify',
    { account: account, password: password },
    {
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Secret': config.ci.secret
      }
    }
  ).then(function(resp) {
    var body = resp.data || {};
    if (body.code === 200 && body.data && body.data.user) {
      return { ok: true, user: body.data.user };
    }
    if (body.code === 401) {
      return { ok: false, reason: 'badpassword', message: body.message || '账号或密码错误' };
    }
    if (body.code === 404) {
      return { ok: false, reason: 'notfound', message: body.message || '账号不存在' };
    }
    return { ok: false, reason: 'network', message: body.message || '联动校验失败' };
  }).catch(function(err) {
    var status = err.response && err.response.status;
    if (status === 401) return { ok: false, reason: 'badpassword', message: '账号或密码错误' };
    if (status === 404) return { ok: false, reason: 'notfound', message: '账号不存在' };
    console.warn('[CI-Bridge] 校验请求失败:', err.message);
    return { ok: false, reason: 'network', message: 'ClassIntra 联动暂不可用' };
  });
}

// 探测联动可用性（管理台展示用）
function probe() {
  if (!isEnabled()) {
    return Promise.resolve({ enabled: false, reachable: false });
  }
  return axios.get(config.ci.bridgeUrl + '/api/cluss-bridge/ping', {
    timeout: TIMEOUT_MS,
    headers: { 'X-Bridge-Secret': config.ci.secret }
  }).then(function(resp) {
    return { enabled: true, reachable: !!(resp.data && resp.data.code === 200) };
  }).catch(function() {
    return { enabled: true, reachable: false };
  });
}

module.exports = {
  isEnabled: isEnabled,
  verifyWithClassIntra: verifyWithClassIntra,
  probe: probe
};