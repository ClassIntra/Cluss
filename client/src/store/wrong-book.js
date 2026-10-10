import api from '@/utils/api';

// 错题复习的全局状态
//
// 目前只存一个「今天有几道该复习」，但值得单独开一个模块：
//   导航角标（顶栏 + 竖屏底栏）与错题本页的复习卡片都要读它。
//   两处各自去拉接口，就会出现「角标写 3 道、点进去只有 2 道」这类偏差——
//   服务端的判定已经收口成一处（countsOf），前端也不该再分叉。
//
// 这份状态只用于"提示"，不参与任何权限或扣费判断：
// 拉取失败时保持旧值并静默降级，绝不打断学生手上的操作。

function emptyOverview() {
  return { due: 0, graduated: 0, pending: 0, mastered: 0, total: 0, today: '' };
}

var state = {
  overview: emptyOverview(),
  loaded: false
};

var getters = {
  // 今天该复习几道（角标数字）
  dueCount: function(s) { return s.overview.due || 0; },
  // 走完复习阶梯、等他确认掌握的（用于页面上的轻提示，不进角标）
  graduatedCount: function(s) { return s.overview.graduated || 0; },
  overview: function(s) { return s.overview; }
};

var mutations = {
  SET_OVERVIEW: function(s, o) {
    s.overview = Object.assign(emptyOverview(), o || {});
    s.loaded = true;
  },
  CLEAR_OVERVIEW: function(s) {
    s.overview = emptyOverview();
    s.loaded = false;
  }
};

var actions = {
  // 静默刷新：失败不提示、不清零
  //
  // 为什么不清零：网络抖一下就"角标消失"，学生会以为复习任务被取消了。
  // 宁可显示上一次的真实数字（略旧），也不要给出一个会误导的 0。
  refreshOverview: function(context) {
    if (!context.rootState.auth.token) return Promise.resolve(null);
    return api.get('/wrong-book/review/overview').then(function(resp) {
      if (resp.data.code === 200) {
        context.commit('SET_OVERVIEW', resp.data.data);
        return resp.data.data;
      }
      return null;
    }).catch(function() {
      return null;
    });
  }
};

export default { namespaced: true, state: state, getters: getters, mutations: mutations, actions: actions };
