// 学生端导航的唯一来源：AppNav（顶栏）与 TabBar（竖屏底栏）共用。
// 两处各写一份必然逐渐不一致 —— 改导航只改这里。
//
// 「我的消耗」不在此列：它是低频页，挂在用户菜单里（见 AppNav 的说明）。
export default [
  { id: 'chat', label: '对话', to: '/' },
  { id: 'study', label: '学习', to: '/study' },
  { id: 'writing', label: '作文', to: '/writing' },
  { id: 'records', label: '记录', to: '/records' },
  { id: 'notes', label: '笔记', to: '/notes' },
  { id: 'wrong-book', label: '错题本', to: '/wrong-book' },
  { id: 'cloud', label: '云盘', to: '/cloud' }
];
