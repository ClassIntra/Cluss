<template>
  <div class="records-page">
    <AppNav active="records" />

    <main class="body">
      <div class="toolbar glass">
        <Segmented v-model="type" :options="typeOptions" />
        <span class="tiny muted toolbar-note">共 {{ total }} 条记录</span>
        <button class="icon-btn" title="刷新" @click="load(1)">↻</button>
      </div>

      <div v-if="error" class="alert alert-danger">{{ error }}</div>

      <div class="list-wrap glass">
        <div v-if="loading" class="empty-hint">读取中…</div>

        <div v-else-if="!items.length" class="empty-hint">
          <div>还没有{{ type === 'grade' ? '批改' : (type === 'solve' ? '解题' : '') }}记录</div>
          <div class="tiny">去「学习」页拍一张题目试试</div>
          <router-link class="btn btn-sm btn-primary empty-btn" to="/study">去做一道题</router-link>
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
import Segmented from '@/components/Segmented.vue';

export default {
  name: 'RecordsView',
  components: { AppNav, Segmented },
  data: function() {
    return {
      type: 'all',
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
    }
  },
  watch: {
    type: function() { this.load(1); }
  },
  mounted: function() {
    this.load(1);
  },
  methods: {
    load: function(page) {
      var self = this;
      this.loading = true;
      this.error = '';
      this.page = page || 1;

      return this.$http.get('/study/records', {
        params: { type: this.type, page: this.page, limit: 20 }
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
      return String(iso || '').replace('T', ' ').slice(0, 16);
    }
  }
};
</script>

<style scoped>
.records-page {
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
  gap: var(--gap-md);
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.toolbar-note {
  margin-left: auto;
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
}

.icon-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
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

.card:hover {
  border-color: var(--accent-border);
  box-shadow: 0 8px 20px var(--ink-2);
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

.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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

@media (max-width: 700px) {
  .cards {
    grid-template-columns: 1fr;
  }
}
</style>