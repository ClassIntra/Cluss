// 隐藏密码（隐私锁）状态
//
// 一份密码管两处：隐藏的会话 + 笔记的私密笔记。状态放全局 store 而不是
// 各页面各自的 data —— 三个页面（对话 / 笔记 / 设置）都要读同一份状态，
// 各存一份必然漂移（典型症状：设置里显示"已解锁"，对话侧还当锁着）。
//
// 解锁态在**服务端**（进程级 Map，滑动 30 分钟），这里只是镜像：
// 刷新页面后以 GET /private/status 为准，不猜。
//
// ⚠️ 这里必须 `import api`，**不能用 this.$http**：
//    $http 挂在 Vue.prototype 上，组件里才有；Vuex action 的 this 是 store，
//    拿到的是 undefined。曾经写成 this.$http，症状是 action 静默抛异常、
//    调用方的 .then 永不执行 —— 表现为"对话列表永远是空的"（探针查了半小时，
//    页面压根没发出 /api/conversations 请求）。

import api from '@/utils/api';

var DEFAULTS = {
  loaded: false,
  hasPassword: false,
  unlocked: false,
  // 全局密码弹窗（LockPrompt 渲染）。mode:
  //   'unlock' —— 输入密码解锁（对话/笔记共用）
  //   'setup'  —— 首次设置（输两遍）
  // 用 Promise 交割：_resolve 只寄存，不参与渲染。
  prompt: null
};

export default {
  namespaced: true,
  state: Object.assign({}, DEFAULTS),
  mutations: {
    SET_STATUS: function(state, payload) {
      state.loaded = true;
      state.hasPassword = !!(payload && payload.hasPassword);
      state.unlocked = !!(payload && payload.unlocked);
    },
    SET_UNLOCKED: function(state, val) {
      state.unlocked = !!val;
    },
    SHOW_PROMPT: function(state, payload) {
      state.prompt = {
        mode: payload.mode || 'unlock',
        after: payload.after || '',
        _resolve: payload._resolve
      };
    },
    CLEAR_PROMPT: function(state) {
      state.prompt = null;
    }
  },
  actions: {
    // 拉一次服务端状态。失败按"没设过密码"处理 —— 读不到锁的状态时
    // 表现成"没有隐藏内容"比表现成"到处是锁"更安全。
    refresh: function(context) {
      return api.get('/private/status').then(function(r) {
        var d = (r && r.data && r.data.data) || {};
        context.commit('SET_STATUS', {
          hasPassword: d.hasPassword,
          unlocked: d.unlocked
        });
        return d;
      }).catch(function() {
        context.commit('SET_STATUS', { hasPassword: false, unlocked: false });
        return { hasPassword: false, unlocked: false };
      });
    },

    // 打开全局密码弹窗，返回 Promise<boolean>（true = 已解锁 / 已设置）
    promptUnlock: function(context, payload) {
      return new Promise(function(resolve) {
        context.commit('SHOW_PROMPT', Object.assign({}, payload || {}, { mode: 'unlock', _resolve: resolve }));
      });
    },
    promptSetup: function(context, payload) {
      return new Promise(function(resolve) {
        context.commit('SHOW_PROMPT', Object.assign({}, payload || {}, { mode: 'setup', _resolve: resolve }));
      });
    },
    // 先关弹窗再兑现：界面不等业务代码
    resolvePrompt: function(context, val) {
      var p = context.state.prompt;
      context.commit('CLEAR_PROMPT');
      if (p && p._resolve) p._resolve(val);
    },

    setup: function(context, password) {
      return api.post('/private/setup', { password: password }).then(function(r) {
        var d = (r && r.data && r.data.data) || {};
        context.commit('SET_STATUS', { hasPassword: d.hasPassword !== false, unlocked: d.unlocked !== false });
        return { ok: true };
      }).catch(function(e) {
        var msg = (e && e.response && e.response.data && e.response.data.message) || '设置失败';
        return { ok: false, message: msg };
      });
    },

    change: function(context, payload) {
      return api.post('/private/change', {
        oldPassword: payload.oldPassword,
        newPassword: payload.newPassword
      }).then(function() {
        return { ok: true };
      }).catch(function(e) {
        var msg = (e && e.response && e.response.data && e.response.data.message) || '修改失败';
        return { ok: false, message: msg };
      });
    },

    remove: function(context) {
      return api.post('/private/remove').then(function() {
        context.commit('SET_STATUS', { hasPassword: false, unlocked: false });
        return { ok: true };
      }).catch(function(e) {
        var msg = (e && e.response && e.response.data && e.response.data.message) || '移除失败';
        return { ok: false, message: msg };
      });
    },

    lock: function(context) {
      return api.post('/private/lock').then(function() {
        context.commit('SET_UNLOCKED', false);
        return { ok: true };
      }).catch(function() {
        context.commit('SET_UNLOCKED', false);
        return { ok: false };
      });
    }
  }
};
