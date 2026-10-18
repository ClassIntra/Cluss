<template>
  <div class="records-page">
    <AppNav active="records" />

    <main class="body">
      <!-- 学习画像：一行紧凑摘要，只用已有数据源，不新增接口。
           错题/待复习来自 wrong-book store 的全局概览（AppNav 进场时已刷新），
           对话数来自本页列表接口的 total。取不到的字段直接省略，
           不为凑格式显示「0 道」，也不遮挡/阻塞下面的主列表。 -->
      <div v-if="profileSummary" class="profile-line">{{ profileSummary }}</div>

      <div class="toolbar glass">
        <Segmented v-model="type" :options="typeOptions" />
        <div class="search-box">
          <input
            v-model="query"
            class="input search-input"
            type="search"
            placeholder="搜标题或题目内容…"
            @input="onSearchInput"
          />
          <button v-if="query" class="search-clear" type="button" title="清空" @click="clearSearch">×</button>
        </div>
        <span class="tiny muted toolbar-note">共 {{ total }} 条记录</span>
        <button class="icon-btn" title="刷新" @click="load(1)">↻</button>
      </div>

      <ErrorBanner :message="error" retry @retry="load(page)" />

      <div class="list-wrap glass">
        <div v-if="loading" class="empty-hint">读取中…</div>

        <div v-else-if="!items.length" class="empty-hint">
          <template v-if="query.trim()">
            <div>没有找到匹配的记录</div>
            <div class="tiny">换个关键词试试，比如题目里的一个词</div>
            <button class="btn btn-sm btn-ghost empty-btn" @click="clearSearch">清除搜索</button>
          </template>
          <template v-else>
            <div>还没有{{ type === 'grade' ? '批改' : (type === 'solve' ? '解题' : '') }}记录</div>
            <div class="tiny">去「学习」页拍一张题目试试</div>
            <router-link class="btn btn-sm btn-primary empty-btn" to="/study">去做一道题</router-link>
          </template>
        </div>

        <div v-else class="cards">
          <article
            v-for="r in items"
            :key="r.conversation_id"
            class="card"
            @click="open(r)"
          >
            <div class="card-thumb">
              <img v-if="r.thumb_url" :src="r.thumb_url" :alt="r.title" loading="lazy" />
              <div v-else class="card-thumb-empty">
                <span class="tiny">无题图</span>
              </div>
              <span v-if="r.image_count > 1" class="thumb-count">{{ r.image_count }} 张</span>
            </div>

            <div class="card-body">
              <div class="card-top">
                <span class="badge" :class="r.type === 'grade' ? 'badge-warning' : 'badge-accent'">
                  {{ r.type === 'grade' ? '批改' : '拍题' }}
                </span>
                <span class="tiny muted">{{ formatTime(r.updated_at) }}</span>
              </div>

              <h3 class="card-title">{{ r.title || '未命名' }}</h3>
              <p class="card-summary">{{ r.summary || '（没有文字内容）' }}</p>

              <div class="card-foot">
                <span class="tiny muted">{{ r.model_id }}</span>
                <span class="card-go">查看 →</span>
              </div>
            </div>
          </article>
        </div>

        <div v-if="totalPages > 1" class="pager">
          <button class="btn btn-sm btn-ghost" :disabled="page <= 1" @click="load(page - 1)">上一页</button>
          <span class="tiny muted">{{ page }} / {{ totalPages }}</span>
          <button class="btn btn-sm btn-ghost" :disabled="page >= totalPages" @click="load(page + 1)">下一页</button>
        </div>
      </div>
    </main>
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import Segmented from '@/components/Segmented.vue';

