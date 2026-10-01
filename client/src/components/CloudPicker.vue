<template>
  <div class="picker-mask" @click.self="$emit('close')">
    <div class="picker glass">
      <header class="picker-head">
        <div>
          <h3 class="picker-title">{{ title }}</h3>
          <p class="picker-sub tiny muted">
            {{ hint || ('已选 ' + selected.length + ' / ' + max + ' 项') }}
          </p>
        </div>
        <button class="icon-btn" title="关闭" @click="$emit('close')">×</button>
      </header>

      <!-- 上传区：点击选择文件，或直接拖入 -->
      <div class="upload-row">
        <label class="btn btn-sm upload-btn" :class="{ disabled: uploading }">
          <input
            ref="file"
            type="file"
            :accept="accept"
            :multiple="max > 1"
            class="file-input"
            :disabled="uploading"
            @change="onPick"
          />
          {{ uploading ? '上传中…' : '上传新文件' }}
        </label>
        <span class="tiny muted">支持 {{ acceptHint }}，单文件最大 10MB</span>
      </div>

      <div v-if="uploadError" class="alert alert-danger">{{ uploadError }}</div>

      <!-- 配额 -->
      <div v-if="quota" class="quota-row">
        <span class="tiny muted">云盘 {{ quota.used_mb }}MB / {{ quota.quota_mb }}MB</span>
        <div class="bar quota-bar">
          <div class="bar-fill" :style="{ width: quota.percent + '%' }"></div>
        </div>
      </div>

      <!-- 筛选 -->
      <div class="filter-row">
        <Segmented v-model="kind" :options="kindOptions" />
        <button class="icon-btn" title="刷新" @click="load">↻</button>
      </div>

      <!-- 文件网格 -->
      <div class="grid-wrap">
        <div v-if="loading" class="empty-hint">读取中…</div>
        <div v-else-if="!filtered.length" class="empty-hint">
          <div>{{ kind === 'text' ? '还没有文本文件' : '还没有图片' }}</div>
          <div class="tiny">点上方「上传新文件」添加</div>
        </div>

        <div v-else class="grid">
          <button
            v-for="f in filtered"
            :key="f.hash"
            type="button"
            class="cell"
            :class="{ 'is-selected': selected.indexOf(f.hash) !== -1 }"
            @click="toggle(f)"
          >
            <img v-if="f.is_image" class="cell-img" :src="f.thumb_url || f.url" :alt="f.name" loading="lazy" />
            <div v-else class="cell-text">
              <span class="cell-text-icon">TXT</span>
            </div>

            <span class="cell-check" v-if="selected.indexOf(f.hash) !== -1">✓</span>
            <span class="cell-name">{{ f.name }}</span>

            <button class="cell-del" type="button" title="从云盘删除" @click.stop="remove(f)">×</button>
          </button>
        </div>
      </div>

      <footer class="picker-foot">
        <span class="tiny muted">选中的文件会作为附件随消息发送</span>
        <div class="foot-actions">
          <button class="btn btn-sm btn-ghost" @click="clearSelection">清空</button>
          <button class="btn btn-sm btn-primary" @click="confirm" :disabled="!selected.length">确定</button>
        </div>
      </footer>
    </div>
  </div>
</template>

<script>
import Segmented from './Segmented.vue';

