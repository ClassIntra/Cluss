<template>
  <div class="writing-page">
    <AppNav active="writing" :show-menu-button="isPortrait" @toggle-sidebar="drawerOpen = !drawerOpen" />

    <transition name="fade">
      <div v-if="drawerOpen" class="app-drawer-mask" @click="drawerOpen = false"></div>
    </transition>

    <div class="body" :class="{ 'is-portrait': isPortrait }">
      <transition name="fade">
        <aside
          v-show="!isPortrait || drawerOpen"
          class="sidebar app-sidebar-drawer"
          :class="{ 'is-open': drawerOpen }"
        >
          <!-- 用途 -->
          <div class="panel glass">
            <span class="section-label">要做什么</span>
            <Segmented v-model="mode" :options="modeOptions" />
            <p class="tiny muted mode-hint">{{ modeHint }}</p>

            <!-- 参数 -->
            <span class="section-label">语言</span>
            <Segmented v-model="language" :options="languageOptions" />

            <div class="row-2">
              <label class="field">
                <span class="field-label">文体</span>
                <select v-model="genre" class="input">
                  <option value="">不限</option>
                  <option v-for="g in genreOptions" :key="g" :value="g">{{ g }}</option>
                </select>
              </label>

              <label class="field">
                <span class="field-label">风格</span>
                <select v-model="style" class="input">
                  <option value="">不限</option>
                  <option v-for="s in styleOptions" :key="s" :value="s">{{ s }}</option>
                </select>
              </label>
            </div>

            <label class="field">
              <span class="field-label">字数要求</span>
              <input
                v-model="wordLimit"
                class="input"
                type="number"
                min="0"
                max="5000"
                step="50"
                :placeholder="language === 'en' ? '如 200（词）' : '如 800（字）'"
              />
              <span class="tiny muted field-note">留空或 0 表示不限。篇幅越长，消耗越多。</span>
            </label>
          </div>

          <!-- 历史 -->
          <div class="hist-panel glass">
            <div class="hist-head">
              <span class="section-label">我的作文</span>
              <button class="icon-btn" title="刷新" @click="loadPieces">↻</button>
            </div>
            <div class="hist-list">
              <div v-if="!pieces.length" class="tiny muted hist-empty">还没有保存过作文</div>
              <div
                v-for="p in pieces"
                :key="p.id"
                class="hist-item"
                :class="{ active: p.id === openedId }"
                @click="openPiece(p.id)"
              >
                <span class="hist-badge">{{ modeLabel(p.mode) }}</span>
                <span class="hist-title">{{ p.topic || p.excerpt || '未命名' }}</span>
                <button class="hist-del" title="删除" @click.stop="removePiece(p)">×</button>
              </div>
            </div>
          </div>
        </aside>
      </transition>

      <main class="main">
        <!-- 题目与素材 -->
        <section class="editor glass">
          <div class="editor-head">
            <span class="section-label">{{ mode === 'grade' ? '我的作文' : '题目与要求' }}</span>
            <div class="editor-actions">
              <label class="btn btn-sm upload-btn" :class="{ disabled: uploading }">
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  class="file-input"
                  :disabled="uploading"
                  @change="onCamera"
                />
                {{ uploading ? '上传中…' : '拍照' }}
              </label>
              <button class="btn btn-sm btn-ghost" @click="pickerOpen = true">从云盘选图</button>
            </div>
          </div>

          <AttachmentChips
            v-if="attachments.length"
            :items="attachments"
            @remove="removeAttachment"
          />

          <textarea
            v-model="draft"
            class="draft-input"
            :rows="mode === 'grade' ? 6 : 3"
            :placeholder="draftPlaceholder"
            :disabled="sending"
          ></textarea>

          <div class="editor-foot">
            <span class="tiny muted">
              {{ mode === 'grade' ? '可以直接粘贴，也可以拍手写稿' : '图片作为题目素材（选填）' }}
            </span>
            <button class="btn btn-primary" :disabled="!canSend" @click="start">
              {{ sending ? '生成中…' : actionLabel }}
            </button>
          </div>
        </section>

        <!-- 结果 -->
        <section class="result glass">
          <div class="result-head">
            <span class="section-label">{{ resultLabel }}</span>
            <div class="result-actions">
              <select v-model="modelId" class="model-select-sm" :disabled="sending">
                <option v-for="m in models" :key="m.id" :value="m.id" :disabled="!m.available">
                  {{ m.label }}
                </option>
              </select>
              <button v-if="result && !sending" class="btn btn-sm btn-ghost" @click="copyResult">复制</button>
              <button v-if="result && !sending" class="btn btn-sm btn-ghost" @click="savePiece">保存</button>
            </div>
          </div>

          <div ref="scroller" class="result-body">
            <div v-if="!result" class="empty-hint">
              <div class="tiny">{{ emptyHint }}</div>
            </div>
            <div v-else class="md-body" v-html="render(result)"></div>
            <span v-if="sending" class="caret"></span>
          </div>

          <div v-if="visionStatus" class="vision-status">
            <span class="spinner"></span>
            <span>{{ visionStatus }}</span>
          </div>

          <div v-if="streamError" class="alert alert-danger result-error">{{ streamError }}</div>

          <div v-if="result && !sending" class="result-stat tiny muted">
            {{ charCount }} {{ language === 'en' ? '字符' : '字' }}
            <span v-if="saved"> · 已保存</span>
          </div>
        </section>
      </main>
    </div>

    <CloudPicker
      v-if="pickerOpen"
      images-only
      :max="4"
      :title="mode === 'grade' ? '选择手写稿照片' : '选择题目素材'"
      :value="attachmentHashes"
      @picked="onPicked"
      @close="pickerOpen = false"
    />
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import Segmented from '@/components/Segmented.vue';
import AttachmentChips from '@/components/AttachmentChips.vue';
import CloudPicker from '@/components/CloudPicker.vue';
import { renderMarkdown } from '@/utils/markdown';
import { readSseStream, postStream } from '@/utils/sse';

