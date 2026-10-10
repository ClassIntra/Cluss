// 验证脚本共用的 HTTP 出口（verify-v2 / verify-v3 / prepare-demo）
//
// 与直接用 axios 的区别：**每个请求发出前**都做一次源校验 ——
// URL 的 origin 必须等于 lib/target.resolve() 解析出的被测实例
// （或脚本用 lib/target.allow 显式放行的本机夹具，如 mock 上游），
// 协议必须是 http/https。e2e 脚本会携带管理员/学生令牌发几百个请求，
// 把"目标只指向被测的本机实例"这条约束压到一个出口上，
// 任何一处手滑拼错 URL（比如把令牌拼进主机名）都会在这里被拦下，
// 而不是把凭据送到一个不该去的地方。
//
// 用法（与 axios 同参，方法名显式化）：
//   var http = require('./lib/http');
//   http.getJson(BASE + '/api/...', { headers: ... })
//   http.postJson(BASE + '/api/...', body, { headers: ... })
//   http.postForm(BASE + '/api/...', formData, { headers: ... })   // multipart
//   http.putJson / http.del 同理

var axios = require('axios');
var target = require('./target');

var instance = axios.create();

instance.interceptors.request.use(function(config) {
  var raw = config.url;
  var u;
  try {
    u = new URL(raw);
  } catch (e) {
    return Promise.reject(new Error('[http] 请求地址不是合法 URL：' + raw));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return Promise.reject(new Error('[http] 只允许 http/https，收到：' + u.protocol));
  }
  var base = target.current();
  // 被测实例本身，或脚本显式放行的本机夹具（如 mock 上游，见 lib/target.allow）
  if (base && u.origin !== base && !target.isAllowed(u.origin)) {
    return Promise.reject(new Error(
      '[http] 请求目标 ' + u.origin + ' 超出了被测实例 ' + base +
      '——请检查 URL 拼接（令牌/文件名不要拼进主机名）'
    ));
  }
  return config;
});

// 统一走 request(config)：方法名作为参数传入，出口只有一个
function req(method, url, data, config) {
  var cfg = config || {};
  cfg.method = method;
  cfg.url = url;
  if (data !== undefined) cfg.data = data;
  return instance.request(cfg);
}

module.exports = {
  // GET（JSON / 二进制 / 流式响应都通过 config.responseType 指定）
  getJson: function(url, config) { return req('get', url, undefined, config); },
  // POST（JSON 体）
  postJson: function(url, data, config) { return req('post', url, data, config); },
  // POST（multipart FormData：上传用）
  postForm: function(url, form, config) { return req('post', url, form, config); },
  // PUT
  putJson: function(url, data, config) { return req('put', url, data, config); },
  // DELETE
  del: function(url, config) { return req('delete', url, undefined, config); }
};
