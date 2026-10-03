<template>
  <div class="chat-page">
    <AppNav
      active="chat"
      :show-menu-button="useDrawer"
      @toggle-sidebar="toggleDrawer"
    />

    <transition name="fade">
      <div v-if="drawerOpen" class="app-drawer-mask" @click="closeDrawer"></div>
    </transition>

    <div class="body" :class="{ 'use-drawer': useDrawer }">
      <transition name="fade">
        <aside
          v-show="!useDrawer || drawerOpen"
          class="sidebar app-sidebar-drawer"
          :class="{ 'is-open': drawerOpen }"
          :style="drawerStyle"
        >
          <!-- 额度卡 -->
          <div class="wallet-card glass">
            <div class="wallet-head">
              <span class="section-label">我的额度</span>
              <button class="icon-btn" title="刷新" @click="loadWallet">↻</button>
            </div>

            <div v-if="!wallet" class="muted tiny">读取中…</div>

            <template v-else>
              <div class="wallet-amount">
                <span class="wallet-value" :class="{ 'wallet-empty': !wallet.is_allocated || availableValue <= 0 }">
                  {{ availableValue }}
                </span>
                <span class="wallet-unit">积分</span>
              </div>

              <!-- 进度条只在余量偏低时出现，且画的是**剩余**量。
                   反过来的做法（常驻、画已用量、从 0 涨到 100%）在心理学上是错的：
                   视觉上永远在"逼近上限"，每次打开对话页都在提醒学生"你在花钱"。
                   充裕时那条数字本身就够了，不需要额外的消耗暗示。 -->
              <div v-if="lowBalance" class="bar wallet-bar">
                <div class="bar-fill remaining-fill" :style="{ width: remainingPercent + '%' }"></div>
              </div>

              <!-- 说「额度」而不是「共」：可用值里含同步容错（防止别班刚充值、
                   本班还没同步到就误拒），偶尔会比额度略大。写「共」会读起来自相矛盾。 -->
              <div class="tiny muted">已用 {{ wallet.used_points }} 积分 · 额度 {{ wallet.allocated_points }} 积分</div>

              <div v-if="!wallet.is_allocated" class="alert alert-warning wallet-alert">
                还没有开通，请联系管理员充值
              </div>
              <div v-else-if="availableValue <= 0" class="alert alert-danger wallet-alert">
                积分已用完，请联系管理员充值
              </div>
              <!-- 提前预警，而不是等他被拦下才知道。
                   突如其来的拒绝会让人困惑甚至恼火；有余量时先打个招呼，
                   学生就能自己安排（预期效应）。语气刻意用 info 而非 danger ——
                   只是提醒，不是告警。 -->
              <div v-else-if="lowBalance" class="alert alert-info wallet-alert">
                积分不多了，用完前记得联系管理员
              </div>

              <!-- 周限额同理：只在快用完时出现。
                   常驻会持续提示"你被限额管着"，属于典型的心理抗拒触发点 ——
                   而周限额只是防滥用的护栏，不该成为每天挂在学生眼前的标语。 -->
              <div v-if="lowWeekly" class="weekly">
                <div class="weekly-head">
                  <span class="tiny muted">本周可用</span>
                  <span class="tiny muted">剩 {{ wallet.weekly_remaining_points }} 积分</span>
                </div>
                <div class="bar weekly-bar">
                  <div class="bar-fill weekly-fill" :style="{ width: weeklyRemainingPercent + '%' }"></div>
                </div>
              </div>
            </template>
          </div>

          <!-- 会话列表 -->
          <div class="conv-panel glass">
            <div class="conv-head">
              <span class="section-label">对话记录</span>
              <span class="conv-head-tools">
                <button
                  class="icon-btn"
                  title="复制整个对话（可粘贴到笔记）"
                  :disabled="!messages.length"
                  @click="exportConversation"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="4" y="4" width="12" height="12" rx="2" />
                    <rect x="8" y="8" width="12" height="12" rx="2" />
                  </svg>
                </button>
                <button class="icon-btn" title="新建对话" @click="newConversation">＋</button>
              </span>
            </div>
            <div class="conv-list">
              <div v-if="!conversations.length" class="conv-empty tiny muted">还没有对话</div>
              <div
                v-for="c in conversations"
                :key="c.id"
                class="conv-item"
                :class="{ active: c.id === conversationId }"
                @click="openConversation(c.id)"
              >
                <span class="conv-mode-dot" :class="'dot-' + (c.mode || 'study')" :title="modeLabel(c)"></span>
                <span class="conv-title">{{ c.title }}</span>
                <button class="conv-del" title="删除" @click.stop="removeConversation(c.id)">×</button>
              </div>
            </div>
          </div>
        </aside>
      </transition>

      <!-- 主区 -->
      <main class="main">
        <!-- 模式切换条 -->
        <div class="mode-bar glass">
          <Segmented v-model="mode" :options="modeOptions" />
          <Segmented
            v-if="mode === 'study'"
            v-model="studyStyle"
            :options="styleOptions"
          />
          <span class="mode-hint tiny muted">{{ modeHint }}</span>
        </div>

        <div class="messages-wrap">
          <div ref="scroller" class="messages" @scroll="onScroll">
            <div v-if="!messages.length" class="empty-state">
              <ClussLogo :size="52" />
              <h2 class="empty-title">{{ emptyTitle }}</h2>
              <p class="empty-sub">{{ emptySub }}</p>

              <div class="chips-wrap">
                <button
                  v-for="chip in currentChips"
                  :key="chip"
                  class="chip-suggest"
                  @click="useChip(chip)"
                >{{ chip }}</button>
              </div>
            </div>

            <div
              v-for="(m, idx) in messages"
              :key="idx"
              class="msg"
              :class="[m.role === 'user' ? 'msg-user' : 'msg-assistant', { 'is-enter': m.enter }]"
            >
              <div v-if="m.role === 'assistant'" class="msg-avatar">
                <ClussLogo :size="26" />
              </div>
              <div class="msg-col">
                <div class="bubble" :class="m.role === 'user' ? 'bubble-user' : 'bubble-assistant'">
                  <!-- 用户消息里带过的附件：只显示缩略图占位，不重新加载原图 -->
                  <div v-if="m.role === 'user' && m.attachments && m.attachments.length" class="bubble-attachments">
                    <div v-for="a in m.attachments" :key="a.hash" class="mini-attach">
                      <img
                        v-if="a.kind === 'image'"
                        class="mini-attach-img"
                        :src="'/api/cloud/files/' + a.hash + '?thumb=1'"
                        :alt="a.name"
                        loading="lazy"
                      />
                      <span v-else class="mini-attach-txt">TXT</span>
                    </div>
                  </div>

                  <!-- 渲染的是预计算好的 m.html，不是 render(m.content)。
                       在模板里调用渲染函数，意味着**任何**一次重渲染都会把所有历史消息
                       重新解析一遍（marked + KaTeX + DOMPurify），流式时每来一个字就全量重算，
                       几十条消息的会话直接卡死。改成只解析"变了的那一条"。 -->
                  <div v-if="m.role === 'assistant' && m.content" class="md-body" v-html="m.html"></div>
                  <!-- 还没出第一个字时给状态文字，而不是只留一个闪烁光标：
                       光标不说明任何事，等超过 8 秒学生就会以为卡死 -->
                  <div v-else-if="m.role === 'assistant' && m.streaming" class="waiting-hint">
                    <span class="waiting-dot" aria-hidden="true"></span>{{ waitText }}
                  </div>
                  <div
                    v-else-if="m.role === 'assistant' && m.stopped && !m.streaming"
                    class="stopped-hint"
                  >已停止生成</div>
                  <div v-else-if="m.role === 'user'" class="user-text">{{ m.content }}</div>
                  <span v-if="m.streaming && m.content" class="caret"></span>
                </div>

                <!-- 消息操作：恒显（平板没有 hover），靠低对比让位给正文 -->
                <div v-if="m.role === 'assistant' && (m.content || !m.streaming)" class="msg-tools">
                  <button v-if="m.content" class="tool-btn" @click="copyMessage(m.content, idx)">
                    {{ copiedKey === idx ? '已复制' : '复制' }}
                  </button>
                  <button
                    v-if="idx === messages.length - 1 && !sending"
                    class="tool-btn"
                    @click="regenerate"
                  >重新生成</button>
                </div>
              </div>
            </div>

            <div v-if="visionStatus" class="vision-status">
              <span class="spinner"></span>
              <span>{{ visionStatus }}</span>
            </div>

            <div v-if="streamError" class="stream-error alert alert-danger">
              <span>{{ streamError }}</span>
              <button class="btn btn-sm btn-ghost" @click="retry">重试</button>
            </div>
          </div>

          <transition name="fade">
            <button
              v-if="!atBottom && messages.length"
              class="scroll-bottom"
              type="button"
              @click="scrollToBottom(true)"
            >回到底部 ↓</button>
          </transition>
        </div>

        <!-- 输入区 -->
        <div class="composer-wrap">
          <AttachmentChips
            v-if="attachments.length"
            :items="attachments"
            @remove="removeAttachment"
          />

          <div class="composer glass">
            <button class="attach-btn" type="button" title="添加云盘附件" @click="pickerOpen = true">＋</button>

            <textarea
              ref="input"
              v-model="draft"
              class="composer-input"
              :placeholder="composerPlaceholder"
              :disabled="sending || !canAsk"
              rows="1"
              @keydown.enter.exact.prevent="send"
              @input="autoGrow"
            ></textarea>

            <div class="composer-actions">
              <!-- 只有一个可选模型时整个下拉没有意义（选谁都是它），
                   留着只会占地方，且没配模型时会缩成一条空缝 —— 直接不渲染。
                   学生只看到可用的模型（服务端已过滤），不会遇到"选中的这个不能用"。
                   不可用原因是给管理员看的，管理员仍能看到带后缀的完整列表。 -->
              <select
                v-if="models.length > 1"
                v-model="modelId"
                class="model-select"
                :disabled="sending"
                title="用哪个 AI 由管理员配置，一般不用改"
              >
                <option v-for="m in models" :key="m.id" :value="m.id" :disabled="!m.available">
                  {{ m.label }}{{ m.available ? '' : '（' + m.unavailable_reason + '）' }}
                </option>
              </select>

              <button
                class="btn send-btn"
                :class="sending ? 'btn-stop' : 'btn-primary'"
                :disabled="!sending && !canSend"
                @click="sending ? stop() : send()"
              >{{ sending ? '停止生成' : '发送' }}</button>
            </div>
          </div>

          <div class="composer-foot tiny muted">
            Enter 发送，Shift + Enter 换行 · 回答由 AI 生成，请自行核对
          </div>
        </div>
      </main>
    </div>

    <CloudPicker
      v-if="pickerOpen"
      :max="4"
      title="添加到对话"
      hint="可选图片与文本文件，最多 4 个"
      :value="attachmentHashes"
      @picked="onPicked"
      @close="pickerOpen = false"
    />
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import ClussLogo from '@/components/ClussLogo.vue';
import Segmented from '@/components/Segmented.vue';
import AttachmentChips from '@/components/AttachmentChips.vue';
import CloudPicker from '@/components/CloudPicker.vue';
import { renderMarkdown } from '@/utils/markdown';
import { readSseStream } from '@/utils/sse';
import waiting from '@/mixins/waiting';
import streamFrame from '@/mixins/streamFrame';
import orientation from '@/mixins/orientation';

