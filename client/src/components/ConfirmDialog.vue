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
  watch: {
    opts: function(now) {
      if (now) this.$_open();
      else this.$_close();
    }
  },
  beforeDestroy: function() {
    document.removeEventListener('keydown', this._onKeydown);
  },
  methods: {
    resolve: function(val) {
      // dispatch 内部先清 state 再 resolve：弹窗立刻消失，Promise 后完成
      this.$store.dispatch('resolveConfirm', val);
    },

    // ---------- 焦点与键盘 ----------
    //
    // 为什么必须做：这个弹窗声明了 `aria-modal="true"`，对读屏软件而言
    //   它把外面的世界整个隔开 —— 可焦点却还留在触发它的那个按钮上
    //   （通常是页面深处的一个删除键）。视障用户会听到"对话框"，
    //   但一按 Tab 就跑到背后的页面里去了：等于被困在一个听得见、
    //   却进不去的房间里。**声明了模态就该真的模态** ——
    //   只写 aria-modal 而不做焦点环，比完全不写更糟。
    $_open: function() {
      var self = this;
      this._prevFocus = document.activeElement;
      this.$nextTick(function() {
        var el = self.$el;
        if (!el || !el.querySelector) return;
        // 默认聚焦「取消」而不是「确定」：
        //   这两个按钮里有一个是**危险**的（删除/清空），键盘盲按时
        //   落到它上面的代价太大。把安全的那一侧作为默认焦点 ——
        //   "想清楚再按"应该由动作决定，而不是由默认值决定。
        var safe = el.querySelector('.confirm-actions .btn-ghost');
        var any = el.querySelector('.confirm-actions .btn');
        var t = safe || any || el;
        if (t.focus) t.focus();
      });
      document.addEventListener('keydown', this._onKeydown);
    },
    $_close: function() {
      document.removeEventListener('keydown', this._onKeydown);
      var p = this._prevFocus;
      this._prevFocus = null;
      // 归还焦点：不还的话焦点会掉到 <body>，键盘用户得从头 Tab 一遍
      // 才能回到刚才操作的位置 —— 一次确认就把他弹回起点。
      if (p && p.focus && document.contains(p)) p.focus();
    },
    _onKeydown: function(e) {
      var isEsc = e.key === 'Escape' || e.keyCode === 27;
      if (isEsc) {
        e.preventDefault();
        // Esc 一律等同于「取消」：这是所有平台的一致预期，
        // 而且它天然选在安全的那一侧
        this.resolve(false);
        return;
      }
      // Tab 只在弹窗内循环。这里只有两个按钮，代价极低；
      // 不做的话 Tab 会跑到背后页面的元素上，模态就名存实亡。
      if (e.key === 'Tab' || e.keyCode === 9) {
        var el = this.$el;
        if (!el || !el.querySelectorAll) return;
        var items = el.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (items.length < 2) { e.preventDefault(); return; }
        var first = items[0];
        var last = items[items.length - 1];
        var active = document.activeElement;
        var inside = el.contains(active);
        if (e.shiftKey) {
          if (!inside || active === first) { e.preventDefault(); last.focus(); }
        } else if (!inside || active === last) {
          e.preventDefault(); first.focus();
        }
      }
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
