// 迁移 020：不再跟随 ClassIntra 的禁用状态，全部启用
//
// 背景：Cluss 曾经把 ClassIntra 的 `users.status` 同步进自己的 users 表 ——
// 先是「单向锁存」（CI 一禁就锁死，全仓没有解禁入口），后来改成「双向跟随」
// （CI 禁 → Cluss 禁 / CI 解 → Cluss 解）。两次都出过真实故障，
// 根子是同一个：**两个系统之间没有共同的撤销动作**，只在一侧操作就把人锁住了。
//
// 现在按决定删掉这条同步（见 services/class-roster.js::adoptRoster），
// 并把历史上被这条策略写成 disabled 的账号一次性全部恢复。
//
// 为什么用迁移而不是在启动时顺手 UPDATE：
//   1. 它是**一次性数据订正**，属于历史事实，跑完就该留在版本记录里；
//   2. 幂等（WHERE status='disabled' 第二次匹配 0 行），重复执行无副作用。
//
// ⚠️ 边界：status 列**保留**，它仍是 Cluss 自己的字段
//   （routes/auth.js 的 finishLogin 还会把账号自愈成 active，
//    将来若做「本地禁用」也用它）。删的只是「谁有权写它」这条同步规则。

function up(db) {
  var info = db.prepare('UPDATE users SET status = ? WHERE status = ?').run('active', 'disabled');
  if (info && info.changes > 0) {
    console.log('[migration 020] 已恢复 ' + info.changes + ' 个被 ClassIntra 禁用状态锁住的账号');
  }
}

module.exports = { version: 20, name: 'drop_classintra_disabled_sync', up: up };