var CHIPS = {
  study: ['这道题的思路是什么？', '帮我检查一下我的解法', '只给提示，别给答案', '这个公式我没看懂'],
  daily: ['帮我解释一下这个概念', '这段代码哪里有问题', '帮我看看这篇作文', '做个一周复习计划']
};

export default {
  name: 'ChatView',
  components: { AppNav, ClussLogo, Segmented, AttachmentChips, CloudPicker },
  mixins: [waiting, streamFrame, orientation],
  data: function() {
    return {
      conversations: [],
      conversationId: '',
      messages: [],
      models: [],
      modelId: '',
      draft: '',
      sending: false,
      streamError: '',
      visionStatus: '',
      pickerOpen: false,
      attachments: [],
      // isPortrait / useDrawer / drawerOpen / drawerDragX 由 mixins/orientation 提供
      // 用户是否停在底部：不在底部时不要硬把视图拽回去，否则他想翻记录会被打断
      atBottom: true,
      // 刚复制过的消息下标，用于把「复制」短暂变成「已复制」
      copiedKey: -1,
      // 用户主动点了停止
      stopped: false,
      // 会话模式
      mode: 'study',
      studyStyle: 'guided'
    };
  },
  computed: {
    user: function() { return this.$store.state.auth.user || {}; },
    wallet: function() { return this.$store.state.auth.wallet; },

    modeOptions: function() {
      return [
        { id: 'study', label: '学习', hint: '围绕解题，先引导再给答案' },
        { id: 'daily', label: '日常', hint: '通用助手：答疑、写作、编程等' }
      ];
    },
    styleOptions: function() {
      return [
        { id: 'guided', label: '引导我', hint: '分层给提示，我自己想' },
        { id: 'direct', label: '直接给答案', hint: '一次性给完整步骤与答案' }
      ];
    },
    modeHint: function() {
      if (this.mode === 'daily') return '通用学习助手，不主动出题';
      return this.studyStyle === 'direct' ? '直接给出完整步骤与答案' : '先给提示，逐步引导';
    },
    currentChips: function() {
      return CHIPS[this.mode] || CHIPS.study;
    },
    emptyTitle: function() {
      return this.mode === 'daily' ? '有什么想问的？' : '说说你卡在哪一步';
    },
    emptySub: function() {
      return this.mode === 'daily'
        ? '答疑、概念解释、写作、编程、翻译、资料整理都可以。'
        : (this.studyStyle === 'direct'
          ? '我会直接给出完整步骤与答案，并点明考点。'
          : '我不直接给答案，会先带你理清思路，再一步步给提示。');
    },
    // 学生端只看积分：整数、无货币符号，理解成"我还有多少可用"而不是"我在花钱"
    availableValue: function() {
      return this.wallet ? Number(this.wallet.available_points || 0) : 0;
    },
    // 余量是否偏低。判断依据刻意用「剩余」而不是「已用」：
    // 已用 70% 听起来像"消耗了不少"，剩余 30% 才是需要行动的信号。
    // 阈值 30% 是留出反应时间 —— 到 10% 才提醒，学生往往来不及处理。
    lowBalance: function() {
      if (!this.wallet || !this.wallet.is_allocated) return false;
      var total = Number(this.wallet.allocated_points || 0);
      if (total <= 0) return false;
      return this.availableValue / total <= 0.3;
    },
    remainingPercent: function() {
      if (!this.wallet) return 0;
      return Math.max(0, 100 - Number(this.wallet.used_percent || 0));
    },
    // 周限额是否接近用完（同样按「剩余」判断，阈值与总额度一致）
    lowWeekly: function() {
      if (!this.wallet || this.wallet.weekly_unlimited) return false;
      var quota = Number(this.wallet.weekly_quota_points || 0);
      if (quota <= 0) return false;
      return Number(this.wallet.weekly_remaining_points || 0) / quota <= 0.3;
    },
    weeklyRemainingPercent: function() {
      if (!this.wallet) return 0;
      return Math.max(0, 100 - Number(this.wallet.weekly_percent || 0));
    },
    canAsk: function() {
      if (!this.wallet) return true;
      return this.wallet.is_allocated && this.availableValue > 0;
    },
    canSend: function() {
      return !this.sending && (this.draft.trim().length > 0 || this.attachments.length > 0) && this.canAsk;
    },
    composerPlaceholder: function() {
      if (!this.wallet) return '说说你卡在哪一步…';
      if (!this.wallet.is_allocated) return '账号还没有开通，请联系管理员充值';
      if (this.availableValue <= 0) return '积分已用完，请联系管理员充值';
      return '说说你卡在哪一步…';
    },
    attachmentHashes: function() {
      return this.attachments.map(function(a) { return a.hash; });
    }
  },
  mounted: function() {
    // 方向与抽屉手势由 mixins/orientation 统一处理（三个页面共用）
    this.$store.dispatch('auth/fetchProfile').catch(function() {});
    this.loadWallet();
    this.loadModels();
    this.loadConversations();
  },
  beforeDestroy: function() {
    clearTimeout(this._copyTimer);
    // 等待提示的定时器与挂起的渲染帧分别由 mixins/waiting、mixins/streamFrame 清理
    if (this._abort) this._abort.abort();
  },
  methods: {

    modeLabel: function(c) {
      if (c.mode === 'daily') return '日常对话';
      return (c.study_style === 'direct' ? '学习·直答' : '学习·引导') + ' ' + c.title;
    },

    loadWallet: function() {
      return this.$store.dispatch('auth/fetchWallet').catch(function() {});
    },

    loadModels: function() {
      var self = this;
      return this.$http.get('/models').then(function(r) {
        if (r.data.code !== 200) return;
        self.models = r.data.data.models || [];
        if (!self.modelId) {
          self.modelId = r.data.data.default_model || (self.models[0] && self.models[0].id) || '';
        }
      }).catch(function() {});
    },

    loadConversations: function() {
      var self = this;
      return this.$http.get('/conversations', { params: { limit: 100 } }).then(function(r) {
        if (r.data.code !== 200) return;
        self.conversations = r.data.data.conversations || [];
      }).catch(function() {});
    },

    openConversation: function(id) {
      var self = this;
      if (id === this.conversationId) return;

      return this.$http.get('/conversations/' + id).then(function(r) {
        if (r.data.code !== 200) return;
        var data = r.data.data;
        self.conversationId = id;
        // html 一次性算好：这些消息之后不会再变，
        // 留在模板里每次重渲染都重解析才是真的贵
        self.messages = (data.messages || []).map(function(m) {
          return {
            role: m.role,
            content: m.content,
            html: m.role === 'assistant' ? renderMarkdown(m.content) : '',
            attachments: m.attachments || [],
            streaming: false,
            enter: false
          };
        });
        if (data.conversation) {
          if (data.conversation.model_id) self.modelId = data.conversation.model_id;
          // 打开历史会话时把模式同步过来，否则用户会以为当前模式已生效
          if (data.conversation.mode) self.mode = data.conversation.mode;
          if (data.conversation.study_style) self.studyStyle = data.conversation.study_style;
        }
        self.streamError = '';
        self.attachments = [];
        self.drawerOpen = false;
        self.scrollToBottom();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '打开失败', type: 'error' });
      });
    },

    newConversation: function() {
      this.conversationId = '';
      this.messages = [];
      this.streamError = '';
      this.attachments = [];
      this.drawerOpen = false;
      this.$nextTick(this.focusInput);
    },

    removeConversation: function(id) {
      var self = this;
      this.$http.delete('/conversations/' + id).then(function(r) {
        if (r.data.code !== 200) return;
        self.conversations = self.conversations.filter(function(c) { return c.id !== id; });
        if (self.conversationId === id) self.newConversation();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '删除失败', type: 'error' });
      });
    },

    useChip: function(text) {
      this.draft = text;
      this.$nextTick(this.focusInput);
    },

    onPicked: function(files) {
      // 合并去重：同一个文件不该在附件条里出现两次
      var existing = {};
      this.attachments.forEach(function(a) { existing[a.hash] = true; });
      var self = this;
      files.forEach(function(f) {
        if (!existing[f.hash] && self.attachments.length < 4) {
          self.attachments.push({
            hash: f.hash, name: f.name, size: f.size, kind: f.kind,
            url: f.url, thumb_url: f.thumb_url
          });
        }
      });
    },

    removeAttachment: function(hash) {
      this.attachments = this.attachments.filter(function(a) { return a.hash !== hash; });
    },

    focusInput: function() {
      if (this.$refs.input) this.$refs.input.focus();
    },

    autoGrow: function() {
      var el = this.$refs.input;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    },

    // smooth 只给"回到底部"按钮用。
    // 流式跟随必须用瞬跳 —— 平滑滚动是异步动画，新内容还在不断追加，
    // 会和动画互相追尾，越滚越落后。
    scrollToBottom: function(smooth) {
      var self = this;
      this.$nextTick(function() {
        var el = self.$refs.scroller;
        if (!el) return;
        if (smooth && el.scrollTo) {
          try { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }
          catch (e) { el.scrollTop = el.scrollHeight; }
        } else {
          el.scrollTop = el.scrollHeight;
        }
        self.atBottom = true;
      });
    },

    // 判断是否贴着底部：留 48px 容差，手指滑动时轻微偏移不该算"离开底部"
    onScroll: function() {
      var el = this.$refs.scroller;
      if (!el) return;
      this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    },

    copyMessage: function(text, idx) {
      var self = this;
      if (!text) return;
      this.copyText(text).then(function(ok) {
        if (ok) self.markCopied(idx);
        else self.$store.dispatch('toast', { message: '复制失败，请长按选中文本', type: 'error' });
      });
    },

    // 把当前会话的全部内容按"我 / AI"的格式拼成纯文本复制出去。
    // 学生想把讲解存进笔记软件，逐条复制太繁琐；这是唯一一次性的出口。
    exportConversation: function() {
      var self = this;
      if (!this.messages.length) return;

      var title = '';
      for (var i = 0; i < this.conversations.length; i++) {
        if (this.conversations[i].id === this.conversationId) {
          title = this.conversations[i].title;
          break;
        }
      }

      var lines = ['【Cluss 对话】' + (title || '未命名对话'), ''];
      this.messages.forEach(function(m) {
        if (!m.content) return;
        lines.push(m.role === 'user' ? '我：' + m.content : 'AI：' + m.content);
        lines.push('');
      });
      var text = lines.join('\n').trim();

      this.copyText(text).then(function(ok) {
        if (ok) self.$store.dispatch('toast', { message: '已复制对话全文，可粘贴到笔记', type: 'success' });
        else self.$store.dispatch('toast', { message: '复制失败，请重试', type: 'error' });
      });
    },

    // 统一的剪贴板出口：优先 navigator.clipboard，旧内核退回 execCommand。
    // resolve true = 成功；调用方决定给什么反馈
    copyText: function(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function() {
          return true;
        }).catch(function() {
          return fallbackCopy(text);
        });
      }
      return Promise.resolve(fallbackCopy(text));

      function fallbackCopy(t) {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        return ok;
      }
    },

    markCopied: function(idx) {
      var self = this;
      this.copiedKey = idx;
      clearTimeout(this._copyTimer);
      this._copyTimer = setTimeout(function() { self.copiedKey = -1; }, 1600);
    },

    // 中断当前生成：真正的收尾放在流式 promise 的 finally 里，这里只负责发出信号
    stop: function() {
      if (!this.sending) return;
      this.stopped = true;
      if (this._abort) this._abort.abort();
    },

    // 重来一轮：砍掉最后一个用户消息之后的所有内容，用同样的输入再跑一次
    regenerate: function() {
      if (this.sending) return;

      var lastUserIdx = -1;
      for (var i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx < 0) return;

      var lastUser = this.messages[lastUserIdx];
      this.messages = this.messages.slice(0, lastUserIdx);
      this.streamError = '';
      this.runTurn(lastUser.content, (lastUser.attachments || []).slice());
    },

    retry: function() {
      this.regenerate();
    },

    send: function() {
      if (!this.canSend) return;

      var content = this.draft.trim();
      var atts = this.attachments.slice();
      if (!content && !atts.length) return;

      this.draft = '';
      this.attachments = [];
      this.$nextTick(this.autoGrow);
      this.runTurn(content, atts);
    },

    // 一轮对话的完整编排：send 与 regenerate 共用，避免两处行为走偏
    runTurn: function(content, atts) {
      var self = this;

      this.streamError = '';
      this.visionStatus = '';
      this.stopped = false;

      // enter: 只有本轮新加的消息才播进场动画（历史消息不播，见样式里的说明）
      this.messages.push({
        role: 'user', content: content, attachments: atts || [], streaming: false, enter: true
      });
      // 助手消息不设 enter：它在原地"长出来"，出现这一步已经由等待提示承担了
      var assistant = { role: 'assistant', content: '', html: '', attachments: [], streaming: true };
      this.messages.push(assistant);
      this.sending = true;
      this.startWaiting('chat');
      this.scrollToBottom();

      // 渲染 + 跟随滚动合并成一次"上色"动作，交给 rAF 节流（见 mixins/streamFrame）
      var paint = function() {
        assistant.html = renderMarkdown(assistant.content);
        if (self.atBottom) self.scrollToBottom();
      };

      var controller = new AbortController();
      this._abort = controller;

      var headers = { 'Content-Type': 'application/json' };
      var token = this.$store.state.auth.token;
      if (token) headers['Authorization'] = 'Bearer ' + token;

      fetch('/api/chat/stream', {
        method: 'POST',
        headers: headers,
        credentials: 'same-origin',
        body: JSON.stringify({
          conversation_id: this.conversationId || '',
          content: content,
          model_id: this.modelId || '',
          mode: this.mode,
          study_style: this.studyStyle,
          attachment_hashes: (atts || []).map(function(a) { return a.hash; })
        }),
        signal: controller.signal
      }).then(function(resp) {
        if (!resp.ok) {
          return resp.json().then(function(body) {
            var err = new Error(body.message || '请求失败');
            err.status = resp.status;
            throw err;
          }).catch(function(e) {
            if (e.status) throw e;
            var err = new Error('请求失败（' + resp.status + '）');
            err.status = resp.status;
            throw err;
          });
        }

        return readSseStream(resp, {
          onMeta: function(meta) {
            if (meta.conversation_id) self.conversationId = meta.conversation_id;
          },
          onStatus: function(st) {
            if (st.stage === 'vision') self.visionStatus = st.message || '正在识别图片…';
            else if (st.stage === 'vision_done') self.visionStatus = '';
          },
          onDelta: function(text) {
            // 第一个字一到就撤掉等待提示，别让它和正文并存
            if (self.waitText) self.stopWaiting();
            assistant.content += text;
            // 交给 rAF 合并渲染与跟随滚动（见 mixins/streamFrame）
            self.scheduleFrame(paint);
          },
          onDone: function(done) {
            assistant.streaming = false;
            // 收尾补一次完整渲染：合并期间到达的最后几个字不能丢
            self.cancelFrame();
            paint();
            self.visionStatus = '';
            self.loadWallet();
            self.loadConversations();
            if (done && done.estimated) {
              self.$store.dispatch('toast', { message: '本次用量为估算值（上游未返回精确用量）', type: 'info' });
            }
          },
          onError: function(message) {
            assistant.streaming = false;
            self.visionStatus = '';
            self.streamError = message || '生成失败，请重试';
          }
        });
      }).catch(function(err) {
        assistant.streaming = false;
        self.visionStatus = '';
        if (err && err.name === 'AbortError') return;
        self.streamError = err.message || '网络异常，请重试';
        if (err && err.status === 402) self.loadWallet();
      }).then(function() {
        self.sending = false;
        self._abort = null;
        // 无论成功、报错还是中断，都要撤掉等待提示，并把渲染补完
        self.stopWaiting();
        self.cancelFrame();
        paint();

        if (self.stopped) {
          self.stopped = false;
          // 主动停止：留着这条空回复并做标记，用户还能直接「重新生成」，
          // 直接删掉的话只剩一条用户消息，没有入口可以重来。
          assistant.stopped = true;
          return;
        }
        if (!assistant.content && !self.streamError) {
          self.streamError = '未收到回复内容，请重试';
        }
      });
    }
  }
};
</script>

