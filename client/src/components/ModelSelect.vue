<template>
  <div ref="root" class="msel" :class="rootClass">
    <button
      ref="trigger"
      type="button"
      class="msel-trigger"
      :disabled="disabled"
      :title="disabled ? '' : '用哪个 AI 由管理员配置，一般不用改'"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      @click="toggle"
      @keydown.down.prevent="openList()"
      @keydown.up.prevent="openList()"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <span class="msel-label">{{ current ? current.label : placeholder }}</span>
      <span
        v-if="current && chipOf(current)"
        class="msel-chip"
        :class="current.effective_free ? 'msel-chip-free' : 'msel-chip-mult'"
      >{{ chipOf(current) }}</span>
      <span
        v-if="current && !current.available"
        class="msel-chip msel-chip-off"
      >{{ current.unavailable_reason || '不可用' }}</span>
      <svg class="msel-caret" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <transition name="msel-pop">
      <ul
        v-if="open"
        ref="pop"
        class="msel-pop"
        role="listbox"
        tabindex="-1"
        @keydown="onListKeydown"
        @scroll.stop
      >
        <li v-for="(m, i) in options" :key="m.id" role="option" :aria-selected="m.id === value">
          <button
            type="button"
            class="msel-opt"
            :class="{ 'is-selected': m.id === value, 'is-active': i === activeIndex, 'is-disabled': !m.available }"
            :disabled="!m.available"
            tabindex="-1"
            @click="pick(m)"
            @pointerenter="m.available && (activeIndex = i)"
          >
            <span class="msel-opt-label">{{ m.label }}</span>
            <span class="msel-opt-meta">
              <span
                v-if="m.effective_free"
                class="msel-chip msel-chip-free"
                :title="freeUntilText(m)"
              >{{ chipOf(m) }}</span>
              <span v-else-if="chipOf(m)" class="msel-chip msel-chip-mult">{{ chipOf(m) }}</span>
              <span v-if="!m.available" class="msel-chip msel-chip-off">{{ m.unavailable_reason || '不可用' }}</span>
            </span>
          </button>
        </li>
      </ul>
    </transition>
  </div>
</template>

