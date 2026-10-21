<template>
  <div class="study-page">
    <AppNav active="study" :show-menu-button="useDrawer" @toggle-sidebar="toggleDrawer" />

    <transition name="fade">
      <div v-if="drawerOpen" class="app-drawer-mask" @click="closeDrawer"></div>
    </transition>

    <!-- 判 useDrawer（竖屏且足够窄）而非 isPortrait，判据与 CSS 的 html.use-drawer 一致 -->
    <div class="body" :class="{ 'is-portrait': isPortrait, 'use-drawer': useDrawer }">
      <transition name="fade">
        <aside
          v-show="!useDrawer || drawerOpen"
          class="sidebar app-sidebar-drawer"
          :class="{ 'is-open': drawerOpen }"
          :style="drawerStyle"
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
        <!-- 整块加载失败（进页带 ?conversation / 点历史记录）→ 复用全站的
             ErrorBanner，页内给出可重试入口（用法与记录页一致）；
             上传 / 删除 / 生成等单次动作的失败仍走各自既有反馈，不在此列 -->
        <ErrorBanner :message="error" retry @retry="retryOpen" />

        <!-- 双栏：横屏左图右解，竖屏上下 -->
        <div class="split-pane pane-wrap">
          <!-- 图片区 -->
          <section class="pane glass">
            <div class="pane-head">
              <span class="section-label">{{ taskKind === 'grade' ? '作答图片' : '题目图片' }}</span>
              <div class="pane-actions">
                <!-- 拍照走独立入口：拍完直接成为题图，不必先打开选择器 -->
                <label class="btn btn-sm btn-primary upload-btn" :class="{ disabled: uploading }">
                  <input
                    ref="camera"
                    type="file"
                    accept="image/*"
                    capture="environment"
                    class="file-input"
                    :disabled="uploading"
                    @change="onCamera"
                  />
                  {{ uploading ? '上传中…' : '拍照' }}
                </label>
                <button class="btn btn-sm btn-ghost" @click="pickerOpen = true">
                  {{ attachments.length ? '重新选择' : '从云盘选择' }}
                </button>
                <button class="btn btn-sm btn-ghost" @click="notePickerOpen = true">
                  {{ noteRefs.length ? '引用笔记 ' + noteRefs.length : '引用笔记' }}
                </button>
              </div>
            </div>

            <div class="pane-body">
              <div v-if="!attachments.length" class="empty-hint">
                <div>{{ taskKind === 'grade' ? '拍下或选择学生写好的作答' : '拍下或选择题目' }}</div>
                <div class="tiny">可直接拍照，也可从云盘选择已有的图</div>
                <label class="btn btn-sm btn-primary upload-btn" :class="{ disabled: uploading }">
                  <input type="file" accept="image/*" capture="environment" class="file-input" :disabled="uploading" @change="onCamera" />
                  {{ uploading ? '上传中…' : '拍照' }}
                </label>
              </div>

              <div v-else class="img-list">
                <div v-for="(a, idx) in attachments" :key="a.hash" class="img-card">
                  <span class="img-index">{{ idx + 1 }}</span>
                  <!-- 预览用**缩略图**，点开才加载原图。
                       直接拿原图当预览是这里以前的做法：手机上拍一张 3-5MB 的照片，
                       塞进这么小的预览卡里，低端平板上要等很久才出画 ——
                       学生看到的就是"图片显示不出来"。
                       同一处的对话页一直是这么做的（?thumb=1 + 点击看原图）。 -->
                  <img
                    class="img-preview"
                    :src="a.thumb_url || (apiBase + '/cloud/files/' + a.hash + '?thumb=1')"
                    :alt="a.name"
                    loading="lazy"
                    @click="preview = a.url || (apiBase + '/cloud/files/' + a.hash)"
                  />
                  <span class="img-name tiny">{{ a.name }}</span>
                  <button class="img-remove" title="移除" @click="removeAttachment(a.hash)">×</button>
                </div>
              </div>
            </div>

            <div v-if="attachments.length" class="pane-foot">
              <span v-if="paperMode === 'cross_page'" class="badge badge-accent">请确认顺序：图 1 → 图 {{ attachments.length }}</span>
              <span v-else class="tiny muted">共 {{ attachments.length }} 张</span>
            </div>

            <!-- 引用的笔记：让 AI 结合自己整理的笔记来讲，而不是只对着题图硬解 -->
            <div v-if="noteRefs.length" class="note-refs">
              <span class="note-refs-label tiny">引用笔记</span>
              <span v-for="n in noteRefs" :key="n.id" class="note-ref-chip">
                {{ n.title }}
                <button class="note-ref-x" title="移除" @click="removeNoteRef(n.id)">×</button>
              </span>
            </div>
          </section>

          <!-- 解答区 -->
          <section class="pane glass">
            <div class="pane-head">
              <span class="section-label">{{ taskKind === 'grade' ? '批改结果' : '解答' }}</span>
              <div class="pane-actions">
                <!-- 只显示模型名：原来还缀一个「（转述）」，那是系统内部的实现方式
                     （先用一个能看图的模型把图片转成文字），学生看到只会困惑，
                     也做不了任何决定。倍率 / 限免由 ModelSelect 以徽标呈现。 -->
                <ModelSelect
                  v-model="modelId"
                  :options="visionModels"
                  :disabled="sending"
                  size="sm"
                />
              </div>
            </div>

            <div ref="scroller" class="pane-body answer-body" @scroll="onScrollAnswer">
              <!-- 已提交但还没出字：三点呼吸说明"在工作"，文字说明"为什么可能慢"
                   （8s / 20s 分级升级，见 utils/waiting.js）。
                   role=status 让读屏器也能听到，而不是只看到动画 -->
              <!-- 推理中的推演过程：思考比正文先到，这时候学生最容易以为卡死，
                   所以宁可让它占一小块地方，也要让他看见"在工作"。
                   默认折叠，展开才看全文（见 Chat.vue 同名样式）。 -->
              <details
                v-if="reasoning"
                class="think-panel"
                @toggle="reasoningOpen = $event.target.open"
              >
                <summary class="think-summary">
                  <span class="think-dot" v-if="sending" aria-hidden="true"></span>
                  {{ sending ? '正在推演思路…' : '思考过程' }}
                  <span class="think-toggle muted tiny">（{{ reasoningOpen ? '收起' : '展开' }}）</span>
                </summary>
                <div class="think-body">{{ reasoning }}</div>
              </details>

              <div v-if="!answer && sending" class="waiting-hint" role="status">
                <span class="waiting-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>{{ waitText }}</span>
              </div>
              <div v-else-if="!answer" class="empty-hint">
                <div class="tiny">{{ taskHint }}</div>
              </div>
              <!-- 渲染预计算好的 answerHtml：在模板里调 render(answer) 会让每次
                   重渲染都重解析整篇 Markdown（见 mixins/streamFrame）。
                   流式光标已由 paint 注入渲染结果的最后一行行内 -->
              <!-- 流式期间走「冻结段 + 尾段」两个节点（见 utils/stream-paint）：
                   冻结段在生成过程中不再变化，浏览器不必重建它。 -->
              <template v-else>
                <div v-if="answerHtmlFrozen" class="md-body md-stream">
                  <div class="md-part" v-html="answerHtmlFrozen"></div>
                  <div class="md-part" v-html="answerHtml"></div>
                </div>
                <div v-else class="md-body" v-html="answerHtml"></div>
              </template>
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
                :placeholder="notePlaceholder"
              ></textarea>
              <button
                class="btn"
                :class="sending ? 'btn-stop' : 'btn-primary'"
                :disabled="!sending && !canSend"
                @click="sending ? stop() : start()"
              >{{ sending ? '停止生成' : (taskKind === 'grade' ? '开始批改' : '开始解答') }}</button>
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

    <NotePicker
      v-if="notePickerOpen"
      :max="5"
      title="引用笔记"
      :value="noteIds"
      @picked="onNotesPicked"
      @close="notePickerOpen = false"
    />

    <!-- 题图放大：预览卡里是缩略图，点开看原图，方便提交前确认字够不够清楚 -->
    <transition name="fade">
      <div v-if="preview" class="preview-mask" @click.self="preview = ''">
        <img class="preview-img" :src="preview" alt="题图" />
      </div>
    </transition>
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import { apiBase, apiUrl } from '@/utils/base-path';
import Segmented from '@/components/Segmented.vue';
import CloudPicker from '@/components/CloudPicker.vue';
import NotePicker from '@/components/NotePicker.vue';
import { renderMarkdown, renderStream, ensureKatexIdle, onKatexReady } from '@/utils/markdown';
import { createStreamPainter } from '@/utils/stream-paint';
import { appendStreamCaret } from '@/utils/stream-caret';
import { readSseStream, postStream } from '@/utils/sse';
import streamSession from '@/utils/stream-session';
import noteRefs from '@/mixins/note-refs';
import waiting from '@/mixins/waiting';
import streamFrame from '@/mixins/streamFrame';
import orientation from '@/mixins/orientation';
import mermaidCharts from '@/mixins/mermaid';
import ModelSelect from '@/components/ModelSelect.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
// 学习偏好：随每次提问一起上报，让 AI 按学生设定的风格与科目作答
import { readStudentPrefs } from '@/utils/student-prefs';