<style scoped>
.chat-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  padding: var(--gap-md);
  gap: var(--gap-md);
}
html.no-flex-gap .chat-page > * + * {
  margin-top: var(--gap-md);
}

.body {
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  gap: var(--gap-md);
  flex: 1;
  min-height: 0;
}

/* 抽屉模式：侧栏脱离栅格，主区占满 */
.body.use-drawer {
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

/* ---------- 额度卡 ---------- */
.wallet-card {
  padding: 16px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.wallet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.icon-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-xs);
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

.wallet-amount {
  display: flex;
  align-items: baseline;
  gap: 3px;
}
html.no-flex-gap .wallet-amount > * + * {
  margin-left: 3px;
}

/* 单位跟在数字后面（中文习惯：2000 积分），比前缀的 ¥ 更像"余量"而不是"标价" */
.wallet-unit {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.wallet-value {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.wallet-empty {
  color: var(--danger);
}

.wallet-bar {
  margin: 10px 0 6px;
}

/* 余量条用暖色：它只在余量偏低时出现，颜色与"该留意了"的语义一致。
   默认的蓝色渐变是"中性进度"的语言，放在这里会削弱提醒力度。 */
.remaining-fill {
  background: linear-gradient(90deg, var(--warning), var(--danger-grad-a));
}

.wallet-alert {
  margin-top: 10px;
  font-size: 12.5px;
}

.weekly {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--ink-2);
}

.weekly-head {
  display: flex;
  justify-content: space-between;
}

.weekly-bar {
  margin-top: 6px;
  height: 5px;
}

/* 同样只在快用完时出现，用与余额条一致的暖色：两种"紧张"用同一套视觉语言，
   学生不需要分辨紫色和琥珀色分别代表什么。 */
.weekly-fill {
  background: linear-gradient(90deg, var(--warning), var(--danger-grad-a));
}

/* ---------- 会话列表 ---------- */
.conv-panel {
  display: flex;
  flex-direction: column;
  padding: 16px;
  border-radius: var(--radius-lg);
  flex: 1;
  min-height: 0;
}

.conv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  flex-shrink: 0;
}

.conv-head-tools {
  display: flex;
  align-items: center;
  gap: 4px;
}
html.no-flex-gap .conv-head-tools > * + * {
  margin-left: 4px;
}
/* 导出按钮的线性图标：跟随 currentColor，与文字类图标按钮（＋ ↻ ×）同灰度 */
.icon-btn svg {
  display: block;
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.conv-list {
  overflow-y: auto;
  flex: 1;
  margin: 0 -6px;
}

.conv-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  margin-bottom: 2px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  /* 按下是即时的（见 global.css 的触屏手感段），松开要柔和回落 */
  transition: background var(--transition);
}
html.no-flex-gap .conv-item > * + * {
  margin-left: 6px;
}

.conv-item:hover {
  background: var(--ink-1);
}

.conv-item.active {
  background: var(--accent-soft);
}

.conv-mode-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-study {
  background: var(--accent);
}

.dot-daily {
  background: var(--purple);
}

.conv-title {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-item.active .conv-title {
  color: var(--accent);
  font-weight: 500;
}

.conv-del {
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
}

.conv-item:hover .conv-del {
  opacity: 1;
}

.conv-del:hover {
  background: var(--danger-tint);
  color: var(--danger);
}

.conv-empty {
  padding: 12px 10px;
  text-align: center;
}

/* ---------- 主区 ---------- */
.main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: var(--gap-sm);
}
html.no-flex-gap .main > * + * {
  margin-top: var(--gap-sm);
}

.mode-bar {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: 8px 12px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  flex-wrap: wrap;
}
html.no-flex-gap .mode-bar > * + * {
  margin-left: var(--gap-sm);
}

.mode-hint {
  margin-left: auto;
  white-space: nowrap;
}

/* 滚动容器 + 浮在右下角的「回到底部」按钮，两者必须同处一个定位上下文 */
.messages-wrap {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 2px 2px 6px;
  min-height: 0;
}

.scroll-bottom {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  padding: 6px 15px;
  border: 1px solid var(--menu-border);
  border-radius: var(--radius-pill);
  background: var(--menu-bg);
  box-shadow: var(--shadow-float);
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text-secondary);
  cursor: pointer;
  z-index: 5;
  transition: color var(--transition), border-color var(--transition);
}

