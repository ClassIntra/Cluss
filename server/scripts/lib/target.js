// 验证脚本的目标地址解析（verify-v2 / verify-v3 / prepare-demo 共用）
//
// 这些脚本会向 BASE 发大量请求（注册、上传、流式对话……），
// 所以目标地址必须在进入 axios 之前就被约束住：
//   - 只允许 http/https（挡掉 file:/gopher: 这类协议）
//   - 不允许 URL 内嵌账号密码（凭据走各自的 token 通道）
//   - 只允许本机地址，除非显式传 ALLOW_REMOTE=1
//     （默认本机是因为这套脚本会清空数据、改模型配置，指向远端实例是危险操作）
//
// 用法：
//   var target = require('./lib/target');
//   var BASE = target.resolve(process.env.PORT || 9101);

var LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];

// 当前已解析的目标 origin；lib/http 的逐请求校验用它做比对
var current = null;

function resolve(port, options) {
  options = options || {};
  var raw = String(options.url || ('http://127.0.0.1:' + port)).trim().replace(/\/+$/, '');

  var u;
  try {
    u = new URL(raw);
  } catch (e) {
    throw new Error('[target] 目标地址不是合法 URL：' + raw);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('[target] 只支持 http/https，收到：' + u.protocol);
  }
  if (u.username || u.password) {
    throw new Error('[target] 目标地址不要内嵌账号密码');
  }

  var isLocal = LOOPBACK.indexOf(u.hostname) !== -1;
  if (!isLocal && process.env.ALLOW_REMOTE !== '1') {
    throw new Error(
      '[target] 拒绝访问非本机地址 ' + u.hostname + '：\n' +
      '  这套脚本会清空业务数据、改模型配置，只应指向本机实例。\n' +
      '  确需指向远端，请显式设置 ALLOW_REMOTE=1（后果自负）。'
    );
  }

  current = u.origin;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

// 返回已解析目标的 origin（尚未 resolve 时返回 null）
function getCurrent() {
  return current;
}

module.exports = { resolve: resolve, current: getCurrent };
