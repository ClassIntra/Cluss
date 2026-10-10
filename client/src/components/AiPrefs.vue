<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal glass">
      <h3 class="modal-title">AI 人格与记忆</h3>
      <p class="modal-sub tiny muted">
        人格决定日常对话用什么语气说话；记忆是 AI 在聊天里记住的关于你的事，用来让它更懂你。
      </p>

      <div class="tabs">
        <button
          type="button"
          class="tab"
          :class="{ active: tab === 'persona' }"
          @click="tab = 'persona'"
        >人格</button>
        <button
          type="button"
          class="tab"
          :class="{ active: tab === 'memory' }"
          @click="switchToMemory"
        >记忆<span v-if="memories.length" class="tab-count">{{ memories.length }}</span></button>
      </div>

      <div class="form-scroll">
        <!-- ============ 人格 ============ -->
        <template v-if="tab === 'persona'">
          <div class="note tiny muted">
            人格只在「日常」模式生效 —— 学习 / 拍题要的是稳定准确，语气设定不参与解题。
            自定义人格只描述希望的语气，不能改变 AI 的身份与安全底线。
          </div>

          <div class="sec-head">内置人格</div>
          <div class="list">
            <div v-for="p in builtins" :key="p.id" class="row is-static">
              <div class="row-main">
                <div class="row-name">{{ p.label }}</div>
                <div class="row-desc tiny muted">{{ p.desc }}</div>
              </div>
              <span class="tag">内置</span>
            </div>
          </div>

          <div class="sec-head">
            我的人格
            <span class="sec-hint tiny muted">（{{ customs.length }}/{{ limits.max_count }}）</span>
          </div>

          <div v-if="!customs.length" class="empty tiny muted">
            还没有自定义人格。在下面写一个，比如「毒舌学姐」「耐心的学长」。
          </div>

          <div class="list">
            <div v-for="p in customs" :key="p.id" class="row">
              <div class="row-main">
                <div class="row-name">{{ p.name }}</div>
                <div class="row-desc tiny muted">{{ p.prompt }}</div>
              </div>
              <button type="button" class="mini-btn" @click="startEdit(p)">编辑</button>
              <button type="button" class="mini-btn is-danger" @click="removePersona(p)">删除</button>
            </div>
          </div>

          <div class="editor">
            <div class="editor-title">
              {{ editingId ? '编辑人格' : '新建人格' }}
            </div>
            <label class="field">
              <span class="field-label">名字（最多 {{ limits.max_name }} 字）</span>
              <input
                v-model="form.name"
                class="input"
                type="text"
                :maxlength="limits.max_name"
                placeholder="如 毒舌学姐"
              />
            </label>
            <label class="field">
              <span class="field-label">希望它用什么语气说话（最多 {{ limits.max_prompt }} 字）</span>
              <textarea
                v-model="form.prompt"
                class="input"
                rows="3"
                :maxlength="limits.max_prompt"
                placeholder="如：说话直接一点，别绕弯子，可以适度吐槽，但讲知识点要准确。"
              ></textarea>
            </label>

            <div v-if="error" class="alert alert-danger">{{ error }}</div>

            <div class="editor-actions">
              <button v-if="editingId" type="button" class="btn btn-ghost" @click="resetForm">取消编辑</button>
              <button
                type="button"
                class="btn btn-primary"
                :disabled="busy || !canSave"
                @click="savePersona"
              >{{ busy ? '保存中…' : (editingId ? '保存修改' : '新建人格') }}</button>
            </div>
          </div>
        </template>

        <!-- ============ 记忆 ============ -->
        <template v-else>
          <div class="note tiny muted">
            这些是 AI 在和你聊天的过程中自己记下来的，只存在你自己的账号里。
            如果哪条记错了、或者你不想让它记，直接删掉 —— 删了它就真的忘了。
          </div>

          <div v-if="loadingMemories" class="empty tiny muted">读取中…</div>
          <div v-else-if="!memories.length" class="empty tiny muted">
            还没记住什么。多聊一会儿，它会记住你的偏好、习惯和在意的事。
          </div>

          <div v-else class="list">
            <div v-for="m in memories" :key="m.key" class="row">
              <div class="row-main">
                <div class="row-name">{{ m.content }}</div>
                <div class="row-desc tiny muted">{{ m.key }}</div>
              </div>
              <button type="button" class="mini-btn is-danger" @click="removeMemory(m)">忘记</button>
            </div>
          </div>
        </template>
      </div>

      <div class="modal-actions">
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost" @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script>
// 「AI 人格与记忆」弹窗
//
// 为什么把两件事放一个弹窗：
//   它们回答的是同一个问题 ——「AI 眼里的我是什么样、跟我说话什么调」。
//   人格是我主动设的，记忆是它自己记的，学生排查"它为什么这么跟我说话"时
//   需要两样一起看，分成两个入口反而要来回找。
//
// 为什么不做成独立页面：
//   它天然是**对话页**的设置（人格只在日常模式生效），挂在别处就成了
//   "设置在 A 页、生效在 B 页"。做成弹窗后改完就能立刻在对话里验证。
export default {
  name: 'AiPrefs',
  props: {
    // 打开时定在哪个 tab：'persona' | 'memory'
    initialTab: { type: String, default: 'persona' }
  },
  data: function() {
    return {
      tab: this.initialTab === 'memory' ? 'memory' : 'persona',
      personas: [],
      limits: { max_count: 20, max_name: 20, max_prompt: 600 },
      memories: [],
      loadingMemories: false,
      memoriesLoaded: false,
      editingId: '',
      form: { name: '', prompt: '' },
      busy: false,
      error: ''
    };
  },
  computed: {
    builtins: function() {
      return this.personas.filter(function(p) { return p.builtin === 1; });
    },
    customs: function() {
      return this.personas.filter(function(p) { return p.builtin !== 1; });
    },
    canSave: function() {
      return this.form.name.trim().length > 0 && this.form.prompt.trim().length > 0;
    },
    // 到上限时禁掉新建（编辑不受限）
    atLimit: function() {
      return !this.editingId && this.customs.length >= this.limits.max_count;
    },
    // 上限文案固定成一处，供 watcher 比对后自动清除
    limitMessage: function() {
      return '自定义人格最多 ' + this.limits.max_count + ' 个，先删掉一个再新建';
    }
  },
  watch: {
    atLimit: function(v) {
      // 上限提示用了 error 位，切换/删除后要能自动撤掉，否则会一直挂着
      if (!v && this.error === this.limitMessage) this.error = '';
    }
  },
  mounted: function() {
    this.loadPersonas();
  },
  methods: {
    // 打开记忆 tab 时才拉 —— 没点进去就不必多打一次接口
    switchToMemory: function() {
      this.tab = 'memory';
      if (!this.memoriesLoaded && !this.loadingMemories) this.loadMemories();
    },

    loadPersonas: function() {
      var self = this;
      return this.$http.get('/personas').then(function(r) {
        if (r.data.code !== 200) return;
        var d = r.data.data || {};
        self.personas = d.personas || [];
        if (d.limits) self.limits = d.limits;
      }).catch(function() {
        self.error = '人格列表读取失败，请稍后重试';
      });
    },

    loadMemories: function() {
      var self = this;
      this.loadingMemories = true;
      return this.$http.get('/memories', { params: { limit: 100 } }).then(function(r) {
        if (r.data.code !== 200) return;
        self.memories = (r.data.data && r.data.data.items) || [];
        self.memoriesLoaded = true;
      }).catch(function() {
        self.error = '记忆读取失败，请稍后重试';
      }).then(function() {
        self.loadingMemories = false;
      });
    },

    startEdit: function(p) {
      this.editingId = p.id;
      this.form = { name: p.name, prompt: p.prompt };
      this.error = '';
    },

    resetForm: function() {
      this.editingId = '';
      this.form = { name: '', prompt: '' };
      this.error = '';
    },

    // 上限文案要固定一句、供 watcher 比对自动清除
    savePersona: function() {
      var self = this;
      if (!this.canSave || this.busy) return;
      if (this.atLimit) {
        this.error = this.limitMessage;
        return;
      }

      this.busy = true;
      this.error = '';
      var payload = { name: this.form.name.trim(), prompt: this.form.prompt.trim() };
      var req = this.editingId
        ? this.$http.put('/personas/' + this.editingId, payload)
        : this.$http.post('/personas', payload);

      req.then(function(r) {
        if (r.data.code !== 200) {
          self.error = r.data.message || '保存失败';
          return;
        }
        self.$store.dispatch('toast', { message: r.data.message || '已保存', type: 'success' });
        self.resetForm();
        // 保存成功要通知外层刷新人格选择器（新增/改名后列表就变了）
        return self.loadPersonas().then(function() { self.$emit('changed'); });
      }).catch(function(err) {
        // 服务端的校验文案（重名 / 与内置撞名 / 超字数）比一句"保存失败"有用得多
        self.error = (err && err.message) || '保存失败';
      }).then(function() {
        self.busy = false;
      });
    },

    removePersona: function(p) {
      var self = this;
      this.$http.delete('/personas/' + p.id).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
        if (self.editingId === p.id) self.resetForm();
        self.$store.dispatch('toast', { message: '已删除', type: 'success' });
        return self.loadPersonas().then(function() { self.$emit('changed'); });
      }).catch(function(err) {
        self.error = (err && err.message) || '删除失败';
      });
    },

    removeMemory: function(m) {
      var self = this;
      // key 里可能有空格转下划线之外的可读字符，必须编码
      this.$http.delete('/memories/' + encodeURIComponent(m.key)).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
        self.memories = self.memories.filter(function(x) { return x.key !== m.key; });
        self.$store.dispatch('toast', { message: '已忘记', type: 'success' });
      }).catch(function(err) {
        self.error = (err && err.message) || '删除失败';
      });
    }
  }
};
</script>