.scroll-bottom:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  padding: 30px 20px;
}

.empty-title {
  margin: 14px 0 6px;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.empty-sub {
  margin: 0;
  max-width: 460px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.chips-wrap {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: var(--gap-md);
  max-width: 540px;
}
html.no-flex-gap .chips-wrap > * + * {
  margin-left: 8px;
}

.chip-suggest {
  padding: 8px 14px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-pill);
  background: var(--glass-bg);
  font-size: 12.5px;
  font-family: inherit;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--transition), color var(--transition);
}

.chip-suggest:hover {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}

.msg {
  display: flex;
  gap: 10px;
  margin-bottom: var(--gap-md);
}
html.no-flex-gap .msg > * + * {
  margin-left: 10px;
}

/* 进场动画**只给本轮新增的消息**（.is-enter）。
   原来的写法让所有消息都带 animation，打开历史会话时几十条一起动 ——
   既嘈杂（一次涌出几十条）又浪费（低端机上几十个合成层同时动）。
   历史消息是从库里读出来的既有内容，不该"表演一次出场"。 */
.msg.is-enter {
  animation: msgIn var(--dur-slow) var(--ease-out);
}

/* 用户消息从右侧来、助手消息从下方来：方向本身在提示"这是谁说的" */
.msg-user.is-enter {
  animation-name: msgInRight;
}

