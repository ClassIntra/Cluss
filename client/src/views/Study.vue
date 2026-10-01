<template>
  <div class="study-page">
    <AppNav active="study" :show-menu-button="isPortrait" @toggle-sidebar="drawerOpen = !drawerOpen" />

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
          <div class="mode-card glass">
            <span class="section-label">学习模式</span>
            <Segmented v-model="taskKind" :options="taskOptions" />

            <p class="task-hint tiny muted">{{ taskHint }}</p>

            <!-- 拍题才有题量选择 -->
            <template v-if="taskKind === 'solve'">
              <span class="section-label">题目数量</span>
              <Segmented v-model="paperMode" :options="paperModeOptions" />
              <p class="task-hint tiny muted">{{ paperHint }}</p>
            </template>

            <div v-if="!capability.available" class="alert alert-warning task-alert">
              {{ capability.reason || '当前没有可看图的模型，请联系管理员配置' }}
            </div>
          </div>

          <div class="hist-panel glass">
            <div class="hist-head">
              <span class="section-label">历史记录</span>
              <button class="icon-btn" title="刷新" @click="loadConversations">↻</button>
            </div>
            <div class="hist-list">
              <div v-if="!conversations.length" class="tiny muted hist-empty">还没有记录</div>
              <div
                v-for="c in conversations"
                :key="c.id"
                class="hist-item"
                :class="{ active: c.id === conversationId }"
                @click="openConversation(c.id)"
              >
                <span class="hist-title">{{ c.title }}</span>
                <button class="hist-del" title="删除" @click.stop="removeConversation(c.id)">×</button>
              </div>
            </div>
          </div>
        </aside>
      </transition>

      <main class="main">
        <!-- 双栏：横屏左图右解，竖屏上下 -->
        <div class="split-pane pane-wrap">
          <!-- 图片区 -->
          <section class="pane glass">
            <div class="pane-head">
              <span class="section-label">{{ taskKind === 'grade' ? '作答图片' : '题目图片' }}</span>
              <div class="pane-actions">
                <button class="btn btn-sm btn-ghost" @click="pickerOpen = true">
                  {{ attachments.length ? '重新选择' : '选择图片' }}
                </button>
              </div>
            </div>

            <div class="pane-body">
              <div v-if="!attachments.length" class="empty-hint">
                <div>{{ taskKind === 'grade' ? '上传学生写好的作答照片' : '选择题目照片' }}</div>
                <div class="tiny">从云盘选择，或直接上传新照片</div>
                <button class="btn btn-sm btn-primary" @click="pickerOpen = true">去选择</button>
              </div>

              <div v-else class="img-list">
                <div v-for="(a, idx) in attachments" :key="a.hash" class="img-card">
                  <span class="img-index">{{ idx + 1 }}</span>
                  <img class="img-preview" :src="a.url || ('/api/cloud/files/' + a.hash)" :alt="a.name" />
                  <span class="img-name tiny">{{ a.name }}</span>
                  <button class="img-remove" title="移除" @click="removeAttachment(a.hash)">×</button>
                </div>
              </div>
            </div>

            <div v-if="attachments.length" class="pane-foot">
              <span v-if="paperMode === 'cross_page'" class="badge badge-accent">请确认顺序：图 1 → 图 {{ attachments.length }}</span>
              <span v-else class="tiny muted">共 {{ attachments.length }} 张</span>
            </div>
          </section>

          <!-- 解答区 -->
          <section class="pane glass">
            <div class="pane-head">
              <span class="section-label">{{ taskKind === 'grade' ? '批改结果' : '解答' }}</span>
              <div class="pane-actions">
                <select v-model="modelId" class="model-select-sm" :disabled="sending">
                  <option
                    v-for="m in visionModels"
                    :key="m.id"
                    :value="m.id"
                    :disabled="!m.available"
                  >{{ m.label }}{{ m.vision_via_relay ? '（转述）' : '' }}</option>
                </select>
              </div>
            </div>

            <div ref="scroller" class="pane-body answer-body">
              <div v-if="!answer" class="empty-hint">
                <div class="tiny">{{ taskHint }}</div>
              </div>
              <div v-else class="md-body" v-html="render(answer)"></div>
              <span v-if="sending" class="caret"></span>
            </div>

            <div v-if="visionStatus" class="vision-status">
              <span class="spinner"></span>
              <span>{{ visionStatus }}</span>
            </div>

            <div v-if="streamError" class="alert alert-danger pane-error">{{ streamError }}</div>

            <div class="pane-foot pane-foot-action">
              <textarea
                v-model="note"
                class="note-input"
                rows="1"
                :placeholder="taskKind === 'grade' ? '补充说明（选填），如：这是第 3 次作业' : '补充说明（选填），如：只讲第 2 问'"
              ></textarea>
              <button class="btn btn-primary" :disabled="!canSend" @click="start">
                {{ sending ? '处理中…' : (taskKind === 'grade' ? '开始批改' : '开始解答') }}
              </button>
            </div>
          </section>
        </div>
      </main>
    </div>

    <CloudPicker
      v-if="pickerOpen"
      images-only
      :max="capability.max_images || 4"
      :title="taskKind === 'grade' ? '选择作答图片' : '选择题目图片'"
      :hint="pickerHint"
      :value="attachmentHashes"
      @picked="onPicked"
      @close="pickerOpen = false"
    />
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import Segmented from '@/components/Segmented.vue';
import CloudPicker from '@/components/CloudPicker.vue';
import { renderMarkdown } from '@/utils/markdown';
import { readSseStream, postStream } from '@/utils/sse';