<style scoped>
.modal-mask {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 350;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--gap-lg);
  background: var(--mask);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.modal {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  padding: 24px;
  border-radius: var(--radius-xl);
}

.modal-title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}

.modal-sub {
  margin: 0 0 var(--gap-md);
  line-height: 1.5;
}

/* ---------- tab ---------- */
.tabs {
  display: flex;
  align-items: center;
  gap: var(--gap-xs);
  margin-bottom: var(--gap-md);
  padding: 4px;
  border-radius: var(--radius-md);
  background: var(--ink-2);
  flex-shrink: 0;
}
html.no-flex-gap .tabs > * + * {
  margin-left: var(--gap-xs);
}

.tab {
  flex: 1;
  padding: 7px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-family: inherit;
  font-size: 13.5px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--transition), color var(--transition);
}

.tab.active {
  background: var(--surface-3);
  color: var(--accent);
  font-weight: 600;
}

@media (hover: hover) {
.tab:not(.active):hover {
  color: var(--text-primary);
}
}

.tab-count {
  display: inline-block;
  min-width: 16px;
  margin-left: 5px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  vertical-align: 1px;
}

/* ---------- 滚动体 ---------- */
.form-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  margin: 0 -6px;
  padding: 0 6px;
}

.note {
  margin-bottom: var(--gap-md);
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  line-height: 1.6;
}

