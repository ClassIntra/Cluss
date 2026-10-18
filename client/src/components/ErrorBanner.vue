<!--
  统一的「出错了」提示条：一句话说清 + 一个「重试」按钮。

  为什么要把这件事收敛成一个组件：
    在此之前，各页面对"拉取失败"有 9 种不同文案、3 种处理风格，
    而且**大多数只显示一行红字、没有任何重试入口**。
    校园网抖动是常态，学生遇到"加载失败"却只能退出重进 ——
    这不是样式问题，是功能缺失：出错之后没有下一步可走。

  用法：
    <ErrorBanner :message="error" retry @retry="load()" />

  设计取舍：
    · 重试按钮由调用方用 `retry` 显式开启。不是所有失败都值得重试
      （比如参数错误），但"网络类失败"全都值得。
    · 组件内部自带 v-if，调用方不需要再包一层判空。
    · role="alert"：读屏器会把这句话念出来，而不是让视障用户
      对着一屏没变化的内容困惑。
-->
<template>
  <div v-if="message" class="alert alert-danger error-banner" role="alert">
    <span class="error-msg">{{ message }}</span>
    <button
      v-if="retry"
      type="button"
      class="error-retry"
      @click="$emit('retry')"
    >重试</button>
  </div>
</template>

<script>
export default {
  name: 'ErrorBanner',
  props: {
    message: { type: String, default: '' },
    // 由调用方决定这次失败是否给重试入口
    retry: { type: Boolean, default: false }
  }
};
</script>

<style scoped>
/* 覆盖 .alert 的 flex-start：带按钮时两端对齐更好读 */
.error-banner {
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  row-gap: 8px;
}

.error-msg {
  min-width: 0;
  /* 长接口名/长路径不该把提示条撑破 */
  word-break: break-word;
}

.error-retry {
  flex-shrink: 0;
  min-height: 32px;
  padding: 5px 15px;
  border: 1px solid currentColor;
  border-radius: var(--radius-pill);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  /* 按下即时、松开柔和回落（与全站触屏手感一致） */
  transition: background var(--transition), color var(--transition);
}

@media (hover: hover) {
.error-retry:hover {
  background: var(--danger);
  color: var(--text-invert);
}
}

/* 触屏没有 hover：靠 :active 给出"我按到了"的即时反馈 */
.error-retry:active {
  background: var(--danger);
  color: var(--text-invert);
}
</style>