var GENRES = {
  zh: ['记叙文', '议论文', '说明文', '散文', '读后感', '书信', '演讲稿', '通知'],
  en: ['Narrative', 'Argumentative', 'Expository', 'Descriptive', 'Letter', 'Speech', 'Review']
};

var STYLES = {
  zh: ['平实', '文艺', '议论性强', '简洁有力', '细腻描写', '幽默'],
  en: ['Plain', 'Literary', 'Argumentative', 'Concise', 'Descriptive', 'Humorous']
};

export default {
  name: 'WritingView',
  components: { AppNav, Segmented, AttachmentChips, CloudPicker },
  data: function() {
    return {
      mode: 'generate',
      language: 'zh',
      genre: '',
      style: '',
      wordLimit: '',
      draft: '',
      result: '',
      attachments: [],
      pieces: [],
      openedId: 0,
      models: [],
      modelId: '',
      sending: false,
      uploading: false,
      saved: false,
      streamError: '',
      visionStatus: '',
      conversationId: '',
      pickerOpen: false,
      drawerOpen: false,
      isPortrait: false
    };
  },
  computed: {
    modeOptions: function() {
      return [
        { id: 'generate', label: '写范文', hint: '按题目与要求生成一篇' },
        { id: 'grade', label: '批改我的', hint: '粘贴或拍下自己写的，逐段点评' },
        { id: 'outline', label: '要提纲', hint: '只给结构提纲与素材，自己动笔' }
      ];
    },
    languageOptions: function() {
      return [
        { id: 'zh', label: '中文' },
        { id: 'en', label: 'English' }
      ];
    },
    genreOptions: function() {
      return GENRES[this.language] || GENRES.zh;
    },
    styleOptions: function() {
      return STYLES[this.language] || STYLES.zh;
    },
    modeHint: function() {
      return {
        generate: '直接给出一篇完整范文，末尾附一句写作思路',
        grade: '逐段点评 + 三个维度定性评价 + 润色示例',
        outline: '只给提纲与素材方向，不写成完整文章'
      }[this.mode];
    },
    draftPlaceholder: function() {
      if (this.mode === 'grade') return '把你写的作文粘贴在这里（也可以只拍照片，不粘贴）';
      return this.language === 'en' ? '如：Write about a memorable trip' : '如：以「那一刻我长大了」为题写一篇记叙文';
    },
    actionLabel: function() {
      return { generate: '开始写', grade: '开始批改', outline: '生成提纲' }[this.mode];
    },
    resultLabel: function() {
      return { generate: '范文', grade: '批改结果', outline: '写作提纲' }[this.mode];
    },
    emptyHint: function() {
      return {
        generate: '填好题目与要求，点「开始写」',
        grade: '粘贴作文或拍下手写稿，点「开始批改」',
        outline: '填好题目，点「生成提纲」，然后自己动笔'
      }[this.mode];
    },
    attachmentHashes: function() {
      return this.attachments.map(function(a) { return a.hash; });
    },
    canSend: function() {
      if (this.sending) return false;
      if (this.mode === 'grade') {
        // 批改：文本与图至少有一个
        return !!this.draft.trim() || this.attachments.length > 0;
      }
      // 生成与提纲都需要题目；题目既可在文本框写，也可只给图片（看图作文）
      return !!this.draft.trim() || this.attachments.length > 0;
    },
    charCount: function() {
      // 中英混排下「字数」口径不同，这里统一按去空白字符数给个直观值
      return String(this.result || '').replace(/\s/g, '').length;
    }
  },
  watch: {
    // 切语言时清掉已选的文体/风格：中文的"议论文"在英文列表里没有对应项，
    // 留着会让下拉显示成空白
    language: function() {
      this.genre = '';
      this.style = '';
    },
    // 换用途即换任务，清掉上一次结果与会话
    mode: function() {
      this.result = '';
      this.streamError = '';
      this.openedId = 0;
      this.conversationId = '';
      this.saved = false;
    }
  },
  mounted: function() {
    this.checkOrientation();
    window.addEventListener('resize', this.checkOrientation);
    window.addEventListener('orientationchange', this.checkOrientation);

    this.$store.dispatch('auth/fetchWallet').catch(function() {});
    this.loadModels();
    this.loadPieces();
  },
  beforeDestroy: function() {
    window.removeEventListener('resize', this.checkOrientation);
    window.removeEventListener('orientationchange', this.checkOrientation);
    if (this._abort) this._abort.abort();
  },
  methods: {
    checkOrientation: function() {
      this.isPortrait = window.innerHeight >= window.innerWidth;
      if (!this.isPortrait) this.drawerOpen = false;
    },

    render: function(text) { return renderMarkdown(text); },

    modeLabel: function(m) {
      return { generate: '范文', grade: '批改', outline: '提纲' }[m] || m;
    },

    loadModels: function() {
      var self = this;
      return this.$http.get('/models').then(function(r) {
        if (r.data.code !== 200) return;
        self.models = r.data.data.models || [];
        if (!self.modelId) self.modelId = r.data.data.default_model || '';
      }).catch(function() {});
    },

    loadPieces: function() {
      var self = this;
      return this.$http.get('/writing/pieces', { params: { limit: 50 } }).then(function(r) {
        if (r.data.code === 200) self.pieces = r.data.data.items || [];
      }).catch(function() {});
    },

    openPiece: function(id) {
      var self = this;
      return this.$http.get('/writing/pieces/' + id).then(function(r) {
        if (r.data.code !== 200) return;
        var p = r.data.data.piece;
        self.openedId = id;
        self.mode = p.mode;
        self.language = p.language === 'en' ? 'en' : 'zh';
        self.genre = p.genre || '';
        self.style = p.style || '';
        self.wordLimit = p.word_limit ? String(p.word_limit) : '';
        // 批改的正文是学生原稿，其余是 AI 产出的内容
        self.draft = p.mode === 'grade' ? p.content : (p.topic || '');
        self.result = p.mode === 'grade' ? p.feedback : p.content;
        self.attachments = (p.image_hashes || []).map(function(h) {
          return { hash: h, name: h.slice(0, 8), kind: 'image', url: '/api/cloud/files/' + h, thumb_url: '/api/cloud/files/' + h + '?thumb=1' };
        });
        self.saved = true;
        self.streamError = '';
        self.drawerOpen = false;
        self.$nextTick(function() { self.scrollResult(); });
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '打开失败', type: 'error' });
      });
    },

    removePiece: function(p) {
      var self = this;
      if (!window.confirm('确定删除这篇记录？')) return;
      this.$http.delete('/writing/pieces/' + p.id).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
        self.pieces = self.pieces.filter(function(x) { return x.id !== p.id; });
        if (self.openedId === p.id) {
          self.openedId = 0;
          self.result = '';
        }
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '删除失败', type: 'error' });
      });
    },

    onPicked: function(files) {
      var self = this;
      this.attachments = files.slice(0, 4).map(function(f) {
        return {
          hash: f.hash, name: f.name, size: f.size, kind: 'image',
          url: f.url || ('/api/cloud/files/' + f.hash),
          thumb_url: f.thumb_url || ('/api/cloud/files/' + f.hash + '?thumb=1')
        };
      });
      void self;
    },

    removeAttachment: function(hash) {
      this.attachments = this.attachments.filter(function(a) { return a.hash !== hash; });
    },

    onCamera: function(e) {
      var self = this;
      var file = (e.target.files || [])[0];
      if (!file) return;

      this.uploading = true;
      this.streamError = '';

      var form = new FormData();
      form.append('file', file);

      this.$http.post('/cloud/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000
      }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '上传失败');
        var f = r.data.data;
        if (self.attachments.length >= 4) throw new Error('最多 4 张');
        self.attachments.push({
          hash: f.hash, name: f.name, size: f.size, kind: 'image',
          url: f.url || ('/api/cloud/files/' + f.hash),
          thumb_url: f.thumb_url || ('/api/cloud/files/' + f.hash + '?thumb=1')
        });
        self.$store.dispatch('toast', { message: '已拍照', type: 'success' });
      }).catch(function(err) {
        self.streamError = err.message || '上传失败';
      }).then(function() {
        self.uploading = false;
        if (e.target) e.target.value = '';
      });
    },

    scrollResult: function() {
      var self = this;
      this.$nextTick(function() {
        var el = self.$refs.scroller;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    start: function() {
      var self = this;
      if (!this.canSend) return;

      this.result = '';
      this.streamError = '';
      this.visionStatus = '';
      this.saved = false;
      this.sending = true;

      var controller = new AbortController();
      this._abort = controller;

      var url = '/api/writing/' + this.mode + '/stream';
      var body = {
        conversation_id: this.conversationId || '',
        model_id: this.modelId || '',
        language: this.language,
        genre: this.genre,
        style: this.style,
        word_limit: Number(this.wordLimit) || 0,
        topic: this.mode === 'grade' ? '' : this.draft.trim(),
        content: this.mode === 'grade' ? this.draft.trim() : '',
        image_hashes: this.attachmentHashes
      };

      postStream(url, this.$store.state.auth.token, body, controller.signal).then(function(resp) {
        return readSseStream(resp, {
          onMeta: function(meta) {
            if (meta.conversation_id) self.conversationId = meta.conversation_id;
          },
          onStatus: function(st) {
            if (st.stage === 'vision') self.visionStatus = st.message || '正在识别图片…';
            else if (st.stage === 'vision_done') self.visionStatus = '';
          },
          onDelta: function(text) {
            self.result += text;
            self.scrollResult();
          },
          onDone: function() {
            self.visionStatus = '';
            self.$store.dispatch('auth/fetchWallet').catch(function() {});
          },
          onError: function(message) {
            self.visionStatus = '';
            self.streamError = message || '生成失败，请重试';
          }
        });
      }).catch(function(err) {
        self.visionStatus = '';
        if (err && err.name === 'AbortError') return;
        self.streamError = err.message || '网络异常，请重试';
        if (err && err.status === 402) {
          self.$store.dispatch('auth/fetchWallet').catch(function() {});
        }
      }).then(function() {
        self.sending = false;
        self._abort = null;
        if (!self.result && !self.streamError) {
          self.streamError = '未收到内容，请重试';
        }
      });
    },

    copyResult: function() {
      var text = this.result;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          // 复制成功不打扰用户，用 toast 轻提示即可
        }).catch(function() { /* 无权限时静默 */ });
      }
      this.$store.dispatch('toast', { message: '已复制', type: 'success' });
    },

    savePiece: function() {
      var self = this;
      var payload = {
        conversation_id: this.conversationId || '',
        mode: this.mode,
        language: this.language,
        genre: this.genre,
        style: this.style,
        word_limit: Number(this.wordLimit) || 0,
        topic: this.mode === 'grade' ? '' : this.draft.trim(),
        image_hashes: this.attachmentHashes
      };
      // 批改存的是原稿 + 批改意见；其余存 AI 产出的内容
      if (this.mode === 'grade') {
        payload.content = this.draft.trim() || '（手写稿）';
        payload.feedback = this.result;
      } else {
        payload.content = this.result;
      }

      this.$http.post('/writing/pieces', payload).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '保存失败');
        self.saved = true;
        self.$store.dispatch('toast', { message: '已保存到作文记录', type: 'success' });
        self.loadPieces();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '保存失败', type: 'error' });
      });
    }
  }
};
</script>

