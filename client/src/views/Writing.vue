<template>
  <div class="writing-page">
    <AppNav active="writing" :show-menu-button="useDrawer" @toggle-sidebar="toggleDrawer" />

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
              <button class="btn btn-sm btn-ghost" @click="notePickerOpen = true">
                {{ noteRefs.length ? '引用笔记 ' + noteRefs.length : '引用笔记' }}
              </button>
            </div>
          </div>

          <!-- 引用的笔记：让 AI 按自己整理的素材/笔记来写或批改 -->
          <div v-if="noteRefs.length" class="note-refs">
            <span class="note-refs-label tiny">引用笔记</span>
            <span v-for="n in noteRefs" :key="n.id" class="note-ref-chip">
              {{ n.title }}
              <button class="note-ref-x" title="移除" @click="removeNoteRef(n.id)">×</button>
            </span>
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
            <button
              class="btn"
              :class="sending ? 'btn-stop' : 'btn-primary'"
              :disabled="!sending && !canSend"
              @click="sending ? stop() : start()"
            >{{ sending ? '停止生成' : actionLabel }}</button>
          </div>
        </section>

        <!-- 结果 -->
        <section class="result glass">
          <div class="result-head">
            <span class="section-label">{{ resultLabel }}</span>
            <div class="result-actions">
              <ModelSelect
                v-model="modelId"
                :options="models"
                :disabled="sending"
                size="sm"
              />
              <button v-if="result && !sending" class="btn btn-sm btn-ghost" @click="copyResult">复制</button>
              <button v-if="result && !sending" class="btn btn-sm btn-ghost" @click="savePiece">保存</button>
            </div>
          </div>

          <div ref="scroller" class="result-body" @scroll="onScrollResult">
            <!-- 已提交但还没出字：三点呼吸说明"在工作"，文字说明"为什么可能慢"
                 （8s / 20s 分级升级，见 utils/waiting.js）。
                 role=status 让读屏器也能听到，而不是只看到动画 -->
            <div v-if="!result && sending" class="waiting-hint" role="status">
              <span class="waiting-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>{{ waitText }}</span>
            </div>
            <div v-else-if="!result" class="empty-hint">
              <div class="tiny">{{ emptyHint }}</div>
            </div>
            <!-- 渲染预计算好的 resultHtml（见 mixins/streamFrame）。
                 流式光标已由 paint 注入渲染结果的最后一行行内 -->
            <!-- 流式期间走「冻结段 + 尾段」两个节点（见 utils/stream-paint） -->
            <template v-else>
              <div v-if="resultHtmlFrozen" class="md-body md-stream">
                <div class="md-part" v-html="resultHtmlFrozen"></div>
                <div class="md-part" v-html="resultHtml"></div>
              </div>
              <div v-else class="md-body" v-html="resultHtml"></div>
            </template>
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

    <NotePicker
      v-if="notePickerOpen"
      :max="5"
      title="引用笔记"
      :value="noteIds"
      @picked="onNotesPicked"
      @close="notePickerOpen = false"
    />
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import { apiBase, apiUrl } from '@/utils/base-path';
import Segmented from '@/components/Segmented.vue';
import AttachmentChips from '@/components/AttachmentChips.vue';
import CloudPicker from '@/components/CloudPicker.vue';
import NotePicker from '@/components/NotePicker.vue';
import { renderMarkdown, renderStream, ensureKatexIdle, onKatexReady } from '@/utils/markdown';
import { createStreamPainter } from '@/utils/stream-paint';
import { appendStreamCaret } from '@/utils/stream-caret';
import { readSseStream, postStream } from '@/utils/sse';
import { readStudentPrefs } from '@/utils/student-prefs';
import streamSession from '@/utils/stream-session';
import waiting from '@/mixins/waiting';
import streamFrame from '@/mixins/streamFrame';
import orientation from '@/mixins/orientation';
import ModelSelect from '@/components/ModelSelect.vue';
import noteRefs from '@/mixins/note-refs';
import mermaidCharts from '@/mixins/mermaid';

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
  components: { AppNav, Segmented, AttachmentChips, CloudPicker, NotePicker, ModelSelect },
  mixins: [waiting, streamFrame, orientation, noteRefs, mermaidCharts],
  data: function() {
    return {
      mode: 'generate',
      language: 'zh',
      genre: '',
      style: '',
      wordLimit: '',
      draft: '',
      result: '',
      // 预渲染的 HTML（流式时按帧节流更新），见 mixins/streamFrame
      resultHtml: '',
      // 流式增量渲染的冻结段（见 utils/stream-paint）。
      // 必须在这里声明：Vue 2 不追踪后加的属性，运行期再赋值视图不会更新。
      resultHtmlFrozen: '',
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
      // isPortrait / useDrawer / drawerOpen / drawerDragX 由 mixins/orientation 提供
      // 学生往上翻着看时不要继续把他拽回底部；回到贴底才恢复自动跟随
      atBottom: true,
      // 用户主动点了停止
      stopped: false
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
      this.setResult('');
      this.streamError = '';
      this.openedId = 0;
      this.conversationId = '';
      this.saved = false;
    }
  },
  mounted: function() {
    // katex 按需加载 + 就绪重绘（与 Chat 同一套，见 markdown.js 的说明）：
    // 打开历史作文可能在引擎就绪前渲染，到货时把占位换成真公式
    var self = this;
    ensureKatexIdle();
    onKatexReady(function () { if (self.result) self.resultHtml = renderMarkdown(self.result); });
    // 方向与抽屉手势由 mixins/orientation 统一处理
    this.$store.dispatch('auth/fetchWallet').catch(function() {});
    this.loadModels();
    this.loadPieces();
    // 后台可能还挂着一轮生成（学生切走过又回来）：挂上去就能接着看
    streamSession.attach('writing', this);
  },
  beforeDestroy: function() {
    // ⚠️ 这里**绝不** abort 在途请求 —— 切页面不等于不想生成了。
    // 请求交给 utils/stream-session 在后台继续消费，回来 attach 时接着显示。
    // 只有学生主动点「停止生成」才真的掐断（见 stop）。
    streamSession.detach(this);
    this.destroyed = true;
  },
  methods: {
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

    // 正文的唯一写入点：result 与 resultHtml 必须**一起**改。
    //
    // 为什么要收口：模板渲染的是 resultHtml（预计算好的 HTML，为了避免
    // 每次重渲染都重新解析一遍 Markdown），而 result 是原始文本。
    // 两者分开写就一定会漏 —— 之前的 bug 就是 openPiece 只写了 result，
    // 点开历史作文时页面还停在上一次的 resultHtml 上，看起来"没切换"。
    // 流式路径不走这里（它按帧节流写，见 paint），但同样遵守这条不变量。
    setResult: function(text) {
      this.result = text == null ? '' : String(text);
      this.resultHtml = renderMarkdown(this.result);
      // 正文整体换掉了，增量渲染的冻结段作废（不清会与旧冻结段拼在一起）
      this.resultHtmlFrozen = '';
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
        // 必须走 setResult：只写 result 的话，模板渲染的 resultHtml 不会更新，
        // 点开历史作文就会"看起来没切换"（曾经的真实 bug）
        self.setResult(p.mode === 'grade' ? p.feedback : p.content);
        self.attachments = (p.image_hashes || []).map(function(h) {
          return { hash: h, name: h.slice(0, 8), kind: 'image', url: apiBase + '/cloud/files/' + h, thumb_url: apiBase + '/cloud/files/' + h + '?thumb=1' };
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
      this.$store.dispatch('confirm', {
        message: '确定删除这篇记录「' + (p.title || '未命名') + '」？删除后无法恢复。',
        confirmText: '删除',
        danger: true
      }).then(function(ok) {
        if (!ok) return;
        self.$http.delete('/writing/pieces/' + p.id).then(function(r) {
          if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
          self.pieces = self.pieces.filter(function(x) { return x.id !== p.id; });
          if (self.openedId === p.id) {
            self.openedId = 0;
            self.setResult('');
          }
        }).catch(function(err) {
          self.$store.dispatch('toast', { message: err.message || '删除失败', type: 'error' });
        });
      });
    },

    onPicked: function(files) {
      var self = this;
      this.attachments = files.slice(0, 4).map(function(f) {
        return {
          hash: f.hash, name: f.name, size: f.size, kind: 'image',
          url: f.url || (apiBase + '/cloud/files/' + f.hash),
          thumb_url: f.thumb_url || (apiBase + '/cloud/files/' + f.hash + '?thumb=1')
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
          url: f.url || (apiBase + '/cloud/files/' + f.hash),
          thumb_url: f.thumb_url || (apiBase + '/cloud/files/' + f.hash + '?thumb=1')
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
        self.atBottom = true;
      });
    },

    // 判断是否贴着底部：留 48px 容差，手指滑动时轻微偏移不该算"离开底部"
    onScrollResult: function() {
      var el = this.$refs.scroller;
      if (!el) return;
      this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    },

    // 中断当前生成：真正的收尾放在流式 promise 的 finally 里，这里只负责发出信号
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

    // 渲染当前正文。流式期间走轻量渲染（renderStream），
    // 结束 / 中断的收尾那次走完整渲染 —— 公式与图表必须在最后真出来。
    // result 与 resultHtml 必须**一起**改（见 setResult 的说明），这里是流式路径的唯一出口
    paintStream: function() {
      if (this.sending) {
        if (!this._painter) this._painter = createStreamPainter(renderStream);
        var out = this._painter.update(this.result);
        this.resultHtmlFrozen = out.frozen;
        this.resultHtml = appendStreamCaret(out.tail);
      } else {
        this._painter = null;
        this.resultHtmlFrozen = '';
        this.resultHtml = renderMarkdown(this.result);
      }
      if (this.atBottom) this.scrollResult();
    },

    // 后台会话每收到一个增量都会回调这里（组件已 detach 时不会回调）
    _onStreamSync: function() {
      if (!streamSession.isActive('writing')) return;
      var s = streamSession.getState();

      // 还没接过线（组件是重新挂载的）→ 先把正文补回来
      if (!this.streamAttached) {
        this.resumeStream();
        return;
      }
      this.result = s.text;
      this.sending = !s.done;
      // 恢复过来的组件没经历过"首字到达"那一刻（判定发生在旧组件里），补撤等待提示
      if (s.streaming && this.waitText) this.stopWaiting();
      this.scheduleFrame(this.paintStream);
    },

    // 从后台会话恢复。
    // 写作页没有"打开历史消息"这一步（记录走 /writing/pieces，与会话消息是两套存储），
    // 所以直接把累积的正文填回去即可。
    resumeStream: function() {
      var st = streamSession.getState();
      if (!streamSession.isActive('writing')) return;

      if (st.text && st.text.length > (this.result || '').length) this.result = st.text;
      this.streamAttached = true;
      this.sending = !st.done;
      this.stopped = false;
      this.paintStream();

      if (st.done) {
        // 后台已经生成完了：补一次钱包刷新，然后收摊
        this.$store.dispatch('auth/fetchWallet').catch(function() {});
        streamSession.end();
      } else {
        this.startWaiting(this.mode === 'grade' ? 'grade' : 'writing');
      }
    },

    start: function() {
      var self = this;
      if (!this.canSend) return;

      this.setResult('');
      this.streamError = '';
      this.visionStatus = '';
      this.saved = false;
      this.sending = true;
      this.stopped = false;
      this.atBottom = true;
      // 这一轮交给后台会话托管：切走页面时组件会被销毁，但生成不能断
      this.streamAttached = true;
      // 成文与批改都可能等很久，文案按场景分开（见 utils/waiting.js）
      this.startWaiting(this.mode === 'grade' ? 'grade' : 'writing');

      // 渲染 + 跟随滚动合并成一次"上色"，交给 rAF 节流（见 mixins/streamFrame）。
      // 收口到 paintStream —— 组件重新挂载、从后台会话恢复之后，同一个方法还能接着用
      var paint = function() { self.paintStream(); };

      var controller = new AbortController();
      this._abort = controller;
      streamSession.begin('writing', { conversationId: this.conversationId });
      streamSession.setController(controller);

      var url = apiUrl('writing/' + this.mode + '/stream');
      var body = {
        conversation_id: this.conversationId || '',
        model_id: this.modelId || '',
        language: this.language,
        genre: this.genre,
        style: this.style,
        word_limit: Number(this.wordLimit) || 0,
        topic: this.mode === 'grade' ? '' : this.draft.trim(),
        content: this.mode === 'grade' ? this.draft.trim() : '',
        image_hashes: this.attachmentHashes,
        note_ids: this.noteIds,
        // 学习偏好：每次发送时现读（学生在设置里改完立刻生效）。
        // 以前这里漏带 → 服务端 turn-runner 拿默认档，作文页成了唯一
        // 「设置了讲解风格/科目却完全不生效」的页面（对话/学习都带）。
        student_prefs: readStudentPrefs()
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
          onDelta: function(text) {
            // 第一个字一到就撤掉等待提示，别让它和正文并存
            if (self.waitText) self.stopWaiting();
            self.result += text;
            // 同步喂给后台会话：组件在不在都照样累积，切走回来才能接着看
            streamSession.feed(text, '');
            // 组件已销毁（学生切走了）→ 别再为看不见的 DOM 排渲染帧
            if (self.destroyed) return;
            // 合并到一帧渲染一次（见 mixins/streamFrame）
            self.scheduleFrame(paint);
          },
          onDone: function() {
            streamSession.finish();
            self.visionStatus = '';
            self.$store.dispatch('auth/fetchWallet').catch(function() {});
          },
          onError: function(message) {
            streamSession.finish(message);
            self.visionStatus = '';
            self.streamError = message || '生成失败，请重试';
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
          if (!self.result) self.setResult('（已停止生成）');
          streamSession.end();
          return;
        }
        if (!self.result && !self.streamError) {
          self.streamError = '未收到内容，请重试';
        }

        // 学生没切走（组件还活着）→ 这一轮已经展示完了，后台会话可以收摊。
        // 已经切走了就**不要**收 —— 留着它，回来还要接着看
        if (!self.destroyed) streamSession.end();
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
  /* 完全贴边：去掉固定留白，仅保留安全区边距（无刘海设备上为 0） */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  gap: var(--gap-md);
}
html.no-flex-gap .writing-page > * + * {
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
html.no-flex-gap .panel > * + * {
  margin-top: 8px;
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

/* 横屏矮屏：侧栏又窄又矮，参数面板（flex-shrink:0）会独吞高度，
   把「我的作文」历史列表压到只剩一两行 —— 实测 960×680 下列表仅 80px，
   等于打不开以前写过的作文。
   这里让两者一起参与高度分配：参数面板可收缩 + 内部滚动（它本来就是
   overflow-y:auto），历史面板保底一个能看清三项的高度。
   为什么写在组件里而不是 global.css：scoped 的 .panel/.hist-panel 带
   [data-v-x]，特异性高于全局同名规则，写外面会被压住。 */
@media (orientation: landscape) and (max-height: 800px) {
  .panel {
    flex: 0 1 auto;
    max-height: 55%;
  }
  .hist-panel {
    min-height: 172px;
  }
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
html.no-flex-gap .hist-item > * + * {
  margin-left: 6px;
}

@media (hover: hover) {
.hist-item:hover {
  background: var(--ink-2);
}
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
   判据用 @media (hover: none)，与 Chat.vue 的 .conv-del 同一套做法。 */
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

@media (hover: hover) {
.hist-del:hover {
  background: var(--danger-tint);
  color: var(--danger);
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
  font-size: clamp(15px, 12.2px + 0.3vw, 20px);
  line-height: 1;
  cursor: pointer;
}

@media (hover: hover) {
.icon-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}
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
html.no-flex-gap .editor-head, .result-head > * + * {
  margin-left: var(--gap-sm);
}

.editor-actions,
.result-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
html.no-flex-gap .editor-actions, .result-actions > * + * {
  margin-left: 6px;
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

/* 引用的笔记（与对话页/学习页同一套观感，改一处要一起改） */
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
html.no-flex-gap .editor-foot > * + * {
  margin-left: var(--gap-sm);
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

  .row-2 {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>