<script>
// 模型选择器（自绘下拉）
//
// 为什么不用原生 <select>：option 的样式平台各管各的，倍率 / 限免只能挤成
// 一串纯文本；自绘后徽标能上色、触发框闭着也能看到「×1.05」「限免」。
//
// 布局约束（决定了实现方式）：
//   - 弹层用组件根内的**绝对定位**，不用 fixed——三处宿主（composer / pane /
//     result）都有 backdrop-filter 的玻璃面板，会劫持 fixed 的包含块；
//   - Chat 在屏幕底部 → drop-up 向上弹；拍题 / 作文在选择器在面板顶部 →
//     向下弹，且弹层高度远小于面板，不会被 pane 的 overflow:hidden 裁到；
//   - 弹层右对齐（right:0）：三处选择器都靠右放，向左展开不会顶出屏幕。
export default {
  name: 'ModelSelect',
  props: {
    value: { type: String, default: '' },
    // 模型对象：{ id, label, available, unavailable_reason?, effective_free?, price_multiplier?, free_until? }
    options: { type: Array, default: function() { return []; } },
    disabled: { type: Boolean, default: false },
    // 从底部向上弹（对话页输入区在屏幕底）
    dropUp: { type: Boolean, default: false },
    // sm：拍题 / 作文页头部的小号
    size: { type: String, default: 'md' },
    placeholder: { type: String, default: '选择模型' }
  },
  data: function() {
    return {
      open: false,
      activeIndex: -1
    };
  },
  computed: {
    rootClass: function() {
      return ['msel-' + (this.size === 'sm' ? 'sm' : 'md'), { 'msel-open': this.open, 'msel-drop-up': this.dropUp }];
    },
    current: function() {
      var v = this.value;
      for (var i = 0; i < this.options.length; i++) {
        if (this.options[i].id === v) return this.options[i];
      }
      return null;
    }
  },
  beforeDestroy: function() {
    this.unbindGlobal();
  },
  methods: {
    // 倍率 / 限免徽标文案：默认模型是基准（×1.00）不打标。
    // 限免临期（< 24h）升级为「限免 · 即将截止」——让限免以预告结束，
    // 而不是突然恢复计费让学生措手不及（计费恢复本身是自动的，无需学生做任何事）
    chipOf: function(m) {
      if (!m) return '';
      if (m.effective_free) return this.freeEndingSoon(m) ? '限免 · 即将截止' : '限免';
      var mult = Number(m.price_multiplier);
      if (mult > 0 && mult !== 1) return '×' + mult.toFixed(2);
      return '';
    },
    freeEndingSoon: function(m) {
      if (!m || !m.free_until) return false;
      var t = Date.parse(m.free_until);
      if (isNaN(t)) return false;
      var left = t - Date.now();
      return left > 0 && left < 24 * 3600 * 1000;
    },
    freeUntilText: function(m) {
      if (!m || !m.free_until) return '';
      var d = new Date(m.free_until);
      if (isNaN(d.getTime())) return '';
      function pad(n) { return n < 10 ? '0' + n : String(n); }
      return '限免至 ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    },
    toggle: function() {
      if (this.disabled) return;
      if (this.open) { this.close(); return; }
      this.openList();
    },
    openList: function() {
      if (this.disabled || this.open) return;
      // 初始焦点态：落在当前选中项；没选中（或不可用）落在第一个可选模型
      this.activeIndex = -1;
      for (var i = 0; i < this.options.length; i++) {
        if (this.options[i].id === this.value && this.options[i].available) { this.activeIndex = i; break; }
      }
      if (this.activeIndex < 0) {
        for (var j = 0; j < this.options.length; j++) {
          if (this.options[j].available) { this.activeIndex = j; break; }
        }
      }
      this.open = true;
      this.bindGlobal();
      this.$nextTick(function() {
        if (this.$refs.pop) this.$refs.pop.focus();
        this.scrollActiveIntoView();
      }.bind(this));
    },
    close: function() {
      if (!this.open) return;
      this.open = false;
      this.unbindGlobal();
      var t = this.$refs.trigger;
      if (t) t.focus();
    },
    pick: function(m) {
      if (!m || !m.available) return;
      this.$emit('input', m.id);
      this.close();
    },
    moveActive: function(step) {
      var n = this.options.length;
      if (!n) return;
      var i = this.activeIndex;
      for (var k = 0; k < n; k++) {
        i = (i + step + n) % n;
        if (this.options[i].available) { this.activeIndex = i; this.scrollActiveIntoView(); return; }
      }
    },
    scrollActiveIntoView: function() {
      var pop = this.$refs.pop;
      if (!pop) return;
      var btns = pop.querySelectorAll('.msel-opt');
      var el = btns[this.activeIndex];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    },
    onListKeydown: function(e) {
      if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveActive(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.moveActive(-1); return; }
      if (e.key === 'Home') { e.preventDefault(); this.activeIndex = 0; this.scrollActiveIntoView(); return; }
      if (e.key === 'End') { e.preventDefault(); this.activeIndex = this.options.length - 1; this.scrollActiveIntoView(); return; }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        var m = this.options[this.activeIndex];
        if (m) this.pick(m);
      }
    },
    onDocPointer: function(e) {
      var root = this.$refs.root;
      // 弹层已 portal 到根内；点在组件外才收起
      if (root && !root.contains(e.target)) this.close();
    },
    onWinScroll: function(e) {
      if (!this.open) return;
      var pop = this.$refs.pop;
      // 弹层自身滚动不收起；页面其他滚动（消息区、窗格）会改变视觉对位，直接收
      if (pop && pop.contains(e.target)) return;
      this.open = false;
      this.unbindGlobal();
    },
    bindGlobal: function() {
      document.addEventListener('pointerdown', this.onDocPointer, true);
      window.addEventListener('scroll', this.onWinScroll, true);
      window.addEventListener('resize', this.onWinScroll);
    },
    unbindGlobal: function() {
      document.removeEventListener('pointerdown', this.onDocPointer, true);
      window.removeEventListener('scroll', this.onWinScroll, true);
      window.removeEventListener('resize', this.onWinScroll);
    }
  }
};
</script>