.sec-head {
  margin: var(--gap-md) 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.sec-hint {
  font-weight: 400;
}

.empty {
  padding: 14px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  text-align: center;
  line-height: 1.6;
}

/* ---------- 列表行 ---------- */
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
html.no-flex-gap .list > * + * {
  margin-top: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
}
html.no-flex-gap .row > * + * {
  margin-left: 8px;
}

/* 内置人格是只读展示，压暗一档与"我的人格"区分开 */
.row.is-static {
  opacity: 0.85;
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-name {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.45;
  word-break: break-word;
}

.row-desc {
  margin-top: 2px;
  line-height: 1.45;
  word-break: break-word;
}

.tag {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--ink-2);
  color: var(--text-tertiary);
  font-size: 11px;
}

.mini-btn {
  flex-shrink: 0;
  padding: 5px 11px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-pill);
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  /* 按下即时、松开柔和回落（与全站触屏手感一致） */
  transition: color var(--transition), border-color var(--transition), background var(--transition);
  /* 28px 高在触屏上偏小，而这是人格的「编辑 / 删除」—— 误触代价高。
     命中区向上下扩到 40px，视觉不变（原理见 styles/global.css「触控命中区」）。 */
  position: relative;
}

.mini-btn::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 40px;
  transform: translateY(-50%);
  background: transparent;
  z-index: 1;
}

@media (hover: hover) {
.mini-btn:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
}

@media (hover: hover) {
.mini-btn.is-danger:hover {
  border-color: var(--danger);
  background: var(--danger-tint);
  color: var(--danger);
}
}

/* ---------- 编辑器 ---------- */
.editor {
  margin-top: var(--gap-md);
  padding: 14px;
  border-radius: var(--radius-lg);
  background: var(--ink-1);
}

.editor-title {
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
}

.field {
  display: block;
  margin-bottom: 10px;
}

.field-label {
  display: block;
  margin-bottom: 5px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* textarea 用 .input 的盒子样式，但高度可变、且要能纵向拉伸 */
textarea.input {
  width: 100%;
  resize: vertical;
  line-height: 1.6;
  font-family: inherit;
}

.editor-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}
html.no-flex-gap .editor-actions > * + * {
  margin-left: 10px;
}

/* ---------- 底部 ---------- */
.modal-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: var(--gap-md);
  padding-top: var(--gap-md);
  border-top: 1px solid var(--ink-2);
  flex-shrink: 0;
}
html.no-flex-gap .modal-actions > * + * {
  margin-left: 10px;
}

.spacer {
  flex: 1;
}

@media (max-width: 600px) {
  .modal-mask {
    padding: 0;
    align-items: flex-end;
  }

  .modal {
    max-height: 94vh;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
}
</style>