@keyframes msgIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes msgInRight {
  from { opacity: 0; transform: translateX(12px); }
  to { opacity: 1; transform: translateX(0); }
}

.msg-user {
  justify-content: flex-end;
}

.msg-avatar {
  flex-shrink: 0;
  margin-top: 2px;
}

/* 气泡 + 操作条的竖排容器。
   宽度上限放在这一层（而不是气泡上），因为气泡在竖排里会按内容收缩，
   百分比上限如果挂在气泡上会参照自身宽度，算不出稳定结果。 */
.msg-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  max-width: min(760px, 84%);
}
html.no-flex-gap .msg-col > * + * {
  margin-top: 6px;
}

.msg-user .msg-col {
  align-items: flex-end;
}

.msg-assistant .msg-col {
  align-items: flex-start;
}

/* 操作条恒显：平板没有 hover，藏起来就等于没有这个功能。
   靠低透明度让位给正文，指到或点到时再提亮。 */
.msg-tools {
  display: flex;
  gap: 6px;
  opacity: 0.5;
  transition: opacity var(--transition);
}
html.no-flex-gap .msg-tools > * + * {
  margin-left: 6px;
}

.msg:hover .msg-tools,
.msg-tools:focus-within {
  opacity: 1;
}

.tool-btn {
  padding: 3px 10px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-pill);
  background: transparent;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: color var(--transition), border-color var(--transition), background var(--transition);
}

