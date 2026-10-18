<template>
  <div class="wrong-page">
    <AppNav active="wrong-book" />

    <main class="body">
      <!-- 统计 + 工具 -->
      <div class="toolbar glass">
        <Segmented v-model="masteredFilter" :options="filterOptions" />
        <select v-if="subjects.length" v-model="subject" class="input subject-select">
          <option value="">全部学科</option>
          <option v-for="s in subjects" :key="s.subject" :value="s.subject">
            {{ s.subject }}（{{ s.count }}）
          </option>
        </select>
        <div class="toolbar-right">
          <!-- 复习模式自带"先想再看"，此时再给一个自测开关只会互相打岔 -->
          <button
            v-if="!reviewMode"
            class="btn btn-sm"
            :class="quizMode ? 'btn-primary' : 'btn-ghost'"
            title="先自己想，再点开核对答案与错因"
            @click="toggleQuiz"
          >{{ quizMode ? '退出自测' : '自测模式' }}</button>
          <button class="btn btn-sm btn-ghost" @click="exportCsv">导出 CSV</button>
          <button class="btn btn-sm btn-ghost" @click="load(1)">刷新</button>
          <button class="btn btn-sm btn-primary" :disabled="reviewMode" @click="openCreate">手动添加</button>
        </div>
      </div>

      <!-- ---- 今日复习卡片 ----
           做成"卡片 + 角标"而不是弹窗：错题复习不是紧急事项，
           弹窗会打断学生正在做的题，而且弹窗只有"立即处理"和"关闭"两种回答，
           等于逼他现在做。卡片一直在那儿，但从不挡路。 -->
      <div v-if="reviewMode && items.length" class="review-card glass is-active">
        <div class="review-main">
          <div class="review-title">
            复习中
            <span class="tiny muted">还剩 {{ items.length }} 道</span>
          </div>
          <div class="tiny muted review-sub">
            先自己想，再点「看答案」核对；答完顺手点「记住了」或「忘了」，
            系统据此安排下次什么时候再见到它。
          </div>
        </div>
        <div class="review-actions">
          <button class="btn btn-sm btn-ghost" @click="exitReview">退出复习</button>
        </div>
      </div>

      <!-- 复习做完了：必须给个交代。
           走到这里说明一轮结束了，学生需要知道"练了几道、它们去哪了、
           还有没有别的事"，否则他会停在空列表前，分不清是结束了还是加载失败。 -->
      <div v-else-if="justFinished" class="review-card glass is-done">
        <div class="review-main">
          <div class="review-title">今天的复习做完了</div>
          <div class="tiny muted review-sub">
            刚练过 {{ justFinished }} 道，它们已按你的表现排到后面的日期。
            <span v-if="counts.graduated > 0">
              另有 {{ counts.graduated }} 道走完了整个复习阶梯，觉得稳了就标记已掌握。
            </span>
          </div>
        </div>
        <div class="review-actions">
          <button class="btn btn-sm btn-ghost" @click="justFinished = 0">知道了</button>
        </div>
      </div>

      <div v-else-if="counts.due > 0" class="review-card glass">
        <div class="review-main">
          <div class="review-title">
            今天有 {{ counts.due }} 道错题该复习了
          </div>
          <div class="tiny muted review-sub">
            按 1 / 3 / 7 / 15 / 30 天的间隔安排。一次过一遍就好，不用做完整张卷子。
            <span class="review-free">复习不花积分</span>
          </div>
        </div>
        <div class="review-actions">
          <button class="btn btn-sm btn-ghost" :disabled="snoozing" @click="snoozeToday">
            {{ snoozing ? '处理中…' : '今天先不复习' }}
          </button>
          <button class="btn btn-sm btn-primary" @click="startReview">开始复习</button>
        </div>
      </div>

      <!-- 走完阶梯的轻提示：不催，只是告诉他"这里有个可以收尾的事" -->
      <div v-else-if="counts.graduated > 0" class="review-card glass is-done">
        <div class="review-main">
          <div class="review-title">有 {{ counts.graduated }} 道走完了复习阶梯</div>
          <div class="tiny muted review-sub">
            它们已经连续答对了好几轮。觉得稳了就标记已掌握，想再巩固就留着。
          </div>
        </div>
      </div>

      <!-- 自测进行中的提示：一句话说清玩法，不占常驻空间 -->
      <div v-if="quizMode" class="alert alert-info quiz-hint">
        自测中：题干下面先不给答案，想好了再点「看答案」。做完一条就顺手标记掌握与否。
      </div>

      <!-- 计数条 -->
      <div class="stat-row">
        <div class="stat glass">
          <span class="stat-num">{{ counts.pending }}</span>
          <span class="stat-label">待复习</span>
        </div>
        <div class="stat glass">
          <span class="stat-num">{{ counts.mastered }}</span>
          <span class="stat-label">已掌握</span>
        </div>
        <div class="stat glass">
          <span class="stat-num">{{ counts.total }}</span>
          <span class="stat-label">共收录</span>
        </div>

        <div v-if="selected.length" class="bulk glass">
          <span class="tiny">已选 {{ selected.length }} 条</span>
          <button class="btn btn-sm btn-ghost" @click="bulk('master')">标记已掌握</button>
          <button class="btn btn-sm btn-ghost" @click="bulk('unmaster')">标回待复习</button>
          <button class="btn btn-sm btn-ghost danger-text" @click="bulk('delete')">删除</button>
        </div>
      </div>

      <ErrorBanner :message="error" retry @retry="load(page)" />

      <!-- 列表 -->
      <div class="list-wrap glass">
        <div v-if="loading" class="empty-hint">读取中…</div>

        <div v-else-if="!items.length" class="empty-hint">
          <template v-if="reviewMode">
            <div>今天到期的都过完了</div>
            <div class="tiny">
              它们已经按你的表现排到后面的日期，明天或几天后才会再出现
            </div>
          </template>
          <template v-else>
            <div>{{ masteredFilter === '1' ? '还没有已掌握的错题' : '错题本是空的' }}</div>
            <div class="tiny">
              批改作业时，错题会自动收进来；也可以点右上角「手动添加」
            </div>
          </template>
        </div>

        <div v-else class="items">
          <article v-for="q in items" :key="q.id" class="item" :class="{ 'is-mastered': q.mastered }">
            <label class="item-check">
              <input type="checkbox" :value="q.id" v-model="selected" />
            </label>

            <div class="item-main">
              <div class="item-top">
                <span v-if="q.subject" class="badge badge-accent">{{ q.subject }}</span>
                <span class="badge" :class="q.tag === '△' ? 'badge-warning' : 'badge-danger'">{{ q.tag }}</span>
                <span class="badge">{{ q.source === 'ai' ? 'AI 提取' : '手动录入' }}</span>
                <span v-if="q.mastered" class="badge badge-success">已掌握</span>
                <!-- 复习排期：到期的用醒目色，未到期的直接说"3 天后"。
                     学生最需要知道的就是"这道题什么时候再见到" -->
                <span
                  v-else-if="q.review_hint"
                  class="badge"
                  :class="q.due ? 'badge-warning' : ''"
                >{{ q.due ? '该复习了' : q.review_hint }}</span>
                <span v-if="q.review_count > 0" class="badge">练过 {{ q.review_count }} 次</span>
                <span class="tiny muted item-time">{{ formatTime(q.created_at) }}</span>
              </div>

              <div class="item-row">
                <span class="row-label">题干</span>
                <div class="row-text md-body" v-html="render(q.question)"></div>
              </div>

              <div v-if="q.student_answer" class="item-row">
                <span class="row-label">我的答案</span>
                <div class="row-text md-body" v-html="render(q.student_answer)"></div>
              </div>

              <!-- 自测模式下这三块是"要背对答案想"的部分，先藏住；
                   我的笔记常写着答案要点，一起藏，避免漏题 -->
              <template v-if="!quizMode || revealed[q.id]">
                <div v-if="q.correct_answer" class="item-row">
                  <span class="row-label">正确解法</span>
                  <div class="row-text md-body" v-html="render(q.correct_answer)"></div>
                </div>

                <div v-if="q.reason" class="item-row">
                  <span class="row-label">错因</span>
                  <div class="row-text reason md-body" v-html="render(q.reason)"></div>
                </div>

                <div v-if="q.note" class="item-row">
                  <span class="row-label">我的笔记</span>
                  <div class="row-text md-body" v-html="render(q.note)"></div>
                </div>
              </template>
              <div v-else-if="quizHasAnswer(q)" class="item-row">
                <button class="btn btn-sm btn-primary quiz-reveal" @click="reveal(q.id)">
                  想好了，看答案与错因
                </button>
              </div>

              <div v-if="q.image_hash" class="item-image">
                <img :src="q.image_url" alt="来源题图" loading="lazy" @click="preview = q.image_url" />
                <span class="tiny muted">来源题图</span>
              </div>

              <!-- 复习模式下换成"记住了 / 忘了"：这两个按钮就是复习的产出，
                   它们决定这道题下次什么时候再来。其余管理动作（编辑/删除）
                   在复习时只会分散注意力，先收起来。 -->
              <div v-if="reviewMode" class="item-actions">
                <button class="btn btn-sm btn-ghost" @click="reviewOne(q, 'again')">忘了，明天再练</button>
                <button class="btn btn-sm btn-primary" @click="reviewOne(q, 'good')">记住了</button>
              </div>

              <div v-else class="item-actions">
                <button class="btn btn-sm btn-ghost" @click="toggleMastered(q)">
                  {{ q.mastered ? '标回待复习' : '标记已掌握' }}
                </button>
                <button class="btn btn-sm btn-ghost" @click="openEdit(q)">编辑</button>
                <button class="btn btn-sm btn-ghost danger-text" @click="remove(q)">删除</button>
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

    <!-- 编辑 / 新增弹窗 -->
    <transition name="fade">
      <div v-if="modal.open" class="modal-mask" @click.self="modal.open = false">
        <div class="modal glass">
          <h3 class="modal-title">{{ modal.id ? '编辑错题' : '手动添加错题' }}</h3>
          <p class="modal-sub tiny muted">
            AI 提取的题目难免有识别误差，请核对后修正
          </p>

          <div class="form-scroll">
            <div class="row-2">
              <label class="field">
                <span class="field-label">学科</span>
                <input v-model="modal.subject" class="input" type="text" placeholder="如 数学" maxlength="20" />
              </label>
              <label class="field">
                <span class="field-label">判定</span>
                <select v-model="modal.tag" class="input">
                  <option value="✗">✗ 完全错</option>
                  <option value="△">△ 部分对</option>
                </select>
              </label>
            </div>

            <label class="field">
              <span class="field-label">题干（必填）</span>
              <textarea v-model="modal.question" class="input textarea" rows="3" placeholder="把题目抄下来"></textarea>
            </label>

            <label class="field">
              <span class="field-label">我当时的答案</span>
              <textarea v-model="modal.student_answer" class="input textarea" rows="2"></textarea>
            </label>

            <label class="field">
              <span class="field-label">正确解法</span>
              <textarea v-model="modal.correct_answer" class="input textarea" rows="3"></textarea>
            </label>

            <label class="field">
              <span class="field-label">错因</span>
              <textarea v-model="modal.reason" class="input textarea" rows="2" placeholder="错在哪个概念或哪一步"></textarea>
            </label>

            <label class="field">
              <span class="field-label">我的笔记</span>
              <textarea v-model="modal.note" class="input textarea" rows="2" placeholder="下次遇到这类题要注意什么"></textarea>
            </label>

            <label class="switch-row">
              <input type="checkbox" v-model="modal.mastered" />
              <span>已掌握</span>
            </label>

            <div v-if="modal.error" class="alert alert-danger">{{ modal.error }}</div>
          </div>

          <div class="modal-actions">
            <button class="btn btn-ghost" @click="modal.open = false">取消</button>
            <button class="btn btn-primary" :disabled="modal.saving" @click="save">
              {{ modal.saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </transition>

    <!-- 题图预览 -->
    <transition name="fade">
      <div v-if="preview" class="preview-mask" @click.self="preview = ''">
        <img class="preview-img" :src="preview" alt="题图" />
      </div>
    </transition>
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import Segmented from '@/components/Segmented.vue';
import { renderMarkdown, ensureKatexIdle, onKatexReady } from '@/utils/markdown';
import mermaidCharts from '@/mixins/mermaid';

export default {
  name: 'WrongBookView',
  components: { AppNav, Segmented, ErrorBanner },
  mixins: [mermaidCharts],
  data: function() {
    return {
      masteredFilter: '0',
      subject: '',
      items: [],
      subjects: [],
      counts: { pending: 0, mastered: 0, due: 0, graduated: 0, total: 0 },
      selected: [],
      // 自测模式：藏起正确解法 / 错因 / 笔记，学生先想再看。
      // revealed 记录本页哪些条目已翻开；翻页或改筛选时清空
      quizMode: false,
      revealed: {},
      // 复习模式：只看今天到期的题，且强制开着自测（先想再看）。
      // 它是一个"一轮做完"的流程，不是又一个筛选器——
      // 所以刻意不做成第 4 个筛选标签（四个标签在窄屏平板上会挤成两行）
      reviewMode: false,
      snoozing: false,
      // 刚复习完几道：用于结束后给一句交代，不做持久化（刷新即散）
      justFinished: 0,
      page: 1,
      totalPages: 1,
      loading: false,
      error: '',
      preview: '',
      modal: {
        open: false, id: 0, subject: '', tag: '✗', question: '',
        student_answer: '', correct_answer: '', reason: '', note: '',
        mastered: false, saving: false, error: ''
      }
    };
  },
  computed: {
    filterOptions: function() {
      return [
        { id: '0', label: '待复习' },
        { id: '1', label: '已掌握' },
        { id: '', label: '全部' }
      ];
    }
  },
  watch: {
    // 换筛选就重置到第一页：否则会停在一个新筛选下不存在的页码上
    masteredFilter: function() {
      // 首进页时若从本地恢复了筛选，这次变化是「恢复」触发的，不该再发请求
      // （请求统一由 mounted 里的 load(1) 发起，避免进页打两次接口）
      if (this._restoringMastered) { this._restoringMastered = false; return; }
      this.saveViewState();
      this.load(1);
    },
    subject: function() {
      if (this._restoringSubject) { this._restoringSubject = false; return; }
      this.saveViewState();
      this.load(1);
    }
  },
  mounted: function() {
    // katex 按需加载 + 就绪重绘：列表模板里 v-html="render(q.*)" 直接调方法，
    // 重绘用 $forceUpdate 最省事（数据没变，只是公式引擎到位了）
    var self = this;
    ensureKatexIdle();
    onKatexReady(function () { self.$forceUpdate(); });
    this.restoreViewState();
    this.load(1);
    this.loadSubjects();
  },
  methods: {
    // 记住上次的筛选与自测偏好：切页回来不该又回到「待复习 · 全部学科 · 无自测」。
    // 存本地即可——这是「我上次想看什么」，跨设备无意义。
    restoreViewState: function() {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem('cluss_view_wrongbook') || '{}') || {}; } catch (e) { saved = {}; }
      // 各字段分别打闸：只在值合法且与默认不同时恢复，避免触发多余的 watcher
      if ((saved.masteredFilter === '0' || saved.masteredFilter === '1' || saved.masteredFilter === '') && saved.masteredFilter !== this.masteredFilter) {
        this._restoringMastered = true;
        this.masteredFilter = saved.masteredFilter;
      }
      if (typeof saved.subject === 'string' && saved.subject !== this.subject) {
        this._restoringSubject = true;
        this.subject = saved.subject;
      }
      // 自测模式没有 watcher（它不是筛选），直接恢复即可。
      // 刻意不恢复 reviewMode —— 那是「一轮复习流程」而不是持久偏好，
      // 记下来的话下次进页会把人直接困在复习态里。
      if (typeof saved.quizMode === 'boolean') this.quizMode = saved.quizMode;
    },

    saveViewState: function() {
      try {
        localStorage.setItem('cluss_view_wrongbook', JSON.stringify({
          masteredFilter: this.masteredFilter,
          subject: this.subject,
          quizMode: this.quizMode
        }));
      } catch (e) { /* 隐私模式下会抛，忽略 */ }
    },

    render: function(text) { return renderMarkdown(text); },

    toggleQuiz: function() {
      this.quizMode = !this.quizMode;
      this.revealed = {};
      // 学生手动开关自测是一次明确选择，值得记住。只在手动入口写，
      // 复习流程里自动开关（startReview / exitReview）不覆盖这份偏好。
      this.saveViewState();
    },

    reveal: function(id) {
      // 列表数据是响应式的，但新键要 $set 才能被侦测到
      this.$set(this.revealed, id, true);
    },

    // 这条错题有没有需要藏的内容：三者全空时不用给翻看按钮
    quizHasAnswer: function(q) {
      return !!(q.correct_answer || q.reason || q.note);
    },

    // ---- 复习流程 ----

    // 开始复习：只看今天到期的，并强制打开自测（先想再看）
    startReview: function() {
      this.reviewMode = true;
      this.quizMode = true;
      this.revealed = {};
      this.justFinished = 0;
      this.load(1);
    },

    // 退出复习：中途退出不会丢任何进度——每次「记住了/忘了」都已经写回服务端了。
    // 这里只需要回到普通列表，并把角标刷成最新
    exitReview: function() {
      this.reviewMode = false;
      this.quizMode = false;
      this.revealed = {};
      this.load(1);
      this.$store.dispatch('wrongBook/refreshOverview');
    },

    // 记一次复习
    //   'good'  记住了 —— 阶梯往下一级
    //   'again' 忘了   —— 打回第一级，明天再来
    //
    // 成功后本地移除这一条、不整页重拉：复习讲究节奏，
    // 每点一次就闪一下「读取中」会把这个节奏打断。
    reviewOne: function(q, result) {
      var self = this;
      if (this._reviewing) return;
      this._reviewing = true;

      this.$http.post('/wrong-book/' + q.id + '/review', { result: result }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '记录失败');

        var idx = -1;
        for (var i = 0; i < self.items.length; i++) {
          if (self.items[i].id === q.id) { idx = i; break; }
        }
        if (idx >= 0) self.items.splice(idx, 1);
        self.justFinished += 1;

        // 一轮做完了 → 自动收尾。
        // 不收尾的话，学生会停在一个空列表上对着「复习中·还剩 0 道」发呆，
        // 分不清是结束了还是页面坏了。收尾动作：
        //   1) 退出复习（回到普通列表，让他能继续看自己的错题本）
        //   2) 本地把 due 清零 —— 刚刚练过的题全部被推到了未来，这是事实，
        //      不必等下一次请求回来，否则中间会闪一下"今天有 N 道该复习"
        if (!self.items.length) {
          self.reviewMode = false;
          self.quizMode = false;
          self.revealed = {};
          self.counts = Object.assign({}, self.counts, { due: 0 });
          self.load(1);
        }

        // 服务端已经算好了准确话术（"3 天后再练" / "打回第一级，明天再练"），
        // 直接用它——前端另写一套文案，迟早与后端判定互相矛盾
        if (r.data.message) {
          self.$store.dispatch('toast', {
            message: r.data.message,
            type: result === 'again' ? 'info' : 'success'
          });
        }
        self.$store.dispatch('wrongBook/refreshOverview');
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '记录失败', type: 'error' });
      }).then(function() {
        self._reviewing = false;
      });
    },

    // 今天先不复习：把当前到期的整体推到明天
    //
    // 这是「不打扰」的关键出口：一个躲不掉的提醒会从帮忙变成压力。
    // 给一个一键、可逆、看得懂的推迟，比逼学生点开然后草草划完更尊重他，
    // 也保住了复习本身的质量——被逼做的复习等于没做。
    snoozeToday: function() {
      var self = this;
      if (this.snoozing) return;
      this.snoozing = true;

      this.$http.post('/wrong-book/review/snooze', { days: 1 }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '操作失败');
        self.$store.dispatch('toast', { message: r.data.message, type: 'success' });
        self.load(1);
        self.$store.dispatch('wrongBook/refreshOverview');
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '操作失败', type: 'error' });
      }).then(function() {
        self.snoozing = false;
      });
    },

    load: function(page) {
      var self = this;
      this.loading = true;
      this.error = '';
      this.page = page || 1;
      this.selected = [];
      this.revealed = {};

      return this.$http.get('/wrong-book', {
        params: {
          mastered: this.reviewMode ? '0' : this.masteredFilter,
          subject: this.reviewMode ? '' : this.subject,
          // 复习模式只要今天到期的
          due: this.reviewMode ? '1' : '',
          // 一轮做完就够：复习是"过一遍"，不是"翻完整个错题本"。
          // 学生若今天有 60 道到期，一次给 60 道会长得吓人；50 道够用，
          // 做完再看进度——真正的积压会分成几天自然消化
          limit: this.reviewMode ? 50 : 20,
          page: this.page
        }
      }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '加载失败');
        var d = r.data.data;
        self.items = d.items || [];
        self.counts = d.counts || { pending: 0, mastered: 0, due: 0, graduated: 0, total: 0 };
        self.totalPages = d.total_pages || 1;
        // 顺手把全局概览也更新掉：counts 与 overview 在服务端同源（countsOf 一处算），
        // 所以这是零成本的同步——不用再发一次请求，角标也不会和页面上的数字打架
        if (d.counts) self.$store.commit('wrongBook/SET_OVERVIEW', d.counts);
      }).catch(function(err) {
        self.error = err.message || '加载失败';
      }).then(function() {
        self.loading = false;
      });
    },

    loadSubjects: function() {
      var self = this;
      return this.$http.get('/wrong-book/subjects').then(function(r) {
        if (r.data.code === 200) self.subjects = r.data.data.subjects || [];
      }).catch(function() {});
    },

    toggleMastered: function(q) {
      var self = this;
      this.$http.put('/wrong-book/' + q.id, { mastered: !q.mastered }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '操作失败');
        self.load(self.page);
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '操作失败', type: 'error' });
      });
    },

    bulk: function(action) {
      var self = this;
      if (!this.selected.length) return;

      var run = function() {
        self.$http.post('/wrong-book/batch', { ids: self.selected, action: action }).then(function(r) {
          if (r.data.code !== 200) throw new Error(r.data.message || '操作失败');
          self.$store.dispatch('toast', { message: r.data.message, type: 'success' });
          self.load(self.page);
        }).catch(function(err) {
          self.$store.dispatch('toast', { message: err.message || '操作失败', type: 'error' });
        });
      };

      if (action === 'delete') {
        this.$store.dispatch('confirm', {
          message: '确定删除选中的 ' + this.selected.length + ' 条错题？删除后无法恢复。',
          confirmText: '删除',
          danger: true
        }).then(function(ok) {
          if (ok) run();
        });
        return;
      }

      run();
    },

    remove: function(q) {
      var self = this;
      this.$store.dispatch('confirm', {
        message: '确定删除这条错题？删除后无法恢复。',
        confirmText: '删除',
        danger: true
      }).then(function(ok) {
        if (!ok) return;
        self.$http.delete('/wrong-book/' + q.id).then(function(r) {
          if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
          self.load(self.page);
          self.loadSubjects();
        }).catch(function(err) {
          self.$store.dispatch('toast', { message: err.message || '删除失败', type: 'error' });
        });
      });
    },

    openCreate: function() {
      this.modal = {
        open: true, id: 0, subject: this.subject || '', tag: '✗', question: '',
        student_answer: '', correct_answer: '', reason: '', note: '',
        mastered: false, saving: false, error: ''
      };
    },

    openEdit: function(q) {
      this.modal = {
        open: true,
        id: q.id,
        subject: q.subject,
        tag: q.tag,
        question: q.question,
        student_answer: q.student_answer,
        correct_answer: q.correct_answer,
        reason: q.reason,
        note: q.note,
        mastered: q.mastered,
        saving: false,
        error: ''
      };
    },

    save: function() {
      var self = this;
      var m = this.modal;

      if (!m.question.trim()) {
        m.error = '题干不能为空';
        return;
      }

      m.saving = true;
      m.error = '';

      var payload = {
        subject: m.subject, tag: m.tag, question: m.question,
        student_answer: m.student_answer, correct_answer: m.correct_answer,
        reason: m.reason, note: m.note, mastered: m.mastered
      };

      var req = m.id
        ? this.$http.put('/wrong-book/' + m.id, payload)
        : this.$http.post('/wrong-book', payload);

      req.then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '保存失败');
        self.$store.dispatch('toast', { message: m.id ? '已保存' : '已加入错题本', type: 'success' });
        m.open = false;
        self.load(self.page);
        self.loadSubjects();
      }).catch(function(err) {
        m.error = err.message || '保存失败';
      }).then(function() {
        m.saving = false;
      });
    },

    exportCsv: function() {
      this.download('/api/wrong-book/export.csv', 'cluss-wrong-book.csv');
    },

    download: function(url, filename) {
      var self = this;
      var token = this.$store.state.auth.token;
      fetch(url, {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        credentials: 'same-origin'
      }).then(function(resp) {
        if (!resp.ok) throw new Error('导出失败');
        return resp.blob();
      }).then(function(blob) {
        var objUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = objUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objUrl);
      }).catch(function() {
        self.$store.dispatch('toast', { message: '导出失败，请重试', type: 'error' });
      });
    },

    formatTime: function(iso) {
      return this.$fmtLocal(iso);
    }
  }
};
</script>

