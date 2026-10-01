<template>
  <div class="cloud-page">
    <AppNav active="cloud" />

    <main class="body">
      <div class="toolbar glass">
        <div class="toolbar-left">
          <Segmented v-model="kind" :options="kindOptions" />
          <label class="btn btn-sm btn-primary upload-btn" :class="{ disabled: uploading }">
            <input type="file" multiple class="file-input" :disabled="uploading" @change="onPick" />
            {{ uploading ? '上传中…' : '上传文件' }}
          </label>
        </div>
        <div class="toolbar-right">
          <span class="tiny muted">共 {{ files.length }} 个文件</span>
          <button class="icon-btn" title="刷新" @click="load">↻</button>
        </div>
      </div>

      <!-- 配额 -->
      <div v-if="quota" class="quota glass">
        <div class="quota-info">
          <span class="section-label">云盘空间</span>
          <span class="tiny muted">{{ quota.used_mb }}MB / {{ quota.quota_mb }}MB</span>
        </div>
        <div class="bar quota-bar" :class="{ 'quota-warn': quota.percent > 85 }">
          <div class="bar-fill" :style="{ width: quota.percent + '%' }"></div>
        </div>
      </div>

      <div v-if="error" class="alert alert-danger">{{ error }}</div>

      <div class="list-wrap glass">
        <div v-if="loading" class="empty-hint">读取中…</div>
        <div v-else-if="!filtered.length" class="empty-hint">
          <div>{{ kind === 'text' ? '还没有文本文件' : (kind === 'image' ? '还没有图片' : '云盘是空的') }}</div>
          <div class="tiny">点上方「上传文件」添加题目照片或资料</div>
        </div>

        <div v-else class="grid">
          <div v-for="f in filtered" :key="f.hash" class="card">
            <button class="card-preview" type="button" :title="f.name" @click="preview(f)">
              <img v-if="f.is_image" class="card-img" :src="f.thumb_url || f.url" :alt="f.name" loading="lazy" />
              <div v-else class="card-text">
                <span class="card-text-icon">TXT</span>
                <span class="card-text-name">{{ f.name }}</span>
              </div>
            </button>

            <div class="card-foot">
              <div class="card-meta">
                <div class="card-name" :title="f.name">{{ f.name }}</div>
                <div class="tiny muted">{{ formatSize(f.size) }} · {{ formatDate(f.uploaded_at) }}</div>
              </div>
              <div class="card-actions">
                <a class="icon-btn" :href="f.url + '?download=1'" :download="f.name" title="下载">↓</a>
                <button class="icon-btn icon-danger" title="删除" @click="remove(f)">×</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- 图片预览 -->
    <transition name="fade">
      <div v-if="previewing" class="preview-mask" @click.self="previewing = null">
        <img class="preview-img" :src="previewing.url" :alt="previewing.name" />
        <div class="preview-bar">
          <span class="preview-name">{{ previewing.name }}</span>
          <button class="btn btn-sm btn-ghost" @click="previewing = null">关闭</button>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import Segmented from '@/components/Segmented.vue';

export default {
  name: 'CloudView',
  components: { AppNav, Segmented },
  data: function() {
    return {
      files: [],
      quota: null,
      kind: '',
      loading: false,
      uploading: false,
      error: '',
      previewing: null
    };
  },
  computed: {
    kindOptions: function() {
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
    this.load();
    this.loadQuota();
  },
  methods: {
    load: function() {
      var self = this;
      this.loading = true;
      this.error = '';
      return this.$http.get('/cloud/files', { params: { limit: 500 } }).then(function(r) {
        if (r.data.code === 200) self.files = r.data.data.files || [];
      }).catch(function(err) {
        self.error = err.message || '读取失败';
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
      var picked = Array.prototype.slice.call(e.target.files || []);
      if (!picked.length) return;

      this.uploading = true;
      this.error = '';

      var chain = Promise.resolve();
      var done = 0;
      var failed = [];

      picked.forEach(function(file) {
        chain = chain.then(function() {
          var form = new FormData();
          form.append('file', file);
          return self.$http.post('/cloud/upload', form, {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: 120000
          }).then(function(r) {
            if (r.data.code !== 200) throw new Error(r.data.message || '上传失败');
            done++;
          }).catch(function(err) {
            failed.push(file.name + '：' + (err.message || '上传失败'));
          });
        });
      });

      chain.then(function() {
        if (done) {
          self.$store.dispatch('toast', { message: '成功上传 ' + done + ' 个文件', type: 'success' });
        }
        if (failed.length) self.error = failed.join('；');
        return self.load();
      }).then(function() {
        self.loadQuota();
      }).then(function() {
        self.uploading = false;
        if (self.$refs && e.target) e.target.value = '';
      });
    },

    remove: function(f) {
      var self = this;
      if (!window.confirm('确定删除「' + f.name + '」？删除后无法恢复。')) return;

      this.$http.delete('/cloud/files/' + f.hash).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
        self.files = self.files.filter(function(x) { return x.hash !== f.hash; });
        self.loadQuota();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '删除失败', type: 'error' });
      });
    },

    preview: function(f) {
      if (!f.is_image) {
        // 文本文件直接走下载，浏览器会以新标签打开
        window.open(f.url + '?download=1', '_blank');
        return;
      }
      this.previewing = f;
    },

    formatSize: function(bytes) {
      var n = Number(bytes || 0);
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    },

    formatDate: function(iso) {
      return String(iso || '').replace('T', ' ').slice(0, 16);
    }
  }
};
</script>

<style scoped>
.cloud-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  padding: var(--gap-md);
  gap: var(--gap-md);
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
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

.quota {
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.quota-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.quota-bar {
  height: 5px;
}

.quota-warn .bar-fill {
  background: linear-gradient(90deg, var(--danger-grad-a), var(--danger-grad-b));
}

.list-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  border-radius: var(--radius-lg);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: var(--gap-md);
}

.card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--surface-1);
  overflow: hidden;
}

.card-preview {
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  font-family: inherit;
}

.card-img {
  width: 100%;
  height: 130px;
  object-fit: cover;
  display: block;
  background: var(--ink-1);
}

.card-text {
  height: 130px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px;
  background: var(--ink-1);
}

.card-text-icon {
  font-size: 13px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 0.06em;
}

.card-text-name {
  font-size: 11.5px;
  color: var(--text-secondary);
  text-align: center;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-all;
}

.card-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
}

.card-meta {
  flex: 1;
  min-width: 0;
}

.card-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.icon-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 15px;
  line-height: 26px;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  display: inline-block;
}

.icon-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}

.icon-danger:hover {
  background: var(--danger-tint);
  color: var(--danger);
}

/* ---------- 预览 ---------- */
.preview-mask {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--gap-md);
  padding: var(--gap-lg);
  background: var(--mask-deep);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}

.preview-img {
  max-width: 94vw;
  max-height: 84vh;
  object-fit: contain;
  border-radius: var(--radius-md);
}

.preview-bar {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
}

.preview-name {
  color: var(--surface-3);
  font-size: 13px;
}
</style>