.tool-btn:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

/* 竖屏触控：复制 / 重新生成在平板上是纯触摸操作，
   3px 内边距的点击面积太小，放宽到一指高度；
   气泡同步放宽（必须写在本组件里才能盖过上面的 max-width: 100%，
   放在 global.css 里会被这里的 scoped 规则压住，是条死规则）。
   判据用 html.is-portrait（设备方向）而不是媒体查询（视口比例）：
   弹键盘会把视口压成横向比例，媒体查询会在打字中途突然回跳 */
html.is-portrait .tool-btn {
  padding: 8px 14px;
  font-size: 12.5px;
}

html.is-portrait .bubble {
  max-width: 92%;
}

.bubble {
  max-width: 100%;
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  font-size: 14px;
  line-height: 1.7;
}

.bubble-user {
  background: var(--accent);
  color: var(--text-invert);
  border-bottom-right-radius: 6px;
  box-shadow: 0 8px 20px var(--accent-glow);
}

/* 助手气泡**刻意不用 backdrop-filter**。
   它在消息列表里，一段对话可能几十个 —— 每个气泡都是一层实时模糊，
   滚动时全部要重新采样背景，低端平板必然掉帧。
   气泡背景本来就接近不透明（--glass-bg-strong 是 0.88~0.9），
   去掉模糊视觉上几乎看不出，但滚动会明显顺很多。
   规则：**列表内的元素不用背景模糊**，这是结构性的决定，不是性能开关。 */