<style scoped>
.msel {
  position: relative;
  flex-shrink: 0;
}

/* ---------- 触发框 ---------- */
.msel-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  /* 大屏下同步放大命中区与字号（下限 = 原值，960 基线不变） */
  padding: clamp(8px, 2.72px + 0.55vw, 12px) clamp(10px, 3.28px + 0.7vw, 16px);
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-family: inherit;
  font-size: clamp(12.5px, 9.62px + 0.3vw, 14.5px);
  color: var(--text-secondary);
  cursor: pointer;
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out);
}
html.no-flex-gap .msel-trigger > * + * {
  margin-left: 6px;
}






.msel-trigger:focus-visible {
  border-color: var(--accent-border-strong);
  box-shadow: 0 0 0 3px var(--accent-ring);
}

.msel-open .msel-trigger {
  border-color: var(--accent-border-strong);
}

@media (hover: hover) {
  .msel-trigger:hover {
    border-color: var(--accent-border-strong);
  }
}

.msel-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: left;
}

.msel-caret {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  color: var(--text-tertiary);
  transition: transform var(--dur-fast) var(--ease-out);
}

.msel-open .msel-caret {
  transform: rotate(180deg);
}

.msel-drop-up .msel-open .msel-caret {
  transform: rotate(0deg);
}

/* ---------- 徽标 ---------- */
.msel-chip {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
}

.msel-chip-mult {
  background: var(--accent-soft);
  color: var(--accent-text, var(--accent));
}

.msel-chip-free {
  background: var(--success-soft);
  color: var(--success);
}

.msel-chip-off {
  background: var(--danger-soft);
  color: var(--danger);
}

/* ---------- 尺寸 ---------- */
.msel-md {
  min-width: 96px;
  max-width: 170px;
}

.msel-sm .msel-trigger {
  /* 页面里实际用的是这个 sm 变体，两类选择器特异性高于上面的 .msel-trigger，
     clamp 必须写在这里才生效（下限 = 原值） */
  padding: clamp(6px, 1.97px + 0.42vw, 9px) clamp(8px, 2.62px + 0.56vw, 12px);
  font-size: clamp(12px, 9.12px + 0.3vw, 14px);
}

.msel-sm {
  max-width: 160px;
}

/* ---------- 弹层 ---------- */
.msel-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 60;
  min-width: 190px;
  max-height: min(42vh, 320px);
  overflow-y: auto;
  margin: 0;
  padding: 5px;
  list-style: none;
  background: var(--menu-bg);
  border: 1px solid var(--menu-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-float);
  outline: none;
}

.msel-drop-up .msel-pop {
  top: auto;
  bottom: calc(100% + 6px);
}

.msel-opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  outline: none;
}
html.no-flex-gap .msel-opt > * + * {
  margin-left: 8px;
}






.msel-opt.is-active {
  background: var(--ink-1);
}

.msel-opt.is-selected {
  background: var(--accent-soft);
  color: var(--accent-text, var(--accent));
  font-weight: 600;
}

.msel-opt.is-disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.msel-opt-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.msel-opt-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
html.no-flex-gap .msel-opt-meta > * + * {
  margin-left: 4px;
}






/* ---------- 出入场 ---------- */
.msel-pop-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}

.msel-pop-leave-active {
  transition: opacity var(--dur-fast) var(--ease-in), transform var(--dur-fast) var(--ease-in);
}

.msel-pop-enter,
.msel-pop-leave-to {
  opacity: 0;
}

.msel-drop-up .msel-pop-enter,
.msel-drop-up .msel-pop-leave-to {
  transform: translateY(4px) scale(0.98);
}

.msel:not(.msel-drop-up) .msel-pop-enter,
.msel:not(.msel-drop-up) .msel-pop-leave-to {
  transform: translateY(-4px) scale(0.98);
}
</style>
