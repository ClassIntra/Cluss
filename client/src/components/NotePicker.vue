<template>
  <div class="picker-mask" @click.self="$emit('close')">
    <div class="picker glass">
      <header class="picker-head">
        <div>
          <h3 class="picker-title">{{ title }}</h3>
          <p class="picker-sub tiny muted">
            已选 {{ selected.length }} / {{ max }} 篇<template v-if="total">（共 {{ total }} 篇）</template>
          </p>
        </div>
        <button class="icon-btn" title="关闭" @click="$emit('close')">×</button>
      </header>

      <!-- 搜索：笔记多了以后靠翻找不现实，标题与标签都要能搜 -->
      <div class="search-row">
        <input
          v-model="search"
          type="text"
          class="search-input"
          placeholder="搜索标题、标签或正文…"
        />
        <button class="icon-btn" title="刷新" @click="load">↻</button>
      </div>

      <div v-if="error" class="alert alert-danger">{{ error }}</div>

      <div class="grid-wrap">
        <div v-if="loading" class="empty-hint">读取中…</div>
        <div v-else-if="!filtered.length" class="empty-hint">
          <div>{{ search ? '无匹配笔记' : '还没有笔记' }}</div>
          <div class="tiny">去「笔记」页写一篇，就能在这里引用</div>
        </div>

        <div v-else class="note-grid">
          <button
            v-for="n in filtered"
            :key="n.id"
            type="button"
            class="note-cell"
            :class="{ 'is-selected': selected.indexOf(n.id) !== -1 }"
            @click="toggle(n)"
          >
            <span class="note-cell-check" v-if="selected.indexOf(n.id) !== -1">✓</span>
            <span class="note-cell-title">{{ n.title || '未命名笔记' }}</span>
            <span class="note-cell-date tiny muted">{{ formatDate(n.updated_at) }}</span>
            <span v-if="n.tags && n.tags.length" class="note-cell-tags">
              <span v-for="t in n.tags.slice(0, 3)" :key="t" class="note-tag">{{ t }}</span>
            </span>
          </button>
        </div>
      </div>

      <footer class="picker-foot">
        <span class="tiny muted">被引用的笔记会作为上下文一起发给 AI</span>
        <div class="foot-actions">
          <button class="btn btn-sm btn-ghost" @click="clearSelection">清空</button>
          <button class="btn btn-sm btn-primary" @click="confirm" :disabled="!selected.length">确定</button>
        </div>
      </footer>
    </div>
  </div>
</template>

<script>
// 笔记选择器：从云笔记里挑几篇作为上下文
//
// 与 CloudPicker 刻意分成两个组件：
//   云盘选的是"文件"（按 hash），笔记选的是"笔记"（按 id，带标题与标签）。
//   语义不同、数据源不同、展示也不同（笔记没有缩略图，标题才是关键信息）。

import modalEsc from '@/mixins/modal-esc';

