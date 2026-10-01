<template>
  <div class="segmented" role="tablist">
    <button
      v-for="opt in options"
      :key="opt.id"
      type="button"
      class="segmented-item"
      :class="{ 'is-active': opt.id === value }"
      :disabled="opt.disabled"
      :title="opt.hint || ''"
      role="tab"
      :aria-selected="opt.id === value"
      @click="$emit('input', opt.id)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<script>
// 分段控件：题量模式、对话模式等「几个互斥选项」的场景统一用它
// options: [{ id, label, hint?, disabled? }]
export default {
  name: 'Segmented',
  props: {
    value: { type: String, default: '' },
    options: { type: Array, default: function() { return []; } }
  }
};
</script>