.bubble-assistant {
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-border);
  border-bottom-left-radius: 6px;
  box-shadow: var(--shadow-card);
  min-width: 56px;
}

.bubble-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
html.no-flex-gap .bubble-attachments > * + * {
  margin-left: 6px;
}

.mini-attach {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--surface-on-accent);
}

.mini-attach-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.mini-attach-txt {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-invert);
}

.user-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.stopped-hint {
  color: var(--text-tertiary);
  font-size: 13px;
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

.vision-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 auto var(--gap-sm);
  padding: 8px 14px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
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

.stream-error {
  margin: 0 auto var(--gap-sm);
  max-width: 620px;
  justify-content: space-between;
}

/* ---------- 输入区 ---------- */
.composer-wrap {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
html.no-flex-gap .composer-wrap > * + * {
  margin-top: 8px;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 10px 10px 10px 12px;
  border-radius: var(--radius-xl);
}
html.no-flex-gap .composer > * + * {
  margin-left: 10px;
}

.attach-btn {
  width: 34px;
  height: 34px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

.attach-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.composer-input {
  flex: 1;
  /* 允许被压缩：否则 textarea 的固有宽度会把右侧的模型选择框挤出画面 */
  min-width: 0;
  max-height: 160px;
  padding: 6px 0;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--text-primary);
  resize: none;
  outline: none;
}

.composer-input::placeholder {
  color: var(--text-tertiary);
}

.composer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
html.no-flex-gap .composer-actions > * + * {
  margin-left: 8px;
}

.model-select {
  min-width: 96px;
  max-width: 170px;
  padding: 8px 10px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text-secondary);
  outline: none;
  cursor: pointer;
}

.send-btn {
  padding: 10px 20px;
}

.composer-foot {
  text-align: center;
}

@media (max-width: 900px) {
  .mode-hint {
    display: none;
  }

  .model-select {
    max-width: 120px;
  }
}

/* 极矮屏（960×680 横屏）：把非内容区的垂直占用再压一档，
   省下来的高度全给消息区。顶栏与输入框一旦吃掉大半屏，
   一次回答就只剩三四行可见，学生只能不停滚动。 */
@media (orientation: landscape) and (max-height: 700px) {
  .mode-bar {
    padding: 6px 10px;
  }

  .composer {
    padding: 8px 8px 8px 10px;
  }

  .empty-state {
    padding: 16px 20px;
  }

  .empty-title {
    margin: 10px 0 4px;
    font-size: 19px;
  }

  .chips-wrap {
    margin-top: var(--gap-sm);
  }

  .msg {
    margin-bottom: var(--gap-sm);
  }
}
</style>