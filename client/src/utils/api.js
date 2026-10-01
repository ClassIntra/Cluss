import axios from 'axios';
import store from '@/store';
import router from '@/router';

// 统一 API 封装
// 约定（与后端一致）：HTTP 200 + body.code 表达业务结果，401 才代表登录态失效
var api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true
});

api.interceptors.request.use(function(config) {
  var token = store.state.auth.token;
  if (token) {
    config.headers.Authorization = 'Bearer ' + token;
  }
  // 关掉一切缓存：项目一贯要求，避免学生端拿到旧数据
  config.headers['Cache-Control'] = 'no-cache, no-store';
  config.headers['Pragma'] = 'no-cache';
  if (config.method === 'get') {
    config.params = config.params || {};
    config.params._t = Date.now();
  }
  return config;
});

api.interceptors.response.use(
  function(response) {
    return response;
  },
  function(error) {
    var status = error.response && error.response.status;

    // 登录态失效：清本地状态并回登录页（登录/注册页本身不跳，避免打断输入）
    if (status === 401) {
      var name = router.currentRoute && router.currentRoute.name;
      if (name !== 'Login' && name !== 'Register') {
        store.dispatch('auth/logout');
        router.push({ name: 'Login' });
      }
    }

    // 统一错误对象：调用方只需读 err.message
    var body = error.response && error.response.data;
    var message = (body && body.message) || '';

    if (!message) {
      // 超时没有 response，必须排在按状态码判断之前，否则会被误判成"网络不通"
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        message = '请求超时，请稍后重试';
      } else if (status === 401) {
        message = '登录状态已失效，请重新登录';
      } else if (status === 403) {
        message = '无权限执行此操作';
      } else if (status === 402) {
        message = '额度不足，请联系管理员充值';
      } else if (status === 404) {
        message = '请求的内容不存在';
      } else if (status === 429) {
        message = '操作过于频繁，请稍后再试';
      } else if (status >= 500) {
        message = '服务器暂时不可用，请稍后重试';
      } else if (!error.response) {
        message = '无法连接服务器，请检查网络';
      } else {
        message = '请求失败，请稍后重试';
      }
    }

    error.message = message;
    return Promise.reject(error);
  }
);

export default api;