<style scoped>
.writing-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  padding: var(--gap-md);
  gap: var(--gap-md);
}

.body {
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  gap: var(--gap-md);
  flex: 1;
  min-height: 0;
}

.body.is-portrait {
  grid-template-columns: minmax(0, 1fr);
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  min-height: 0;
}

/* ---------- 参数面板 ---------- */
.panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  overflow-y: auto;
}

.panel .section-label:not(:first-child) {
  margin-top: 6px;
}

.mode-hint {
  margin: 0 0 4px;
  line-height: 1.5;
}

.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.field-note {
  display: block;
  margin-top: 3px;
  line-height: 1.45;
}

/* ---------- 历史 ---------- */
.hist-panel {
  display: flex;
  flex-direction: column;
  padding: 16px;
  border-radius: var(--radius-lg);
  flex: 1;
  min-height: 0;
}

.hist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  flex-shrink: 0;
}

.hist-list {
  overflow-y: auto;
  flex: 1;
  margin: 0 -6px;
}

.hist-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.hist-item:hover {
  background: var(--ink-2);
}

.hist-item.active {
  background: var(--accent-soft);
}

.hist-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--ink-2);
  font-size: 10.5px;
  color: var(--text-secondary);
}

.hist-title {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hist-del {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  flex-shrink: 0;
}

.hist-item:hover .hist-del {
  opacity: 1;
}

.hist-del:hover {
  background: var(--danger-tint);
  color: var(--danger);
}

.hist-empty {
  padding: 12px 10px;
  text-align: center;
}

.icon-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}