<style scoped>
.wrong-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  /* 完全贴边：去掉固定留白，仅保留安全区边距（无刘海设备上为 0） */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  gap: var(--gap-md);
}
html.no-flex-gap .wrong-page > * + * {
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











/* ---- 今日复习卡片 ----
   做成卡片而不是弹窗：复习不是紧急事项，弹窗会打断学生正在做的题，
   而且弹窗只有"立即处理"和"关闭"两个答案，等于逼他现在做。
   左边信息、右边动作，窄屏靠 flex-wrap 自然堆叠。
   gap 一律配 html.no-flex-gap 回退（基线是 Chrome 80 的安卓平板）。 */
.review-card {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  flex-wrap: wrap;
}
html.no-flex-gap .review-card > * + * {
  margin-left: var(--gap-md);
}





/* 左侧色条区分三种状态：到期（强调）/ 复习中（强调+底色）/ 已收尾（成功） */
.review-card {
  border-left: 3px solid var(--accent);
}
.review-card.is-active {
  background: var(--accent-soft);
}
.review-card.is-done {
  border-left-color: var(--success);
}
.review-main {
  flex: 1;
  min-width: 220px;
}
.review-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.review-sub {
  margin-top: 3px;
  line-height: 1.55;
}
/* 「复习不花积分」单独标出来：
   学生已经形成"用 AI 就要花积分"的预期，不点明的话，
   他会因为怕扣分而不敢点「开始复习」——这是纯本地操作，一分不花 */
.review-free {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--success-soft);
  color: var(--success);
  font-size: 11.5px;
}
.review-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  margin-left: auto;
}
html.no-flex-gap .review-actions > * + * {
  margin-left: 8px;
}





