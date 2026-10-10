import Vue from 'vue';
import axios from 'axios';
import api from '@/utils/api';

var state = {
  token: localStorage.getItem('cluss_token') || '',
  user: (function() {
    try {
      return JSON.parse(localStorage.getItem('cluss_user') || 'null');
    } catch (e) {
      localStorage.removeItem('cluss_user');
      return null;
    }
  })(),
  wallet: null
};

var getters = {
  isLoggedIn: function(state) { return !!state.token; },
  isAdmin: function(state) { return !!(state.user && state.user.is_admin); },
  user: function(state) { return state.user; },
  wallet: function(state) { return state.wallet; }
};

var mutations = {
  SET_TOKEN: function(state, token) {
    state.token = token;
    if (token) localStorage.setItem('cluss_token', token);
    else localStorage.removeItem('cluss_token');
  },
  SET_USER: function(state, user) {
    state.user = user;
    if (user) localStorage.setItem('cluss_user', JSON.stringify(user));
    else localStorage.removeItem('cluss_user');
  },
  SET_WALLET: function(state, wallet) {
    state.wallet = wallet;
  },
  LOGOUT: function(state) {
    state.token = '';
    state.user = null;
    state.wallet = null;
    localStorage.removeItem('cluss_token');
    localStorage.removeItem('cluss_user');
  }
};

var actions = {
  // 登录：统一处理「后端返回 200 但 code 非 200」的情况
  login: function(context, credentials) {
    return api.post('/auth/login', credentials).then(function(resp) {
      var body = resp.data;
      if (body.code !== 200) {
        var err = new Error(body.message || '登录失败');
        err.response = resp;
        return Promise.reject(err);
      }
      context.commit('SET_TOKEN', body.data.token);
      context.commit('SET_USER', body.data.user_info);
      return body.data;
    });
  },

  register: function(context, payload) {
    return api.post('/auth/register', payload).then(function(resp) {
      var body = resp.data;
      if (body.code !== 200) {
        var err = new Error(body.message || '注册失败');
        err.response = resp;
        return Promise.reject(err);
      }
      context.commit('SET_TOKEN', body.data.token);
      context.commit('SET_USER', body.data.user_info);
      return body.data;
    });
  },

  // 拉取用户信息与额度（进入主界面时调用）
  fetchProfile: function(context) {
    return api.get('/auth/check-status').then(function(resp) {
      if (resp.data.code === 200) {
        context.commit('SET_USER', resp.data.data.user_info);
      }
      return resp.data.data ? resp.data.data.user_info : null;
    });
  },

  fetchWallet: function(context) {
    return api.get('/wallet').then(function(resp) {
      if (resp.data.code === 200) {
        context.commit('SET_WALLET', resp.data.data);
      }
      return resp.data.data;
    });
  },

  // ClassIntra 免登：应用壳经 URL ?token= 注入 CI 签发的 JWT。
  // 必须用裸 axios 先验证再落 token——走 api 实例的话，验证失败会触发
  // 401 拦截器（logout + 跳登录页），把「回滚原会话」的善后逻辑整个绕掉；
  // 且 token 校验失败时不该动任何已有登录态。
  acceptExternalToken: function(context, token) {
    return axios.get('/api/auth/check-status', {
      headers: { Authorization: 'Bearer ' + token },
      timeout: 15000
    }).then(function(resp) {
      if (resp.data.code !== 200) {
        var err = new Error(resp.data.message || '免登校验失败');
        // 把响应挂上：调用方（main.js 的启动流程）要按 code 区分
        // 「CI 登录过期」还是「账号被禁用」再给出对应的话（同 login/register 的约定）
        err.response = resp;
        throw err;
      }
      context.commit('SET_TOKEN', token);
      context.commit('SET_USER', resp.data.data.user_info);
      return resp.data.data.user_info;
    });
  },

  logout: function(context) {
    context.commit('LOGOUT');
    return api.post('/auth/logout').catch(function() { /* 网络异常不阻断登出 */ });
  }
};

export default {
  namespaced: true,
  state: state,
  getters: getters,
  mutations: mutations,
  actions: actions
};