export default {
  name: 'RecordsView',
  components: { AppNav, Segmented, ErrorBanner },
  data: function() {
    return {
      type: 'all',
      query: '',
      items: [],
      total: 0,
      page: 1,
      totalPages: 1,
      loading: false,
      error: ''
    };
  },
  computed: {
    typeOptions: function() {
      return [
        { id: 'all', label: '全部' },
        { id: 'solve', label: '解题' },
        { id: 'grade', label: '批改' }
      ];
    },

    // 一行「学习画像」：只用已有数据源，不新增后端接口。
    //  · 对话次数：本页列表接口返回的 total（每条记录对应一次引导对话）。
    //  · 错题 / 待复习：读 wrong-book store 的全局概览 getter，AppNav 进场时已刷新过它；
    //    拉取失败时 store 会静默降级（loaded 仍为 false），这里据此整段不显示，
    //    而不是把它当成真实的 0。
    // 之所以不加「本周」前缀：现有接口只能按类型/关键词分页，没有周维度的计数，
    // 硬套「本周」等于给一个假口径，宁可只说总量。
    profileSummary: function() {
      var parts = [];
      if (this.total > 0) parts.push('对话 ' + this.total + ' 次');
      if (this.$store.state.wrongBook.loaded) {
        var ov = this.$store.getters['wrongBook/overview'];
        if (ov.total > 0) parts.push('错题 ' + ov.total + ' 道');
        if (ov.due > 0) parts.push('待复习 ' + ov.due + ' 道');
      }
      return parts.length ? parts.join(' · ') : '';
    }
  },
  watch: {
    type: function() {
      // 首次进入时若从本地恢复了筛选，这次变化是「恢复」触发的，
      // 不该再发一次请求 —— 请求统一由 mounted 里的 load(1) 发起（避免进页打两次接口）
      if (this._restoringType) { this._restoringType = false; return; }
      this.saveViewState();
      this.load(1);
    }
  },
  mounted: function() {
    this.restoreViewState();
    this.load(1);
  },
  beforeDestroy: function() {
    clearTimeout(this._searchTimer);
  },
  methods: {
    // 记住上次选的记录类型：切页回来不该又默认成「全部」。
    // 存本地即可——这是「我上次想看什么」，跨设备无意义（同 Chat.vue 的 cluss_persona）。
    restoreViewState: function() {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem('cluss_view_records') || '{}') || {}; } catch (e) { saved = {}; }
      // 只在值合法且与默认不同时才恢复并打闸，否则不触发 watcher（默认值交给 mounted 的 load）
      if ((saved.type === 'solve' || saved.type === 'grade') && saved.type !== this.type) {
        this._restoringType = true;
        this.type = saved.type;
      }
    },

    saveViewState: function() {
      try { localStorage.setItem('cluss_view_records', JSON.stringify({ type: this.type })); } catch (e) { /* 隐私模式下会抛，忽略 */ }
    },

    // 输入防抖 350ms：学生打"二次函数"要按六七个键，
    // 每个键都打一次接口既浪费也会让列表闪个不停
    onSearchInput: function() {
      var self = this;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(function() {
        self.load(1);
      }, 350);
    },

    clearSearch: function() {
      this.query = '';
      clearTimeout(this._searchTimer);
      this.load(1);
    },

    load: function(page) {
      var self = this;
      this.loading = true;
      this.error = '';
      this.page = page || 1;

      return this.$http.get('/study/records', {
        params: {
          type: this.type,
          q: this.query.trim(),
          page: this.page,
          limit: 20
        }
      }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '加载失败');
        self.items = r.data.data.items || [];
        self.total = r.data.data.total || 0;
        self.totalPages = r.data.data.total_pages || 1;
      }).catch(function(err) {
        self.error = err.message || '加载失败';
      }).then(function() {
        self.loading = false;
      });
    },

    // 跳去学习页并直接打开这条记录（学习页会还原当时的题图与解答）
    open: function(r) {
      this.$router.push({ path: '/study', query: { conversation: r.conversation_id } });
    },

    formatTime: function(iso) {
      return this.$fmtLocal(iso);
    }
  }
};
</script>

<style scoped>
.records-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  /* 完全贴边：去掉固定留白，仅保留安全区边距（无刘海设备上为 0） */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  gap: var(--gap-md);
}
html.no-flex-gap .records-page > * + * {
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










/* 学习画像摘要：一条轻量的单行小胶囊。
   用现存令牌上色，竖屏窄到一行放不下时自然换行（数字要能读全，不做省略）。 */
.profile-line {
  flex-shrink: 0;
  padding: 6px 12px;
  border-radius: var(--radius-pill);
  background: var(--ink-1);
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.5;
  word-break: break-word;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  flex-wrap: wrap;
}
html.no-flex-gap .toolbar > * + * {
  margin-left: var(--gap-md);
}










.toolbar-note {
  margin-left: auto;
}

/* 搜索框：flex 布局里占中间弹性空间，窄屏由 flex-wrap 折行 */
.search-box {
  position: relative;
  flex: 1 1 180px;
  max-width: 300px;
  min-width: 150px;
}

.search-input {
  padding: 8px 30px 8px 12px;
  font-size: 13.5px;
  border-radius: var(--radius-pill);
}

/* type=search 的原生清除按钮样式不可控，自己画一个（×）盖在右侧 */
.search-clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

@media (hover: hover) {
.search-clear:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}
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
}

@media (hover: hover) {
.icon-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}
}


.list-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  border-radius: var(--radius-lg);
}

.empty-btn {
  margin-top: 6px;
  text-decoration: none;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--gap-md);
}

.card {
  display: flex;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--surface-1);
  cursor: pointer;
  transition: border-color var(--transition), transform var(--transition), box-shadow var(--transition);
}
html.no-flex-gap .card > * + * {
  margin-left: 12px;
}










@media (hover: hover) {
.card:hover {
  border-color: var(--accent-border);
  box-shadow: 0 8px 20px var(--ink-2);
}
}


.card-thumb {
  position: relative;
  width: 84px;
  height: 84px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  flex-shrink: 0;
  background: var(--ink-1);
}

.card-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.card-thumb-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

.thumb-count {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--mask-strong);
  color: #fff;
  font-size: 10.5px;
}

.card-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
html.no-flex-gap .card-body > * + * {
  margin-top: 4px;
}










.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
html.no-flex-gap .card-top > * + * {
  margin-left: 8px;
}










.card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-summary {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.card-foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
html.no-flex-gap .card-foot > * + * {
  margin-left: 8px;
}










.card-go {
  font-size: 12px;
  color: var(--accent);
  white-space: nowrap;
}

.badge-warning {
  background: var(--warning-soft);
  color: var(--warning-text);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-md);
  margin-top: var(--gap-md);
}
html.no-flex-gap .pager > * + * {
  margin-left: var(--gap-md);
}










@media (max-width: 700px) {
  .cards {
    grid-template-columns: 1fr;
  }
}
</style>