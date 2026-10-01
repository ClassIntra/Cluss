<template>
  <div class="chat-page">
    <AppNav
      active="chat"
      :show-menu-button="isPortrait"
      @toggle-sidebar="drawerOpen = !drawerOpen"
    />

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
          <!-- 额度卡 -->
          <div class="wallet-card glass">
            <div class="wallet-head">
              <span class="section-label">我的额度</span>
              <button class="icon-btn" title="刷新" @click="loadWallet">↻</button>
            </div>

            <div v-if="!wallet" class="muted tiny">读取中…</div>

            <template v-else>
              <div class="wallet-amount">
                <span class="wallet-symbol">¥</span>
                <span class="wallet-value" :class="{ 'wallet-empty': !wallet.is_allocated || availableValue <= 0 }">
                  {{ availableValue.toFixed(2) }}
                </span>
              </div>

              <div class="bar wallet-bar">
                <div class="bar-fill" :style="{ width: wallet.used_percent + '%' }"></div>
              </div>

              <div class="tiny muted">已用 ¥{{ wallet.used_yuan }} / 共 ¥{{ wallet.allocated_yuan }}</div>

              <div v-if="!wallet.is_allocated" class="alert alert-warning wallet-alert">
                尚未开通额度，请联系管理员充值
              </div>
              <div v-else-if="availableValue <= 0" class="alert alert-danger wallet-alert">
                余额已用完，请联系管理员充值
              </div>

              <div v-if="!wallet.weekly_unlimited" class="weekly">
                <div class="weekly-head">
                  <span class="tiny muted">本周额度</span>
                  <span class="tiny muted">剩 ¥{{ wallet.weekly_remaining_yuan }}</span>
                </div>
                <div class="bar weekly-bar">
                  <div class="bar-fill weekly-fill" :style="{ width: wallet.weekly_percent + '%' }"></div>
                </div>
              </div>
            </template>
          </div>

          <!-- 会话列表 -->
          <div class="conv-panel glass">
            <div class="conv-head">
              <span class="section-label">对话记录</span>
              <button class="icon-btn" title="新建对话" @click="newConversation">＋</button>
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
              :class="m.role === 'user' ? 'msg-user' : 'msg-assistant'"
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

                  <div v-if="m.role === 'assistant' && m.content" class="md-body" v-html="render(m.content)"></div>
                  <div
                    v-else-if="m.role === 'assistant' && m.stopped && !m.streaming"
                    class="stopped-hint"
                  >已停止生成</div>
                  <div v-else-if="m.role === 'user'" class="user-text">{{ m.content }}</div>
                  <span v-if="m.streaming" class="caret"></span>
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
              @click="scrollToBottom"
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
              <select v-model="modelId" class="model-select" :disabled="sending">
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

var CHIPS = {
  study: ['这道题的思路是什么？', '帮我检查一下我的解法', '只给提示，别给答案', '这个公式我没看懂'],
  daily: ['帮我解释一下这个概念', '这段代码哪里有问题', '帮我看看这篇作文', '做个一周复习计划']
};

export default {
  name: 'ChatView',
  components: { AppNav, ClussLogo, Segmented, AttachmentChips, CloudPicker },
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
      drawerOpen: false,
      isPortrait: false,
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
    availableValue: function() {
      return this.wallet ? Number(this.wallet.available_yuan || 0) : 0;
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
      if (!this.wallet.is_allocated) return '账号尚未开通额度，请联系管理员充值';
      if (this.availableValue <= 0) return '余额已用完，请联系管理员充值';
      return '说说你卡在哪一步…';
    },
    attachmentHashes: function() {
      return this.attachments.map(function(a) { return a.hash; });
    }
  },
  mounted: function() {
    this.checkOrientation();
    window.addEventListener('resize', this.checkOrientation);
    window.addEventListener('orientationchange', this.checkOrientation);

    this.$store.dispatch('auth/fetchProfile').catch(function() {});
    this.loadWallet();
    this.loadModels();
    this.loadConversations();
  },
  beforeDestroy: function() {
    window.removeEventListener('resize', this.checkOrientation);
    window.removeEventListener('orientationchange', this.checkOrientation);
    clearTimeout(this._copyTimer);
    if (this._abort) this._abort.abort();
  },
  methods: {
    checkOrientation: function() {
      this.isPortrait = window.innerHeight >= window.innerWidth;
      if (!this.isPortrait) this.drawerOpen = false;
    },

    render: function(text) { return renderMarkdown(text); },

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
        self.messages = (data.messages || []).map(function(m) {
          return {
            role: m.role, content: m.content, attachments: m.attachments || [], streaming: false
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

    scrollToBottom: function() {
      var self = this;
      this.$nextTick(function() {
        var el = self.$refs.scroller;
        if (el) el.scrollTop = el.scrollHeight;
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

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          self.markCopied(idx);
        }).catch(function() {
          self.fallbackCopy(text, idx);
        });
        return;
      }
      this.fallbackCopy(text, idx);
    },

    // 旧内核（部分平板 WebView）没有 navigator.clipboard，退回选中 + execCommand
    fallbackCopy: function(text, idx) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);

      if (ok) this.markCopied(idx);
      else this.$store.dispatch('toast', { message: '复制失败，请长按选中文本', type: 'error' });
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

      this.messages.push({ role: 'user', content: content, attachments: atts || [], streaming: false });
      var assistant = { role: 'assistant', content: '', attachments: [], streaming: true };
      this.messages.push(assistant);
      this.sending = true;
      this.scrollToBottom();

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
            assistant.content += text;
            // 用户上滚看历史时不抢滚动位置，只在底部时才跟随
            if (self.atBottom) self.scrollToBottom();
          },
          onDone: function(done) {
            assistant.streaming = false;
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

.body {
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  gap: var(--gap-md);
  flex: 1;
  min-height: 0;
}

/* 竖屏：侧栏变成抽屉，主区占满 */
.body.is-portrait {
  grid-template-columns: minmax(0, 1fr);
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  min-height: 0;
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

.wallet-amount {
  display: flex;
  align-items: baseline;
  gap: 3px;
}

.wallet-symbol {
  font-size: 15px;
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

.weekly-fill {
  background: linear-gradient(90deg, var(--purple-a), var(--purple));
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
  border-radius: 6px;
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

.mode-bar {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: 8px 12px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  flex-wrap: wrap;
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
  animation: msgIn 0.28s cubic-bezier(0.32, 0.72, 0, 1);
}

@keyframes msgIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
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

.bubble-assistant {
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-border);
  border-bottom-left-radius: 6px;
  box-shadow: var(--shadow-card);
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
  min-width: 56px;
}

.bubble-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.mini-attach {
  width: 56px;
  height: 56px;
  border-radius: 10px;
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

.composer {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 10px 10px 10px 12px;
  border-radius: var(--radius-xl);
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

.model-select {
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
</style>