// 云盘选择器：从云盘选文件（可多选）、上传新文件、删除文件
// 对话页与学习页共用同一个组件，保证两处的选择体验一致
export default {
  name: 'CloudPicker',
  components: { Segmented },
  props: {
    // 只选图片（拍题）还是任意文件（对话附件）
    imagesOnly: { type: Boolean, default: false },
    max: { type: Number, default: 4 },
    title: { type: String, default: '从云盘选择' },
    hint: { type: String, default: '' },
    // 已选中的 hash，打开时用于回显
    value: { type: Array, default: function() { return []; } }
  },
  data: function() {
    return {
      files: [],
      loading: false,
      uploading: false,
      uploadError: '',
      quota: null,
      kind: this.imagesOnly ? 'image' : '',
      selected: []
    };
  },
  computed: {
    accept: function() {
      return this.imagesOnly
        ? 'image/jpeg,image/png,image/webp,image/gif,image/bmp'
        : 'image/jpeg,image/png,image/webp,image/gif,image/bmp,text/plain,text/markdown,application/json,text/csv,.txt,.md,.json,.csv';
    },
    acceptHint: function() {
      return this.imagesOnly ? 'jpg / png / webp / gif' : '图片与文本（txt / md / json / csv）';
    },
    kindOptions: function() {
      // 拍题场景只该看到图片，不给文本选项
      if (this.imagesOnly) return [];
      return [
        { id: '', label: '全部' },
        { id: 'image', label: '图片' },
        { id: 'text', label: '文本' }
      ];
    },
    filtered: function() {
      if (!this.kind) return this.files;
      var self = this;
      return this.files.filter(function(f) { return f.kind === self.kind; });
    }
  },
  mounted: function() {
    this.selected = (this.value || []).slice();
    this.load();
    this.loadQuota();
  },
  methods: {
    load: function() {
      var self = this;
      this.loading = true;
      return this.$http.get('/cloud/files', { params: { limit: 300 } }).then(function(r) {
        if (r.data.code === 200) self.files = r.data.data.files || [];
      }).catch(function(err) {
        self.uploadError = err.message || '读取失败';
      }).then(function() {
        self.loading = false;
      });
    },

    loadQuota: function() {
      var self = this;
      return this.$http.get('/cloud/quota').then(function(r) {
        if (r.data.code === 200) self.quota = r.data.data;
      }).catch(function() {});
    },

    onPick: function(e) {
      var self = this;
      var files = Array.prototype.slice.call(e.target.files || []);
      if (!files.length) return;

      // 逐个上传：并发上传在教室网络下反而更容易失败，且逐个能给准确进度
      this.uploading = true;
      this.uploadError = '';

      var chain = Promise.resolve();
      var uploaded = [];

      files.forEach(function(file) {
        chain = chain.then(function() {
          var form = new FormData();
          form.append('file', file);
          return self.$http.post('/cloud/upload', form, {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: 120000
          }).then(function(r) {
            if (r.data.code !== 200) throw new Error(r.data.message || '上传失败');
            uploaded.push(r.data.data);
          });
        });
      });

      chain.then(function() {
        // 上传后自动勾选（用户上传就是为了用它）
        uploaded.forEach(function(f) {
          if (self.selected.length < self.max && self.selected.indexOf(f.hash) === -1) {
            self.selected.push(f.hash);
          }
        });
        self.$store.dispatch('toast', {
          message: '已上传 ' + uploaded.length + ' 个文件',
          type: 'success'
        });
        return self.load();
      }).then(function() {
        self.loadQuota();
      }).catch(function(err) {
        self.uploadError = err.message || '上传失败';
      }).then(function() {
        self.uploading = false;
        if (self.$refs.file) self.$refs.file.value = '';
      });
    },

    toggle: function(f) {
      var idx = this.selected.indexOf(f.hash);
      if (idx !== -1) {
        this.selected.splice(idx, 1);
        return;
      }
      if (this.selected.length >= this.max) {
        this.$store.dispatch('toast', { message: '最多选择 ' + this.max + ' 项', type: 'error' });
        return;
      }
      this.selected.push(f.hash);
    },

    remove: function(f) {
      var self = this;
      if (!window.confirm('确定从云盘删除「' + f.name + '」？')) return;

      this.$http.delete('/cloud/files/' + f.hash).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
        var idx = self.selected.indexOf(f.hash);
        if (idx !== -1) self.selected.splice(idx, 1);
        self.files = self.files.filter(function(x) { return x.hash !== f.hash; });
        self.loadQuota();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '删除失败', type: 'error' });
      });
    },

    clearSelection: function() {
      this.selected = [];
    },

    confirm: function() {
      // 回传完整的文件对象，父组件不必再查一次列表
      var map = {};
      this.files.forEach(function(f) { map[f.hash] = f; });
      var picked = this.selected.map(function(h) { return map[h]; }).filter(Boolean);
      this.$emit('picked', picked);
      this.$emit('close');
    }
  }
};
</script>

<style scoped>
.picker-mask {
  position: fixed;
  inset: 0;
  z-index: 250;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--gap-lg);
  background: var(--mask);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.picker {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 720px;
  max-height: min(720px, 90vh);
  padding: 20px;
  border-radius: var(--radius-xl);
}

.picker-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--gap-md);
  margin-bottom: var(--gap-sm);
}

.picker-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.picker-sub {
  margin: 2px 0 0;
}

.upload-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: var(--gap-sm);
}

.upload-btn {
  position: relative;
  overflow: hidden;
  cursor: pointer;
  margin: 0;
}

.upload-btn.disabled {
  opacity: 0.6;
  pointer-events: none;
}

.upload-btn input[type="file"] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.quota-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: var(--gap-sm);
}

.quota-bar {
  flex: 1;
  height: 4px;
}

.filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-sm);
  margin-bottom: var(--gap-sm);
}

.icon-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

.icon-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}

.grid-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 120px;
  margin: 0 -4px;
  padding: 0 4px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 10px;
}

.cell {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 0;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  cursor: pointer;
  overflow: hidden;
  font-family: inherit;
  text-align: left;
  transition: border-color var(--transition), box-shadow var(--transition);
}

.cell:hover {
  border-color: var(--accent-border-strong);
}

.cell.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.cell-img {
  width: 100%;
  height: 92px;
  object-fit: cover;
  background: var(--ink-1);
  display: block;
}

.cell-text {
  height: 92px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ink-1);
}

.cell-text-icon {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 0.06em;
}

.cell-name {
  padding: 6px 8px;
  font-size: 11.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-check {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--text-invert);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cell-del {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: var(--mask-strong);
  color: var(--text-invert);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition);
}

.cell:hover .cell-del {
  opacity: 1;
}

.cell-del:hover {
  background: var(--danger);
}

.picker-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  margin-top: var(--gap-sm);
  padding-top: var(--gap-sm);
  border-top: 1px solid var(--ink-2);
}

.foot-actions {
  display: flex;
  gap: 8px;
}

@media (max-width: 600px) {
  .picker-mask {
    padding: 0;
    align-items: flex-end;
  }

  .picker {
    max-height: 92vh;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
}
</style>
