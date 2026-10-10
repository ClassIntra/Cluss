// 学生端导航的唯一来源：AppNav（顶栏）与 TabBar（竖屏底栏）共用。
// 两处各写一份必然逐渐不一致 —— 改导航只改这里。
//
// chunk：该页面的异步组件加载函数，供 App.vue 在空闲时预取。
//   为什么需要：router 里所有页面都是 import() 异步组件，首次点击要现场
//   下载该页的代码（Notes 243KB / Chat 41KB），平板移动网络下这一下就是
//   几秒空白 —— 体感就是「点了没反应」。预取把它挪到空闲期。
//   ⚠️ 这里的 import 路径必须与 router/index.js 里的**完全一致**，
//      写成不同的相对路径会生成另一个 chunk，预取就白做了。
//   ⚠️ 加导航项时记得同步 router/index.js，两处要一一对应。
//
// 「我的消耗」不在此列：它是低频页，挂在用户菜单里（见 AppNav 的说明），
// 不预取 —— 把首屏的空闲时间让给高频页更划算。
export default [
  { id: 'chat', label: '对话', to: '/', chunk: function() { return import('@/views/Chat.vue'); } },
  { id: 'study', label: '学习', to: '/study', chunk: function() { return import('@/views/Study.vue'); } },
  { id: 'writing', label: '作文', to: '/writing', chunk: function() { return import('@/views/Writing.vue'); } },
  { id: 'records', label: '记录', to: '/records', chunk: function() { return import('@/views/Records.vue'); } },
  { id: 'notes', label: '笔记', to: '/notes', chunk: function() { return import('@/views/Notes.vue'); } },
  { id: 'wrong-book', label: '错题本', to: '/wrong-book', chunk: function() { return import('@/views/WrongBook.vue'); } },
  { id: 'cloud', label: '云盘', to: '/cloud', chunk: function() { return import('@/views/Cloud.vue'); } }
];