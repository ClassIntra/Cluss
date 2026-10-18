<template>
  <div class="cloud-page">
    <AppNav active="cloud" />

    <main class="body">
      <div class="toolbar glass">
        <div class="toolbar-left">
          <Segmented v-model="kind" :options="kindOptions" />
          <label class="btn btn-sm btn-primary upload-btn" :class="{ disabled: uploading }">
            <input type="file" multiple class="file-input" :disabled="uploading" @change="onPick" />
            {{ uploading ? '上传中…' + (uploadPercent > 0 ? uploadPercent + '%' : '') : '上传文件' }}
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

      <!-- 整页列表加载失败：统一用带「重试」的错误条（单次动作失败仍走 toast） -->
      <ErrorBanner :message="error" retry @retry="load" />

      <div class="list-wrap glass">
        <div v-if="loading" class="empty-hint">读取中…</div>
        <div v-else-if="!filtered.length" class="empty-hint">
          <div>{{ kind === 'text' ? '还没有文本文件' : (kind === 'image' ? '还没有图片' : '云盘是空的') }}</div>
          <div class="tiny">点上方「上传文件」添加题目照片或资料</div>
        </div>

        <div v-else class="grid">
          <div v-for="f in filtered" :key="f.hash" class="card">
            <button class="card-preview" type="button" :title="f.name" @click="preview(f)">
              <!-- 加载失败时换成一句人话 + 重试，不再露出破图和一长串文件名 -->
              <div
                v-if="f.is_image && failed[f.hash]"
                class="card-img card-img-failed"
                @click.stop="retry(f)"
              >
                <span class="tiny">图片加载失败 · 点此重试</span>
              </div>
              <img
                v-else-if="f.is_image"
                class="card-img"
                :src="f.thumb_url || f.url"
                :alt="f.name"
                loading="lazy"
                @error="onImgError(f)"
              />
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
import ErrorBanner from '@/components/ErrorBanner.vue';
import Segmented from '@/components/Segmented.vue';

// 云盘视图记忆的 localStorage 键：记住上次选的分类（全部/图片/文本），
// 切页或刷新后不再落回默认「全部」（写法参考 Notes.vue 的持久化）。
var CLOUD_VIEW_KEY = 'cluss_cloud_view';

