// 进行中的流式生成：托管在组件之外，跨路由切换存活
//
// 为什么需要它 —— 三个页面（对话 / 学习 / 写作）原来都在 beforeDestroy 里
// abort() 掉在途请求。学生切走看一眼别处再回来，生成就"消失"了：
// 服务端其实还在跑（它不因为客户端断开而中断，会生成完再入库），
// 但前端组件已经销毁，没有地方接着接收那半篇内容；回来只能重新拉历史，
// 而助手消息是**整轮生成结束才入库**的，于是看到的是空的
// —— 学生的结论就是"断了"。
//
// 做法：把「当前正在生成的这一轮」提到模块级。组件只是**观察者**：
//   切走 → detach（不再订阅，但流继续被消费、内容继续累积在这里）
//   回来 → attach（从当前累积值接着显示，并重新订阅后续增量）
//
// 刻意不做的事：
//   1. 不接管发请求 —— 三页的 URL / body 各不相同，留在各自页面里最清楚
//   2. 不做多槽位 —— 同一时刻只托管一轮。在别的页面发起新生成会顶掉旧的
//      （旧的那轮仍会被服务端生成完并入库，只是不再有"切回来接着看"的实时恢复）
//   3. 不缓存组件自己的状态 —— 这里是唯一副本，组件按 kind 从这里读回去
//
// 用法：
//   begin('chat')                    发起时（conversationId 可在 onMeta 时补）
//   feed(text, reasoning)            每个增量到达时（组件在不在都照样累积）
//   finish(err)                      流结束 / 出错时
//   attach(kind, this)               组件 mounted
//   detach(this)                     组件 beforeDestroy（**不要** abort）
//   setController(c) / abort()       只有用户主动点「停止生成」才 abort

var state = {
  active: false,
  kind: '',
  conversationId: '',
  text: '',
  reasoning: '',
  // 已经出过字 —— 区别于"请求发了但还在等首字"，等待提示要挂到这一刻才撤
  streaming: false,
  // 当前在做什么（"正在联网搜索…"）。挂在这里而不是组件里：学生切走看一眼别处
  // 再回来，状态行要能接着显示，否则会退回一句笼统的"正在思考…"。
  status: '',
  // 这一轮的来源清单（联网搜索）。同样要挂在组件外：切页面回来时，
  // 历史里那条助手消息还是 streaming=1 的中间态，sources 尚未落库，
  // 只有这里留着它，新组件才能把"参考来源"补上。
  sources: [],
  done: false,
  error: ''
};

var observer = null;
var controller = null;

function notify() {
  if (observer && typeof observer._onStreamSync === 'function') {
    observer._onStreamSync();
  }
}

function clear() {
  state.active = false;
  state.kind = '';
  state.conversationId = '';
  state.text = '';
  state.reasoning = '';
  state.streaming = false;
  state.status = '';
  state.sources = [];
  state.done = false;
  state.error = '';
  controller = null;
}

export default {
  begin: function(kind, opts) {
    var o = opts || {};
    clear();
    state.active = true;
    state.kind = String(kind || '');
    state.conversationId = String(o.conversationId || '');
  },

  // 会话 id 由服务端在 meta 事件里给，发起时还不知道
  setConversationId: function(id) {
    if (id) state.conversationId = String(id);
  },

  feed: function(text, reasoning) {
    if (!state.active) return;
    if (text) {
      state.text += text;
      state.streaming = true;
      // 出字了，"正在搜索/识别"就过期了
      state.status = '';
    }
    if (reasoning) state.reasoning += reasoning;
    notify();
  },

  // 只改"当前在做什么"，不清内容
  setStatus: function(text) {
    if (!state.active) return;
    var next = String(text || '');
    // 相同文案不通知：notify 会触发组件同步（进而 rAF 重绘），
    // 而状态在一次检索里会被重复写好几次（setBusy → clearBusy）。
    if (state.status === next) return;
    state.status = next;
    notify();
  },

  // 收尾时由 onDone 灌入：切过页面的那一轮，组件换了人，靠这里把来源交给新组件
  setSources: function(list) {
    if (!state.active) return;
    state.sources = Array.isArray(list) ? list : [];
    notify();
  },

  finish: function(error) {
    if (!state.active) return;
    state.done = true;
    state.streaming = false;
    state.error = String(error || '');
    // ⚠️ 刻意**不**在这里清 controller：停止生成时页面是先 finish 再 abort 的，
    // 清掉会让随后的 abort 落空（从后台恢复过来的组件自己没有 _abort，
    // 只能靠这里的 controller 掐断）。留着它无害 —— 下一轮 begin 会整体清掉。
    notify();
  },

  // 组件已经把结束态渲染出来了，这一轮可以收摊
  end: function() {
    if (!state.active) return;
    clear();
  },

  setController: function(c) { controller = c; },

  // 只有「用户主动停止」才走这里；切页面走 detach，绝不 abort
  abort: function() {
    if (controller) {
      try { controller.abort(); } catch (e) { /* 已经结束，忽略 */ }
    }
    controller = null;
  },

  attach: function(kind, target) {
    observer = target;
    // 后台有同类型的生成在跑 → 立刻同步一次，让组件把内容显示出来
    if (state.active && state.kind === kind && target && typeof target._onStreamSync === 'function') {
      target._onStreamSync();
    }
  },

  detach: function(target) {
    // 只清自己：路由切换时新旧组件的 attach / detach 顺序不完全可控，
    // 无差别清空会把刚挂上的新组件的订阅一起抹掉
    if (observer === target) observer = null;
  },

  getState: function() { return state; },

  isActive: function(kind) {
    return state.active && (!kind || state.kind === kind);
  }
};