/* ---------- 主区 ---------- */
.main {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--gap-md);
  min-height: 0;
}

/* 竖屏下题目区与结果区上下排，结果区占据剩余空间 */
.body.is-portrait .main {
  grid-template-rows: auto minmax(0, 1fr);
}

.editor,
.result {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 14px;
  border-radius: var(--radius-lg);
}

.editor {
  flex-shrink: 0;
}

.editor-head,
.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-sm);
  margin-bottom: 10px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.editor-actions,
.result-actions {
  display: flex;
  align-items: center;
  gap: 6px;
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

.draft-input {
  width: 100%;
  margin-top: 8px;
  padding: 11px 13px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary);
  resize: vertical;
  outline: none;
}

.draft-input::placeholder {
  color: var(--text-tertiary);
}

.draft-input:focus {
  border-color: var(--accent);
  background: var(--surface-3);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.editor-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-sm);
  margin-top: 10px;
}

.model-select-sm {
  max-width: 150px;
  padding: 6px 8px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-family: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  outline: none;
  cursor: pointer;
}

.result-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.result-error {
  margin-top: 8px;
  flex-shrink: 0;
}

.result-stat {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ink-2);
  text-align: right;
  flex-shrink: 0;
}

.vision-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 7px 12px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
  flex-shrink: 0;
  width: fit-content;
}

.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--accent-ring);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--accent);
  border-radius: 2px;
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  to { visibility: hidden; }
}

@media (max-width: 900px) {
  .body {
    grid-template-columns: minmax(0, 1fr);
  }

  .row-2 {
    grid-template-columns: 1fr;
    gap: 0;
  }

  .model-select-sm {
    max-width: 100px;
  }
}
</style>