export default {
  name: 'StudyView',
  components: { AppNav, Segmented, CloudPicker },
  data: function() {
    return {
      taskKind: 'solve',
      paperMode: 'single',
      attachments: [],
      answer: '',
      note: '',
      sending: false,
      streamError: '',
      visionStatus: '',
      conversationId: '',
      conversations: [],
      models: [],
      modelId: '',
      capability: { available: false, max_images: 4, vision_models: [] },
      pickerOpen: false,
      drawerOpen: false,
      isPortrait: false
    };
  },
  computed: {
    taskOptions: function() {
      return [
        { id: 'solve', label: '拍题解答', hint: '拍照上传题目，AI 给出讲解' },
        { id: 'grade', label: '作业批改', hint: '上传作答照片，AI 逐题批改' }
      ];
    },
    paperModeOptions: function() {
      return (this.capability.paper_modes || []).map(function(m) {
        return { id: m.id, label: m.label, hint: m.hint };
      });
    },
    taskHint: function() {
      if (this.taskKind === 'grade') return '上传学生写好的作答照片，AI 会逐题判定对错并指出错因';
      return '上传题目照片，AI 会先点明考点再分步讲解';
    },
    paperHint: function() {
      var found = (this.capability.paper_modes || []).filter(function(m) { return m.id === this.paperMode; }, this);
      return found.length ? found[0].hint : '';
    },
    pickerHint: function() {
      var max = this.capability.max_images || 4;
      if (this.paperMode === 'cross_page') return '多张图是同一道题的连续部分，请按顺序选择（第 1 张在前）';
      if (this.paperMode === 'multi') return '图中包含多道题，最多选 ' + max + ' 张';
      return '最多选择 ' + max + ' 张';
    },
    visionModels: function() {
      // 只列出「能看图」的模型：不支持视觉且无转述模型的模型在这里没有意义
      var models = this.models || [];
      var capable = models.filter(function(m) { return m.vision_available; });
      return capable.length ? capable : models;
    },
    attachmentHashes: function() {
      return this.attachments.map(function(a) { return a.hash; });
    },
    canSend: function() {
      if (this.sending) return false;
      if (!this.attachments.length) return false;
      if (this.taskKind === 'solve' && this.paperMode === 'cross_page' && this.attachments.length < 2) {
        // 跨页题只有一张图时后端会降级，这里不拦，只是不提示
      }
      return true;
    }
  },
  mounted: function() {
    this.checkOrientation();
    window.addEventListener('resize', this.checkOrientation);
    window.addEventListener('orientationchange', this.checkOrientation);

    this.$store.dispatch('auth/fetchWallet').catch(function() {});
    this.loadCapability();
    this.loadModels();
    this.loadConversations();
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

    loadCapability: function() {
      var self = this;
      return this.$http.get('/study/capabilities').then(function(r) {
        if (r.data.code !== 200) return;
        self.capability = r.data.data;
        // 有指定模型就用它，否则挑第一个能看图的
        if (!self.modelId && self.capability.vision_models && self.capability.vision_models.length) {
          self.modelId = self.capability.vision_models[0].id;
        }
      }).catch(function() {});
    },

    loadModels: function() {
      var self = this;
      return this.$http.get('/models').then(function(r) {
        if (r.data.code !== 200) return;
        self.models = r.data.data.models || [];
        if (!self.modelId) self.modelId = r.data.data.default_model || '';
      }).catch(function() {});
    },

    loadConversations: function() {
      var self = this;
      return this.$http.get('/study/conversations', { params: { limit: 50 } }).then(function(r) {
        if (r.data.code !== 200) return;
        self.conversations = r.data.data.conversations || [];
      }).catch(function() {});
    },

    openConversation: function(id) {
      var self = this;
      return this.$http.get('/conversations/' + id).then(function(r) {
        if (r.data.code !== 200) return;
        var msgs = r.data.data.messages || [];
        self.conversationId = id;
        self.answer = '';
        // 取最后一条助手回复作为解答内容
        for (var i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') { self.answer = msgs[i].content; break; }
        }
        // 还原当时的题图
        self.attachments = [];
        for (var j = 0; j < msgs.length; j++) {
          if (msgs[j].role === 'user' && msgs[j].attachments && msgs[j].attachments.length) {
            self.attachments = msgs[j].attachments.map(function(a) {
              return {
                hash: a.hash, name: a.name, size: a.size, kind: a.kind,
                url: '/api/cloud/files/' + a.hash,
                thumb_url: '/api/cloud/files/' + a.hash + '?thumb=1'
              };
            });
            break;
          }
        }
        if (r.data.data.conversation && r.data.data.conversation.model_id) {
          self.modelId = r.data.data.conversation.model_id;
        }
        self.streamError = '';
        self.drawerOpen = false;
        self.$nextTick(function() { self.scrollAnswer(); });
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '打开失败', type: 'error' });
      });
    },

    removeConversation: function(id) {
      var self = this;
      this.$http.delete('/conversations/' + id).then(function(r) {
        if (r.data.code !== 200) return;
        self.conversations = self.conversations.filter(function(c) { return c.id !== id; });
        if (self.conversationId === id) {
          self.conversationId = '';
          self.answer = '';
        }
      }).catch(function() {});
    },

    onPicked: function(files) {
      var self = this;
      this.attachments = files.slice(0, this.capability.max_images || 4).map(function(f) {
        return {
          hash: f.hash, name: f.name, size: f.size, kind: 'image',
          url: f.url || ('/api/cloud/files/' + f.hash),
          thumb_url: f.thumb_url || ('/api/cloud/files/' + f.hash + '?thumb=1')
        };
      });
      // 换图即视为新的一次任务
      this.answer = '';
      this.streamError = '';
      void self;
    },

    removeAttachment: function(hash) {
      this.attachments = this.attachments.filter(function(a) { return a.hash !== hash; });
      this.answer = '';
    },

    scrollAnswer: function() {
      var self = this;
      this.$nextTick(function() {
        var el = self.$refs.scroller;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    start: function() {
      var self = this;
      if (!this.canSend) return;

      this.answer = '';
      this.streamError = '';
      this.visionStatus = '';
      this.sending = true;

      var controller = new AbortController();
      this._abort = controller;

      var isGrade = this.taskKind === 'grade';
      var url = isGrade ? '/api/study/grade/stream' : '/api/study/solve/stream';
      var body = isGrade
        ? {
          conversation_id: this.conversationId || '',
          model_id: this.modelId || '',
          answer_hashes: this.attachmentHashes,
          content: this.note.trim()
        }
        : {
          conversation_id: this.conversationId || '',
          model_id: this.modelId || '',
          paper_mode: this.paperMode,
          image_hashes: this.attachmentHashes,
          content: this.note.trim()
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
            self.answer += text;
            self.scrollAnswer();
          },
          onDone: function() {
            self.visionStatus = '';
            self.$store.dispatch('auth/fetchWallet').catch(function() {});
            self.loadConversations();
          },
          onError: function(message) {
            self.visionStatus = '';
            self.streamError = message || '处理失败，请重试';
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
        if (!self.answer && !self.streamError) {
          self.streamError = '未收到内容，请重试';
        }
      });
    }
  }
};
</script>