/* 窄屏：动作换到下一行并占满，避免两个按钮被挤成竖排 */
@media (max-width: 680px) {
  .review-actions {
    margin-left: 0;
    width: 100%;
  }
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











.subject-select {
  max-width: 160px;
  padding: 7px 10px;
  font-size: 13px;
}

.toolbar-right {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
html.no-flex-gap .toolbar-right > * + * {
  margin-left: 8px;
}











.stat-row {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  flex-shrink: 0;
  flex-wrap: wrap;
}
html.no-flex-gap .stat-row > * + * {
  margin-left: var(--gap-md);
}











.stat {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 10px 16px;
  border-radius: var(--radius-lg);
}
html.no-flex-gap .stat > * + * {
  margin-left: 6px;
}











.stat-num {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.stat-label {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.bulk {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--radius-lg);
  margin-left: auto;
}
html.no-flex-gap .bulk > * + * {
  margin-left: 8px;
}











@media (hover: hover) {
.danger-text:hover {
  color: var(--danger);
  background: var(--danger-tint);
}
}


.quiz-hint {
  flex-shrink: 0;
}

.quiz-reveal {
  /* 按钮替代被藏起的内容块：对齐行首，弱化成"行动入口"而不是装饰 */
  margin-top: 2px;
}

.list-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  border-radius: var(--radius-lg);
}

.items {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}
html.no-flex-gap .items > * + * {
  margin-top: var(--gap-md);
}











.item {
  display: flex;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--surface-1);
}
html.no-flex-gap .item > * + * {
  margin-left: 10px;
}











/* 已掌握的整条降饱和，一眼能和待复习区分开 */
.item.is-mastered {
  opacity: 0.62;
}

.item-check {
  padding-top: 2px;
}

.item-main {
  flex: 1;
  min-width: 0;
}

.item-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
html.no-flex-gap .item-top > * + * {
  margin-left: 6px;
}











.item-time {
  margin-left: auto;
}

.item-row {
  display: flex;
  gap: 10px;
  margin-bottom: 8px;
}
html.no-flex-gap .item-row > * + * {
  margin-left: 10px;
}











.row-label {
  width: 64px;
  flex-shrink: 0;
  padding-top: 2px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.row-text {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
}

.row-text.reason {
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger-text);
}

.item-image {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
html.no-flex-gap .item-image > * + * {
  margin-left: 8px;
}











.item-image img {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--glass-border);
  cursor: zoom-in;
}

.item-actions {
  display: flex;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ink-2);
}
html.no-flex-gap .item-actions > * + * {
  margin-left: 8px;
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











/* ---------- 弹窗 ---------- */
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
}

.form-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  margin: 0 -6px;
  padding: 0 6px;
}

.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap-md);
}

.textarea {
  resize: vertical;
  line-height: 1.6;
  font-family: inherit;
}

.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
html.no-flex-gap .switch-row > * + * {
  margin-left: 8px;
}











.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: var(--gap-md);
  padding-top: var(--gap-md);
  border-top: 1px solid var(--ink-2);
}
html.no-flex-gap .modal-actions > * + * {
  margin-left: 10px;
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
  align-items: center;
  justify-content: center;
  padding: var(--gap-lg);
  background: var(--mask-deep);
  cursor: zoom-out;
}

.preview-img {
  max-width: 94vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: var(--radius-md);
}

@media (max-width: 700px) {
  .row-2 {
    grid-template-columns: 1fr;
    gap: 0;
  }

  .item-row {
    flex-direction: column;
    gap: 2px;
  }

  .row-label {
    width: auto;
  }

  .toolbar-right {
    margin-left: 0;
    width: 100%;
  }
}
</style>