export default {
  name: 'CloudView',
  components: { AppNav, ErrorBanner, Segmented },
  data: function() {
    return {
      files: [],
      quota: null,
      kind: '',
      loading: false,
      uploading: false,
      // 上传进度百分比（0-100）。axios 的 onUploadProgress 回填，见 onPick。
      uploadPercent: 0,
      error: '',
      previewing: null,
      // 加载失败的文件（hash → true）。401/404 时 <img> 只会给一个
      // 莫名的破图加 alt 文本，学生不知道发生了什么；
      // 换成一句人话 + 重试入口（见模板与 onImgError）。
      failed: {}
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
  watch: {
    // 分类切了就记下来，下次进入沿用（见 restoreView / saveView）
    kind: function() { this.saveView(); }
  },
  mounted: function() {
    // 先恢复上次的分类再取数据：恢复发生时列表还是空的，不会闪一下再变
    this.restoreView();
    this.load();
    this.loadQuota();
  },
  methods: {
    // 视图记忆：恢复上次的分类筛选。只认白名单内的值 ——
    // localStorage 可能被清空或写入脏数据，非法值一律落回默认「全部」。
    restoreView: function() {
      try {
        var v = localStorage.getItem(CLOUD_VIEW_KEY);
        if (v === 'image' || v === 'text') this.kind = v;
      } catch (e) {}
    },

    saveView: function() {
      try {
        localStorage.setItem(CLOUD_VIEW_KEY, this.kind || '');
      } catch (e) {
        // 隐私模式等场景 localStorage 可能抛异常，记忆失效不该影响筛选本身
      }
    },

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
      this.uploadPercent = 0;

      var chain = Promise.resolve();
      var done = 0;
      var failed = [];

      picked.forEach(function(file) {
        chain = chain.then(function() {
          var form = new FormData();
          form.append('file', file);
          return self.$http.post('/cloud/upload', form, {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: 120000,
            // 浏览器上传进度：axios 1.x 支持该配置项。
            // total 不可知时（lengthComputable 为假）是 0，跳过以免算出 NaN。
            // 多文件是串行上传，所以用「已完成个数 + 当前文件进度」估整批百分比。
            onUploadProgress: function(pe) {
              if (!pe || !pe.total) return;
              var frac = pe.loaded / pe.total;
              self.uploadPercent = Math.min(99, Math.round((done + frac) / picked.length * 100));
            }
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
        // 上传失败属于「单次动作失败」，走 toast。
        // 之前写进 this.error 会被紧接着调用的 load() 里的 error='' 抹掉，等于没提示。
        if (failed.length) {
          self.$store.dispatch('toast', { message: failed.join('；'), type: 'error' });
        }
        return self.load();
      }).then(function() {
        self.loadQuota();
      }).then(function() {
        self.uploading = false;
        self.uploadPercent = 0;
        if (self.$refs && e.target) e.target.value = '';
      });
    },

    remove: function(f) {
      var self = this;
      this.$store.dispatch('confirm', {
        message: '确定删除「' + f.name + '」？删除后无法恢复。',
        confirmText: '删除',
        danger: true
      }).then(function(ok) {
        if (!ok) return;
        self.$http.delete('/cloud/files/' + f.hash).then(function(r) {
          if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
          self.files = self.files.filter(function(x) { return x.hash !== f.hash; });
          self.loadQuota();
        }).catch(function(err) {
          self.$store.dispatch('toast', { message: err.message || '删除失败', type: 'error' });
        });
      });
    },

    // 图片加载失败：记录下来（模板据此换成「加载失败 · 点此重试」），
    // 并顺手探一下是不是登录态问题 —— 401 时给学生一句**能行动**的话，
    // 而不是让他对着一个破图猜。
    onImgError: function(f) {
      this.$set(this.failed, f.hash, true);
      var self = this;
      var u = f.thumb_url || f.url;
      fetch(u, { credentials: 'same-origin' }).then(function(r) {
        if (r.status === 401) {
          self.$store.dispatch('toast', { message: '登录已过期，图片加载失败，请重新登录', type: 'error' });
        } else if (r.status === 404) {
          self.$store.dispatch('toast', { message: '原图已不存在，无法显示', type: 'error' });
        }
      }).catch(function() {});
    },

    // 重试：加时间戳绕过浏览器缓存（失败的那次响应可能已被缓存）
    retry: function(f) {
      this.$delete(this.failed, f.hash);
      var bust = '_t=' + Date.now();
      f.thumb_url = '/api/cloud/files/' + f.hash + '?thumb=1&' + bust;
      f.url = '/api/cloud/files/' + f.hash + '?' + bust;
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
      return this.$fmtLocal(iso);
    }
  }
};
</script>

<style scoped>
.cloud-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  /* 完全贴边：去掉固定留白，仅保留安全区边距（无刘海设备上为 0） */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  gap: var(--gap-md);
}
html.no-flex-gap .cloud-page > * + * {
  margin-top: var(--gap-md);
}










.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}
html.no-flex-gap .body > * + * {
  margin-top: var(--gap-md);
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
html.no-flex-gap .toolbar > * + * {
  margin-left: var(--gap-md);
}










.toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
html.no-flex-gap .toolbar-left > * + * {
  margin-left: 10px;
}










.toolbar-right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
html.no-flex-gap .toolbar-right > * + * {
  margin-left: 8px;
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
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
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

/* 图片加载失败时的兜底卡片：不露破图和一长串文件名，给一句人话 + 可点击重试 */
.card-img-failed {
  width: 100%;
  height: 130px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ink-1);
  color: var(--text-tertiary);
  cursor: pointer;
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
html.no-flex-gap .card-text > * + * {
  margin-top: 8px;
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
html.no-flex-gap .card-foot > * + * {
  margin-left: 6px;
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
html.no-flex-gap .card-actions > * + * {
  margin-left: 2px;
}










.icon-btn {
  width: clamp(26px, 17.36px + 0.9vw, 40px);
  height: clamp(26px, 17.36px + 0.9vw, 40px);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-tertiary);
  font-size: clamp(15px, 12.12px + 0.3vw, 20px);
  line-height: 26px;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  display: inline-block;
}

@media (hover: hover) {
.icon-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}
}


@media (hover: hover) {
.icon-danger:hover {
  background: var(--danger-tint);
  color: var(--danger);
}
}


/* ---------- 预览 ---------- */
.preview-mask {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
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
html.no-flex-gap .preview-mask > * + * {
  margin-top: var(--gap-md);
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
html.no-flex-gap .preview-bar > * + * {
  margin-left: var(--gap-md);
}










.preview-name {
  color: var(--surface-3);
  font-size: 13px;
}
</style>