export default {
  name: 'NotePicker',
  // Esc 关闭（组件由 v-if 控制，存在即打开，见 mixin 说明）
  mixins: [modalEsc],
  props: {
    max: { type: Number, default: 5 },
    title: { type: String, default: '引用笔记' },
    // 已选中的笔记 id，打开时用于回显
    value: { type: Array, default: function() { return []; } }
  },
  data: function() {
    return {
      notes: [],
      loading: false,
      error: '',
      search: '',
      // 正文搜索命中（服务端 /notes/search 返回）：标题与标签在本地即时匹配，
      // 正文只有服务端知道（列表接口刻意不回正文），见 Notes 页同一套逻辑。
      searchHits: [],
      selected: []
    };
  },
  computed: {
    total: function() {
      return this.notes.length;
    },
    filtered: function() {
      var self = this;
      var q = this.search.trim().toLowerCase();
      if (!q) return this.notes;
      return this.notes.filter(function(n) {
        var title = String(n.title || '').toLowerCase();
        var tags = (n.tags || []).join(' ').toLowerCase();
        if (title.indexOf(q) >= 0 || tags.indexOf(q) >= 0) return true;
        return self.searchHits.indexOf(n.id) >= 0;
      });
    }
  },
  watch: {
    search: function() {
      this.scheduleSearch();
    }
  },
  mounted: function() {
    this.selected = (this.value || []).slice();
    this.load();
  },
  beforeDestroy: function() {
    clearTimeout(this._searchTimer);
  },
  methods: {
    // 正文搜索：防抖 250ms + 序号防乱序（先发的请求晚回来不能覆盖后发的结果）
    scheduleSearch: function() {
      var self = this;
      clearTimeout(this._searchTimer);
      var q = this.search.trim();
      if (!q) { this.searchHits = []; return; }
      this._searchTimer = setTimeout(function() {
        // 自增前先兜底初始化：_searchSeq 首次是 undefined，
        // ++undefined 得到 NaN，而 NaN !== NaN 恒真 —— 会把所有结果误判成"过期"
        var seq = (self._searchSeq = (self._searchSeq || 0) + 1);
        self.$http.get('/notes/search', { params: { q: q } }).then(function(r) {
          if (seq !== self._searchSeq) return;
          if (r.data.code === 200) {
            var hits = (r.data.data && r.data.data.hits) || [];
            self.searchHits = hits.map(function(h) { return h.id; });
          }
        }).catch(function() {
          if (seq !== self._searchSeq) return;
          self.searchHits = []; // 搜索失败不打断本地标题/标签匹配
        });
      }, 250);
    },

    load: function() {
      var self = this;
      this.loading = true;
      this.error = '';
      return this.$http.get('/notes').then(function(r) {
        if (r.data.code === 200) self.notes = r.data.data.items || [];
      }).catch(function(err) {
        self.error = err.message || '读取笔记失败';
      }).then(function() {
        self.loading = false;
      });
    },

    toggle: function(n) {
      var idx = this.selected.indexOf(n.id);
      if (idx !== -1) {
        this.selected.splice(idx, 1);
        return;
      }
      if (this.selected.length >= this.max) {
        this.$store.dispatch('toast', { message: '最多引用 ' + this.max + ' 篇笔记', type: 'error' });
        return;
      }
      this.selected.push(n.id);
    },

    clearSelection: function() {
      this.selected = [];
    },

    confirm: function() {
      // 回传完整笔记对象（父组件要展示标题），不必再查一次
      var map = {};
      this.notes.forEach(function(n) { map[n.id] = n; });
      var picked = this.selected.map(function(id) { return map[id]; }).filter(Boolean);
      this.$emit('picked', picked);
      this.$emit('close');
    },

    formatDate: function(iso) {
      return this.$fmtLocal(iso);
    }
  }
};
</script>

<style scoped>
.picker-mask {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
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
  max-width: 620px;
  max-height: min(680px, 90vh);
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
html.no-flex-gap .picker-head > * + * {
  margin-left: var(--gap-md);
}






.picker-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.picker-sub {
  margin: 2px 0 0;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: var(--gap-sm);
}
html.no-flex-gap .search-row > * + * {
  margin-left: 8px;
}






.search-input {
  flex: 1;
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  font-family: inherit;
  font-size: 13px;
  color: var(--text-primary);
  outline: none;
}

.search-input::placeholder {
  color: var(--text-tertiary);
}

.search-input:focus {
  border-color: var(--accent);
  background: var(--surface-3);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.icon-btn {
  width: clamp(28px, 19.36px + 0.9vw, 42px);
  height: clamp(28px, 19.36px + 0.9vw, 42px);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-tertiary);
  font-size: clamp(16px, 13.12px + 0.3vw, 21px);
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

@media (hover: hover) {
.icon-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}
}

.grid-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 120px;
  margin: 0 -4px;
  padding: 0 4px;
}

/* 笔记没有缩略图，用单列列表而非网格 —— 标题才是要读的信息 */
.note-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
html.no-flex-gap .note-grid > * + * {
  margin-top: 8px;
}






.note-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  cursor: pointer;
  overflow: hidden;
  font-family: inherit;
  text-align: left;
  transition: border-color var(--transition), box-shadow var(--transition);
}
html.no-flex-gap .note-cell > * + * {
  margin-top: 3px;
}






@media (hover: hover) {
.note-cell:hover {
  border-color: var(--accent-border-strong);
}
}

.note-cell.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.note-cell-check {
  position: absolute;
  top: 8px;
  right: 8px;
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

.note-cell-title {
  padding-right: 26px;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-cell-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
html.no-flex-gap .note-cell-tags > * + * {
  margin-left: 4px;
}






.note-tag {
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--ink-2);
  font-size: 10px;
  color: var(--text-tertiary);
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
html.no-flex-gap .picker-foot > * + * {
  margin-left: var(--gap-md);
}






.foot-actions {
  display: flex;
  gap: 8px;
}
html.no-flex-gap .foot-actions > * + * {
  margin-left: 8px;
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
