// 嵌入态：Cluss 被 ClassIntra 的应用壳以内嵌 iframe 打开时的共用工具。
//
// 为什么单独抽一个文件：嵌入态的行为散落在好几处（顶栏的返回按钮、退出登录的去向、
// 登录/注册页的兜底出口），各写一份必然逐渐不一致 —— 而它们必须同源判断。
// 曾经就漏了「登录页没有返回出口」这一处，导致免登失败的学生走投无路。

// 是否运行在 ClassIntra 的 iframe 里。
// window.self !== window.top 的比较是跨域安全的（不读 top 的任何属性）。
export function isEmbedded() {
  try {
    return window.self !== window.top;
  } catch (e) {
    // 读 top 抛异常 = 父窗口与当前窗口不同源 = 一定在 iframe 里
    return true;
  }
}

// 给宿主（ClassIntra 应用壳）发消息。宿主未监听时静默——Cluss 独立部署时
// 也可以被任意页面内嵌，不该因为对方不认这些消息就报错。
// 约定 type：
//   cluss:navigate-back  回到 ClassIntra 桌面（顶栏返回按钮 / 退出登录都用它）
export function notifyHost(type) {
  try {
    window.parent.postMessage({ type: type || 'cluss:navigate-back' }, '*');
  } catch (e) { /* 跨域受限时忽略 */ }
}

// 回到 ClassIntra 桌面
export function backToClassIntra() {
  notifyHost('cluss:navigate-back');
}
