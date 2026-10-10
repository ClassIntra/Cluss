<template>
  <!--
    全局确认弹窗：替代 window.confirm。
    为什么不直接用原生弹窗：原生 confirm 在 Android WebView 里是一块
    与整个界面无关的系统灰底，打断玻璃拟态的沉浸感；文案也无法强调危险等级。
    用法：this.$store.dispatch('confirm', { message, danger }) → Promise<boolean>
  -->
  <transition name="fade">
    <div v-if="opts" class="confirm-mask" @click.self="resolve(false)">
      <div class="modal confirm-card glass" role="alertdialog" aria-modal="true">
        <h3 v-if="opts.title" class="confirm-title">{{ opts.title }}</h3>
        <p class="confirm-message">{{ opts.message }}</p>
        <div class="confirm-actions">
          <button class="btn btn-ghost" type="button" @click="resolve(false)">
            {{ opts.cancelText }}
          </button>
          <button class="btn" :class="opts.danger ? 'btn-danger' : 'btn-primary'" type="button" @click="resolve(true)">
            {{ opts.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script>
export default {
  name: 'ConfirmDialog',
  computed: {
    opts: function() {
      return this.$store.state.confirm;
    }
  },
  methods: {
    resolve: function(val) {
      // dispatch 内部先清 state 再 resolve：弹窗立刻消失，Promise 后完成
      this.$store.dispatch('resolveConfirm', val);
    }
  }
};
</script>

<style scoped>
.confirm-mask {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 520;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--gap-lg);
  background: var(--mask);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

/* 比业务弹窗（编辑表单）小一号：确认只该有一句话的分量 */
.confirm-card {
  width: 100%;
  max-width: 360px;
  padding: 22px;
  border-radius: var(--radius-xl);
}

.confirm-title {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 600;
}

.confirm-message {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--text-secondary);
  word-break: break-word;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}
html.no-flex-gap .confirm-actions > * + * {
  margin-left: 10px;
}






/* 危险动作时取消是主按钮、确认是红的：颜色权重压过位置权重，
   手指滑过去不会顺手把「删除」点成默认项 */
.confirm-card .btn-ghost {
  padding-left: 22px;
  padding-right: 22px;
}
</style>