export default {
  name: 'StudyView',
  components: { AppNav, Segmented, CloudPicker, NotePicker, ModelSelect, ErrorBanner },
  mixins: [waiting, streamFrame, orientation, noteRefs, mermaidCharts],
  data: function() {
    return {
      // 模板里拼云盘文件地址用（根部署 /api，被 CI 反代时 /cluss/api），见 utils/base-path.js
      apiBase: apiBase,
      // 点击题图放大时显示的原图 URL（空 = 不显示遮罩）
      preview: '',
      taskKind: 'solve',
      paperMode: 'single',
      attachments: [],
      answer: '',
      // 模型给出的思考过程（reasoning 事件）：与 Chat 页同一套处理，
      // 目的只有一个——让推理型模型那段长达十几秒的沉默变成可见的推演。
      reasoning: '',
      reasoningOpen: false,
      // 预渲染的 HTML（流式时按帧节流更新），见 mixins/streamFrame
      answerHtml: '',
      // 流式增量渲染的冻结段（见 utils/stream-paint）。
      // 必须在这里声明：Vue 2 不追踪后加的属性，运行期再赋值视图不会更新。
      answerHtmlFrozen: '',
      note: '',
      sending: false,
      streamError: '',
      // 整块加载失败（进页带 ?conversation / 打开历史记录）的文案，
      // 交给页内 ErrorBanner 呈现并可重试。只放这一类的失败；
      // 上传 / 删除 / 生成的失败各有自己的既有反馈，不要混进来。
      error: '',
      visionStatus: '',
      conversationId: '',
      conversations: [],
      models: [],
      modelId: '',
      capability: { available: false, max_images: 4, vision_models: [] },
      pickerOpen: false,
      uploading: false,
      // useDrawer / drawerOpen / drawerDragX 由 mixins/orientation 提供。
      // 不要在这里再声明一份 —— 同名 data 会覆盖 mixin 的同名项，
      // 结果是"mixin 里的逻辑改了 A，界面上看的是 B"，这种错很难查。
      // 学生是否停在底部：不在底部时不要硬把视图拽回去，否则他想翻历史会被打断
      atBottom: true,
      // 用户主动点了停止
      stopped: false
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
    // 同一个输入框承担两种身份：有图时它是"补充说明"，没图时它就是题目本身。
    // 占位文案跟着变，学生不需要先猜"这个框能不能放题目"。
    notePlaceholder: function() {
      if (this.attachments.length) {
        return this.taskKind === 'grade'
          ? '补充说明（选填），如：这是第 3 次作业'
          : '补充说明（选填），如：只讲第 2 问';
      }
      return this.taskKind === 'grade'
        ? '把要批改的作答写进来（可直接粘贴文字）'
        : '没拍照？直接把题目文字写进来，我照样一步步带你解';
    },
    canSend: function() {
      if (this.sending) return false;
      // 有新题何苦非得拍照：群里转发的一道文字题、练习册上抄下来的题干，
      // 都是学生的真实场景。有图或有题目文字都让它可点，
      // 唯一的底线是不能两者皆空（后端同样这么判，这里是前置提示）。
      if (!this.attachments.length && !String(this.note || '').trim()) return false;
      if (this.taskKind === 'solve' && this.paperMode === 'cross_page' && this.attachments.length < 2) {
        // 跨页题只有一张图时后端会降级，这里不拦，只是不提示
      }
      return true;
    }
  },
  watch: {
    // 学习模式 / 题量一变就记住，下次进页面直接沿用（见 mounted 的恢复）。
    // 与对话页记住人格 / 深度思考同一套做法（Chat.vue 的 cluss_persona）。
    taskKind: function() { this.saveStudyPrefs(); },
    paperMode: function() { this.saveStudyPrefs(); }
  },
  mounted: function() {
    // katex 按需加载 + 就绪重绘（与 Chat 同一套，见 markdown.js 的说明）：
    // 答案可能在引擎就绪前就渲染了（历史恢复），到货时把占位换成真公式
    var self = this;
    ensureKatexIdle();
    onKatexReady(function () { if (self.answer) self.answerHtml = renderMarkdown(self.answer); });
    // 方向不在这里判：isPortrait / useDrawer 由 mixins/orientation 订阅
    // utils/device-orientation 的结果。曾经这里另算一份**视口比例**并直接覆写
    // this.isPortrait（mixin 的同名属性、且不写 html class），于是本页的
    // `.body.is-portrait` 与 global.css 认的 `html.is-portrait` 会互相打架
    // —— 屏幕上就是"一半横一半竖"。已移除。
    // 恢复上次选的学习模式与题量：不等接口回来就先切好，免得分隔控件
    // 先闪一下默认值再跳回去（与 Chat 进入页面恢复人格 / 深度思考一致）。
    // 读不到（隐私模式 / 没存过）就保持下面的默认值，行为与改动前一致。
    var prefs = this.readStudyPrefs();
    if (prefs.taskKind === 'solve' || prefs.taskKind === 'grade') this.taskKind = prefs.taskKind;
    if (prefs.paperMode) {
      this.paperMode = prefs.paperMode;
      // 记下这是"从本地恢复的"值：capability 回来后要校验它是否仍被提供
      this._storedPaperMode = prefs.paperMode;
    }
    this.$store.dispatch('auth/fetchWallet').catch(function() {});
    this.loadCapability();
    this.loadModels();
    this.loadConversations();

    // 从记录页跳过来时带 ?conversation=xxx，直接打开那条记录
    var target = this.$route.query.conversation;
    if (target) this.openConversation(String(target));
    // 后台可能还挂着一轮生成（学生切走过又回来）：挂上去就能接着看
    streamSession.attach('study', this);
  },
  beforeDestroy: function() {
    // ⚠️ 这里**绝不** abort 在途请求 —— 切页面不等于不想生成了。
    // 请求交给 utils/stream-session 在后台继续消费，回来 attach 时接着显示。
    // 只有学生主动点「停止生成」才真的掐断（见 stop）。
    streamSession.detach(this);
    this.destroyed = true;
    this.clearServerPoll();
  },
  methods: {
    // 读取上次的学习偏好（学习模式 + 题量）。
    // 隐私模式 / 受限 WebView 里 localStorage 可能直接抛异常：静默返回空对象、
    // 回落到默认值继续用 —— 绝不能因为读不到偏好而报错或白屏（本项目踩过这类坑）。
    readStudyPrefs: function() {
      try {
        var raw = localStorage.getItem('cluss_study_prefs');
        var obj = raw ? JSON.parse(raw) : null;
        return (obj && typeof obj === 'object') ? obj : {};
      } catch (e) {
        return {};
      }
    },

    // 写入当前学习偏好。写不进去（隐私模式 / 配额满）就当没记，下次回到默认，
    // 顶多这次选择没被记住，不该影响正常解题（同样静默失败）。
    saveStudyPrefs: function() {
      try {
        localStorage.setItem('cluss_study_prefs', JSON.stringify({
          taskKind: this.taskKind,
          paperMode: this.paperMode
        }));
      } catch (e) { /* 存储不可用时忽略 */ }
    },

    loadCapability: function() {
      var self = this;
      return this.$http.get('/study/capabilities').then(function(r) {
        if (r.data.code !== 200) return;
        self.capability = r.data.data;
        // 有指定模型就用它，否则挑第一个能看图的
        if (!self.modelId && self.capability.vision_models && self.capability.vision_models.length) {
          self.modelId = self.capability.vision_models[0].id;
        }
        // 恢复的题量模式若已不在后端提供的列表里（管理员改过配置），回落到第一项，
        // 否则会把一个无效值发给后端。只纠正"从本地恢复的"值，
        // 没存过（首次使用）保持原默认，行为不变。
        var modes = self.capability.paper_modes || [];
        if (self._storedPaperMode && modes.length) {
          var stillOffered = modes.some(function(m) { return m.id === self.paperMode; });
          if (!stillOffered) self.paperMode = modes[0].id;
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

    // 历史只认「真正走过拍题 / 批改」的会话：/study/records 以用户消息的
    // source ∈ (solve, grade) 为判据。此前用 /study/conversations，而对话页
    // 建的会话也是 study 模式 —— 结果学生在对话页随口问的一句会出现在这里，
    // 点进去既没有图也没有解答，像是"记录坏了"。
    // 两条链路各司其职：对话会话归对话页的学习/日常，这里只放有图有解的记录。
    loadConversations: function() {
      var self = this;
      return this.$http.get('/study/records', { params: { limit: 50 } }).then(function(r) {
        if (r.data.code !== 200) return;
        var items = (r.data.data && r.data.data.items) || [];
        self.conversations = items.map(function(x) {
          return {
            id: x.conversation_id,
            title: x.title || '（无标题）',
            type: x.type,
            thumb_url: x.thumb_url || ''
          };
        });
      }).catch(function() {});
    },

    // 解答正文的唯一写入点：answer 与 answerHtml 必须**一起**改。
    //
    // 模板渲染的是 answerHtml（预计算好的 HTML，避免每次重渲染都重新解析
    // 整篇 Markdown），answer 是原始文本。两者分开写一定会漏 ——
    // 之前的 bug 就是 openConversation 只写了 answer，点历史题目时
    // 页面还停在上一次的 answerHtml 上，看起来"没切换"。
    // 流式路径不走这里（按帧节流写，见 paint），但同样遵守这条不变量。
    // 答案的唯一写入口。清空答案时必须同时清掉思考过程：
    // 换了一道题还在显示上一题的推演，比不显示更糟。
    setAnswer: function(text) {
      this.answer = text == null ? '' : String(text);
      this.answerHtml = renderMarkdown(this.answer);
      // 正文整体换掉了，增量渲染的冻结段作废（不清会与旧冻结段拼在一起）
      this.answerHtmlFrozen = '';
      this.reasoning = '';
      this.reasoningOpen = false;
    },

    openConversation: function(id) {
      var self = this;
      this.error = '';
      return this.$http.get('/conversations/' + id).then(function(r) {
        if (r.data.code !== 200) return;
        var msgs = r.data.data.messages || [];
        self.conversationId = id;
        self.setAnswer('');
        // 取最后一条助手回复作为解答内容
        // 必须走 setAnswer：只写 answer 的话 answerHtml 不会更新，
        // 点历史题目就会"看起来没切换"（曾经的真实 bug）
        var serverStreaming = false;
        for (var i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') {
            self.setAnswer(msgs[i].content);
            // 服务端还在生成（换设备 / 重开应用回来）→ 下面是轮询补齐
            serverStreaming = !!msgs[i].streaming;
            break;
          }
        }
        // 还原当时的题图
        self.attachments = [];
        for (var j = 0; j < msgs.length; j++) {
          if (msgs[j].role === 'user' && msgs[j].attachments && msgs[j].attachments.length) {
            self.attachments = msgs[j].attachments.map(function(a) {
              return {
                hash: a.hash, name: a.name, size: a.size, kind: a.kind,
                url: apiBase + '/cloud/files/' + a.hash,
                thumb_url: apiBase + '/cloud/files/' + a.hash + '?thumb=1'
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
        // 服务端还在写这一轮 → 轮询到它写完（stream-session 之外的第二条恢复路径）
        self.pollServerStream(serverStreaming);
      }).catch(function(err) {
        // 整块内容（题图 + 解答）没拉到 → 走页内 ErrorBanner，留一个重试入口。
        // 原来是弹一条 toast：学生还没看清就消失，也没有重试可点。
        self.error = err.message || '打开失败';
        self._failedConvId = id;
      });
    },

    // ErrorBanner 的重试入口：重新打开上次失败的那条记录
    retryOpen: function() {
      if (this._failedConvId) this.openConversation(this._failedConvId);
    },

    removeConversation: function(id) {
      var self = this;
      this.$http.delete('/conversations/' + id).then(function(r) {
        if (r.data.code !== 200) return;
        self.conversations = self.conversations.filter(function(c) { return c.id !== id; });
        if (self.conversationId === id) {
          self.conversationId = '';
          self.setAnswer('');
        }
      }).catch(function() {});
    },

    onPicked: function(files) {
      var self = this;
      this.attachments = files.slice(0, this.capability.max_images || 4).map(function(f) {
        return {
          hash: f.hash, name: f.name, size: f.size, kind: 'image',
          url: f.url || (apiBase + '/cloud/files/' + f.hash),
          thumb_url: f.thumb_url || (apiBase + '/cloud/files/' + f.hash + '?thumb=1')
        };
      });
      // 换图即换题，与拍照路径保持一致
      this.setAnswer('');
      this.streamError = '';
      this.conversationId = '';
      void self;
    },

    removeAttachment: function(hash) {
      this.attachments = this.attachments.filter(function(a) { return a.hash !== hash; });
      this.setAnswer('');
    },

    // 拍照：上传后直接作为题图（不进选择器，少两步点击）
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

        var item = {
          hash: f.hash, name: f.name, size: f.size, kind: 'image',
          url: f.url || (apiBase + '/cloud/files/' + f.hash),
          thumb_url: f.thumb_url || (apiBase + '/cloud/files/' + f.hash + '?thumb=1')
        };

        // 跨页题常要连拍多张，所以拍照是「追加」而非「替换」；
        // 其余模式重新拍照视为换题，直接替换掉旧的
        if (self.paperMode === 'cross_page' && self.attachments.length) {
          if (self.attachments.length >= (self.capability.max_images || 4)) {
            self.$store.dispatch('toast', { message: '最多 ' + (self.capability.max_images || 4) + ' 张', type: 'error' });
            return;
          }
          if (!self.attachments.some(function(a) { return a.hash === item.hash; })) {
            self.attachments.push(item);
          }
        } else {
          self.attachments = [item];
          // 换图即换题：清掉会话，避免模型看到上一道题的解答历史而串味
          self.conversationId = '';
        }

        self.setAnswer('');
        self.$store.dispatch('toast', { message: '已拍照', type: 'success' });
      }).catch(function(err) {
        self.streamError = err.message || '上传失败';
      }).then(function() {
        self.uploading = false;
        if (self.$refs.camera) self.$refs.camera.value = '';
        // 上面模板里的空态 input 没有 ref，用事件目标兜底清空
        if (e.target) e.target.value = '';
      });
    },

    scrollAnswer: function() {
      var self = this;
      this.$nextTick(function() {
        var el = self.$refs.scroller;
        if (el) el.scrollTop = el.scrollHeight;
        self.atBottom = true;
      });
    },

    // 学生往上翻着看时不要继续把他拽回底部；回到贴底才恢复自动跟随
    onScrollAnswer: function() {
      var el = this.$refs.scroller;
      if (!el) return;
      this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    },

    // 中断当前生成：收尾统一放在流式 promise 的 finally 里
    stop: function() {
      if (!this.sending) return;
      this.stopped = true;
      // 先把这轮标记为结束 —— 否则学生停止后再切走，后台会话会以为它还在生成
      streamSession.finish();
      // controller 由后台会话持有：从后台恢复过来的组件自己没有 _abort，
      // 走 session 才掐得断（两处是同一个 controller，abort 是幂等的）
      streamSession.abort();
      if (this._abort) this._abort.abort();
    },

    // ---------- 后台流式会话（切页面不断流）----------

    // 渲染当前答案。流式期间走轻量渲染（renderStream），
    // 结束 / 中断的收尾那次走完整渲染 —— 公式与图表必须在最后真出来。
    // answer 与 answerHtml 必须**一起**改（见 setAnswer 的说明），这里是流式路径的唯一出口
    //
    // 流式期间另外做**增量**渲染（换写 stream-paint）：冻结已稳定的前缀，
    // 每帧只重渲染尾巴那一小块。实测长回答的每帧成本因此不再随长度增长。
    paintStream: function() {
      if (this.sending) {
        if (!this._painter) this._painter = createStreamPainter(renderStream);
        var out = this._painter.update(this.answer);
        this.answerHtmlFrozen = out.frozen;
        this.answerHtml = appendStreamCaret(out.tail);
      } else {
        this._painter = null;
        this.answerHtmlFrozen = '';
        this.answerHtml = renderMarkdown(this.answer);
      }
      if (this.atBottom) this.scrollAnswer();
    },

    // 后台会话每收到一个增量都会回调这里（组件已 detach 时不会回调）
    _onStreamSync: function() {
      if (!streamSession.isActive('study')) return;
      var s = streamSession.getState();

      // 还没接过线（组件是重新挂载的）→ 先把历史与题图补齐
      if (!this.streamAttached) {
        if (!this.resuming) this.resumeStream();
        return;
      }
      // 这轮不属于当前打开的记录（学生切去看别的历史了）：只管累积，别动界面
      if (s.conversationId && this.conversationId && s.conversationId !== this.conversationId) return;

      this.answer = s.text;
      this.reasoning = s.reasoning;
      this.sending = !s.done;
      // 恢复过来的组件没经历过"首字到达"那一刻（判定发生在旧组件里），补撤等待提示
      if (s.streaming && this.waitText) this.stopWaiting();
      this.scheduleFrame(this.paintStream);
    },

    // 从后台会话恢复：把历史（含题图）拉回来，再把累积到现在的正文补上
    resumeStream: function() {
      var self = this;
      var s = streamSession.getState();
      var load = s.conversationId ? this.openConversation(s.conversationId) : null;
      this.resuming = true;

      return Promise.resolve(load).then(function() {
        if (!streamSession.isActive('study')) { self.resuming = false; return; }
        var st = streamSession.getState();
        // 学生正在看另一条记录（比如从记录页直接点开的）→ 别把他拽回后台那轮
        if (self.conversationId && st.conversationId && self.conversationId !== st.conversationId) {
          self.resuming = false;
          return;
        }

        // 取较长的那份：历史里可能已经存了完整版（生成完入库），也可能一行都还没有
        if (st.text && st.text.length > (self.answer || '').length) self.answer = st.text;
        if (st.reasoning) self.reasoning = st.reasoning;
        self.streamAttached = true;
        self.sending = !st.done;
        self.stopped = false;
        self.resuming = false;
        self.paintStream();

        if (st.done) {
          self.$store.dispatch('auth/fetchWallet').catch(function() {});
          self.loadConversations();
          streamSession.end();
        } else {
          self.startWaiting(self.taskKind === 'grade' ? 'grade' : 'study');
        }
      });
    },

    // ---------- 服务端"生成中"的轮询恢复 ----------
    // 与 Chat 同理：库里那轮还在写、而本地没有活跃后台会话时，隔一会儿拉一次。
    // 只在 openConversation 发现 streaming=1 时才启动（still 参数）。
    pollServerStream: function(still) {
      var self = this;
      var convId = this.conversationId;
      this.clearServerPoll();
      if (!convId || !still) return;
      // 本地这一轮正在流（后台会话在跑）→ 由它负责，别叠加两套更新
      if (streamSession.isActive('study')) return;

      this._serverPoll = setInterval(function() {
        if (!self.conversationId || self.conversationId !== convId) { self.clearServerPoll(); return; }
        if (streamSession.isActive('study')) { self.clearServerPoll(); return; }

        self.$http.get('/conversations/' + convId).then(function(r) {
          if (r.data.code !== 200) return;
          var msgs = r.data.data.messages || [];
          var last = null;
          var streaming = false;
          for (var i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') {
              last = msgs[i];
              streaming = !!msgs[i].streaming;
              break;
            }
          }
          if (last && last.content && last.content !== self.answer) self.setAnswer(last.content);
          if (!streaming) { self.clearServerPoll(); self.loadConversations(); }
        }).catch(function() { /* 网络抖动，下一轮再试 */ });
      }, 1500);
    },

    clearServerPoll: function() {
      if (this._serverPoll) {
        clearInterval(this._serverPoll);
        this._serverPoll = null;
      }
    },

    start: function() {
      var self = this;
      if (!this.canSend) return;

      this.setAnswer('');
      this.streamError = '';
      this.visionStatus = '';
      this.sending = true;
      this.stopped = false;
      this.atBottom = true;
      // 这一轮交给后台会话托管：切走页面时组件会被销毁，但生成不能断
      this.streamAttached = true;
      this.resuming = false;
      // 批改要逐题核对，等待更久，文案分开给（见 utils/waiting.js）
      this.startWaiting(this.taskKind === 'grade' ? 'grade' : 'study');

      // 渲染 + 跟随滚动合并成一次"上色"，交给 rAF 节流（见 mixins/streamFrame）。
      // 收口到 paintStream —— 组件重新挂载、从后台会话恢复之后，同一个方法还能接着用
      var paint = function() { self.paintStream(); };

      var controller = new AbortController();
      this._abort = controller;
      streamSession.begin('study', { conversationId: this.conversationId });
      streamSession.setController(controller);

      var isGrade = this.taskKind === 'grade';
      var url = isGrade ? apiUrl('study/grade/stream') : apiUrl('study/solve/stream');
      // 学习偏好：每次发送时现读（学生在设置里改完立刻生效）
      var prefs = readStudentPrefs();
      var body = isGrade
        ? {
          conversation_id: this.conversationId || '',
          model_id: this.modelId || '',
          answer_hashes: this.attachmentHashes,
          note_ids: this.noteIds,
          content: this.note.trim(),
          student_prefs: prefs
        }
        : {
          conversation_id: this.conversationId || '',
          model_id: this.modelId || '',
          paper_mode: this.paperMode,
          image_hashes: this.attachmentHashes,
          note_ids: this.noteIds,
          content: this.note.trim(),
          student_prefs: prefs
        };

      postStream(url, this.$store.state.auth.token, body, controller.signal).then(function(resp) {
        return readSseStream(resp, {
          onMeta: function(meta) {
            if (meta.conversation_id) {
              self.conversationId = meta.conversation_id;
              // 会话 id 是服务端这一刻才给的，补进后台会话（发起时还不知道）
              streamSession.setConversationId(meta.conversation_id);
            }
          },
          onStatus: function(st) {
            if (st.stage === 'vision') self.visionStatus = st.message || '正在识别图片…';
            else if (st.stage === 'vision_done') self.visionStatus = '';
          },
          onReasoning: function(text) {
            if (self.waitText) self.stopWaiting();
            self.reasoning += text;
            streamSession.feed('', text);
            // 组件已销毁（学生切走了）→ 别再为看不见的 DOM 排渲染帧
            if (self.destroyed) return;
            self.scheduleFrame(paint);
          },
          onDelta: function(text) {
            // 第一个字一到就撤掉等待提示，别让它和正文并存
            if (self.waitText) self.stopWaiting();
            self.answer += text;
            // 同步喂给后台会话：组件在不在都照样累积，切走回来才能接着看
            streamSession.feed(text, '');
            if (self.destroyed) return;
            // 合并到一帧渲染一次（见 mixins/streamFrame）
            self.scheduleFrame(paint);
          },
          onDone: function(done) {
            streamSession.finish();
            self.visionStatus = '';
            self.$store.dispatch('auth/fetchWallet').catch(function() {});
            self.loadConversations();

            // 批改时后端会把错题自动收进错题本，这里告诉学生收了几道
            if (done && done.wrong_added > 0) {
              self.$store.dispatch('toast', {
                message: '已收录 ' + done.wrong_added + ' 道错题到错题本',
                type: 'success'
              });
            }
          },
          onError: function(message) {
            streamSession.finish(message);
            self.visionStatus = '';
            self.streamError = message || '处理失败，请重试';
          }
        });
      }).catch(function(err) {
        self.visionStatus = '';
        // 主动停止的那次在 stop() 里已经 finish 过了，这里不再覆盖
        if (err && err.name === 'AbortError') return;
        streamSession.finish(err.message);
        self.streamError = err.message || '网络异常，请重试';
        if (err && err.status === 402) {
          self.$store.dispatch('auth/fetchWallet').catch(function() {});
        }
      }).then(function() {
        self.sending = false;
        self._abort = null;
        // 无论成功、报错还是中断，都要撤掉等待提示，并把渲染补完
        self.stopWaiting();
        self.cancelFrame();
        paint();

        if (self.stopped) {
          self.stopped = false;
          // 一个字都没生成就停了：给个明确交代，否则学生看着空白不知道发生了什么
          if (!self.answer) self.setAnswer('（已停止生成）');
          streamSession.end();
          return;
        }
        if (!self.answer && !self.streamError) {
          self.streamError = '未收到内容，请重试';
        }

        // 学生没切走（组件还活着）→ 这一轮已经展示完了，后台会话可以收摊。
        // 已经切走了就**不要**收 —— 留着它，回来还要接着看
        if (!self.destroyed) streamSession.end();
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
  /* 完全贴边：去掉固定留白，仅保留安全区边距（无刘海设备上为 0） */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  gap: var(--gap-md);
}
html.no-flex-gap .study-page > * + * {
  margin-top: var(--gap-md);
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
html.no-flex-gap .sidebar > * + * {
  margin-top: var(--gap-md);
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
html.no-flex-gap .mode-card > * + * {
  margin-top: 8px;
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
  /* 按下是即时的（见 global.css 的触屏手感段），松开要柔和回落 */
  transition: background var(--transition);
}
html.no-flex-gap .hist-item > * + * {
  margin-left: 6px;
}

@media (hover: hover) {
.hist-item:hover {
  background: var(--ink-1);
}
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
  border-radius: var(--radius-2xs);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  flex-shrink: 0;
  /* ::after 撑命中区需要定位上下文 */
  position: relative;
}

@media (hover: hover) {
.hist-item:hover .hist-del {
  opacity: 1;
}
}

/* 触屏没有 hover：「悬停才出现」在平板上等于「永远不出现」。
   判据用 @media (hover: none) 而不是方向类 —— 横屏平板才是主力姿态。
   与 Chat.vue 的 .conv-del 同一套：常显 0.7 让位正文，:active 提亮，
   命中区用 ::after 向上下扩到 40px（不动布局）。 */
@media (hover: none) {
  .hist-del {
    opacity: 0.7;
  }
  .hist-del:active {
    opacity: 1;
    background: var(--danger-tint);
    color: var(--danger);
  }
  .hist-del::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 40px;
    transform: translateY(-50%);
    background: transparent;
  }
}

.hist-empty {
  padding: 12px 10px;
  text-align: center;
}

.icon-btn {
  width: clamp(26px, 17.36px + 0.9vw, 40px);
  height: clamp(26px, 17.36px + 0.9vw, 40px);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-tertiary);
  font-size: clamp(15px, 12.12px + 0.3vw, 20px);
  line-height: 1;
  cursor: pointer;
}

@media (hover: hover) {
.icon-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}
}

/* ---------- 双栏 ---------- */
.main {
  min-height: 0;
  display: flex;
  /* 竖排：整块失败的 ErrorBanner 占在双栏之上。只有 .split-pane 一个子节点时
     与原来视觉一致 —— 隐藏的 ErrorBanner 渲染成注释节点，不占位、不产生间距 */
  flex-direction: column;
  gap: var(--gap-md);
}
/* Chrome 80 不支持 flex gap，用相邻兄弟外边距兜底（全站同一套写法） */
html.no-flex-gap .main > * + * {
  margin-top: var(--gap-md);
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
html.no-flex-gap .pane-head > * + * {
  margin-left: var(--gap-sm);
}

.pane-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
html.no-flex-gap .pane-actions > * + * {
  margin-left: 6px;
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
html.no-flex-gap .pane-foot > * + * {
  margin-left: 8px;
}

.pane-foot-action {
  align-items: flex-end;
}

/* 引用的笔记（与对话页同一套观感，改一处要一起改） */
.note-refs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
  flex-shrink: 0;
}
html.no-flex-gap .note-refs > * + * {
  margin-left: 6px;
}

.note-refs-label {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.pane-error {
  margin-top: 0;
  margin-bottom: 8px;
  flex-shrink: 0;
}

/* 拍照按钮：把 <input type=file> 藏进 label 里，做成普通按钮的外观 */
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
  cursor: zoom-in;
}

/* 点开看原图（与错题本同一套写法） */
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

@media (hover: hover) {
.img-remove:hover {
  background: var(--danger);
}
}

/* ---------- 补充说明输入 ---------- */
.note-input {
  flex: 1;
  /* 38px 只装得下一行字：占位文案是两句（约两行），
     矮一点就会切出"半行字"的破相。52px 恰好完整展示两行。 */
  min-height: 52px;
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
html.no-flex-gap .vision-status > * + * {
  margin-left: 8px;
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

/* 流式光标样式在 global.css（.stream-caret）：三页共用同一份 */

@media (max-width: 900px) {
  .body {
    grid-template-columns: minmax(0, 1fr);
  }

}

/* 极矮屏（如 960×680）：图片栏头部一行要塞下「题目图片」+ 三个按钮，
   默认的 .btn-sm 内边距会逼着按钮文字折行。压缩按钮并允许头部换行兜底。 */
@media (orientation: landscape) and (max-height: 700px) {
  .pane-head {
    flex-wrap: wrap;
    row-gap: 6px;
  }

  .pane-head .btn-sm {
    padding: 6px 10px;
    font-size: 12.5px;
  }

  .pane-head .section-label {
    white-space: nowrap;
  }
}
</style>