<style scoped>
.study-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  padding: var(--gap-md);
  gap: var(--gap-md);
}

.body {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
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

/* ---------- 模式卡 ---------- */
.mode-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.mode-card .section-label:not(:first-child) {
  margin-top: 6px;
}

.task-hint {
  margin: 0;
  line-height: 1.5;
}

.task-alert {
  margin-top: 6px;
  font-size: 12.5px;
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
  background: var(--ink-1);
}

.hist-item.active {
  background: var(--accent-soft);
}

.hist-title {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hist-item.active .hist-title {
  color: var(--accent);
  font-weight: 500;
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

/* ---------- 双栏 ---------- */
.main {
  min-height: 0;
  display: flex;
}

.pane-wrap {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 14px;
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-sm);
  margin-bottom: 10px;
  flex-shrink: 0;
}

.pane-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.pane-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.answer-body {
  padding-right: 2px;
}

.pane-foot {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--ink-2);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pane-foot-action {
  align-items: flex-end;
}

.pane-error {
  margin-top: 0;
  margin-bottom: 8px;
  flex-shrink: 0;
}

.model-select-sm {
  max-width: 160px;
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

/* ---------- 图片列表 ---------- */
.img-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.img-card {
  position: relative;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--ink-1);
  border: 1px solid var(--glass-border);
}

.img-preview {
  width: 100%;
  max-height: 42vh;
  object-fit: contain;
  display: block;
  background: var(--ink-1);
}

.img-index {
  position: absolute;
  top: 6px;
  left: 6px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--text-invert);
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.img-name {
  display: block;
  padding: 5px 8px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.img-remove {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: var(--mask-strong);
  color: var(--text-invert);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.img-remove:hover {
  background: var(--danger);
}

/* ---------- 补充说明输入 ---------- */
.note-input {
  flex: 1;
  min-height: 38px;
  max-height: 80px;
  padding: 9px 12px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  font-family: inherit;
  font-size: 13px;
  color: var(--text-primary);
  resize: none;
  outline: none;
}

.note-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* ---------- 视觉进度 ---------- */
.vision-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
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

  .model-select-sm {
    max-width: 110px;
  }
}
</style>