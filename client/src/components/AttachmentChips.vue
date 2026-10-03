<template>
  <div class="chips">
    <div v-for="item in items" :key="item.hash" class="chip" :class="'chip-' + item.kind">
      <img
        v-if="item.kind === 'image'"
        class="chip-thumb"
        :src="item.thumb_url || item.url"
        :alt="item.name"
      />
      <span v-else class="chip-file-icon">TXT</span>

      <div class="chip-meta">
        <div class="chip-name" :title="item.name">{{ item.name }}</div>
        <div class="chip-size tiny muted">{{ formatSize(item.size) }}</div>
      </div>

      <button v-if="removable" class="chip-remove" type="button" title="移除" @click="$emit('remove', item.hash)">×</button>
    </div>
  </div>
</template>

<script>
// 已选附件条：显示缩略图与文件名，可逐个移除
export default {
  name: 'AttachmentChips',
  props: {
    items: { type: Array, default: function() { return []; } },
    removable: { type: Boolean, default: true }
  },
  methods: {
    formatSize: function(bytes) {
      var n = Number(bytes || 0);
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }
  }
};
</script>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
html.no-flex-gap .chips > * + * {
  margin-left: 8px;
}



.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 220px;
  padding: 6px 8px 6px 6px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--surface-2);
}
html.no-flex-gap .chip > * + * {
  margin-left: 8px;
}



.chip-thumb {
  width: 34px;
  height: 34px;
  border-radius: var(--radius-xs);
  object-fit: cover;
  background: var(--ink-2);
  flex-shrink: 0;
}

.chip-file-icon {
  width: 34px;
  height: 34px;
  border-radius: var(--radius-xs);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.chip-meta {
  min-width: 0;
  flex: 1;
}

.chip-name {
  font-size: 12.5px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-size {
  line-height: 1.3;
}

.chip-remove {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-2xs);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

@media (hover: hover) {
.chip-remove:hover {
  background: var(--danger-tint);
  color: var(--danger);
}
}

</style>
