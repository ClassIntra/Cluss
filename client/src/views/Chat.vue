<template>
  <div class="chat-page">
    <!-- 顶部导航 -->
    <header class="topbar glass">
      <div class="topbar-left">
        <ClussLogo :size="34" />
        <div class="brand-text">
          <div class="brand-name">Cluss</div>
          <div class="brand-sub">引导式 AI 解题</div>
        </div>
      </div>

      <nav class="topbar-nav">
        <span class="nav-item active">对话</span>
        <router-link v-if="isAdmin" class="nav-item" to="/admin">管理台</router-link>
      </nav>

      <div class="topbar-right">
        <div class="user-chip" v-click-outside="closeMenu" @click="menuOpen = !menuOpen">
          <div class="avatar">{{ avatarChar }}</div>
          <div class="user-meta">
            <div class="user-name">{{ displayName }}</div>
            <div class="user-sub">{{ user.user_id }}{{ user.class_no ? ' · ' + user.class_no + '班' : '' }}</div>
          </div>
          <transition name="fade">
            <div v-if="menuOpen" class="user-menu glass" @click.stop>
              <div class="menu-head">
                <div class="menu-name">{{ user.real_name }}</div>
                <div class="menu-sub">用户名：{{ user.net_name }}</div>
                <div v-if="user.source === 'classintra'" class="menu-badge">来自 ClassIntra</div>
              </div>
              <button class="menu-item" @click="logout">退出登录</button>
            </div>
          </transition>
        </div>
      </div>
    </header>

    <div class="body">
      <!-- 左侧：额度 + 会话列表 -->
      <aside class="sidebar">
        <!-- 额度卡片 -->
        <div class="wallet-card glass">
          <div class="wallet-head">
            <span class="section-label">我的额度</span>
            <button class="icon-btn" title="刷新" @click="loadWallet">↻</button>
          </div>

          <div v-if="!wallet" class="wallet-loading muted tiny">读取中…</div>

          <template v-else>
            <div class="wallet-amount">
              <span class="wallet-symbol">¥</span>
              <span class="wallet-value" :class="{ 'wallet-empty': !wallet.is_allocated || availableValue <= 0 }">
                {{ availableValue.toFixed(2) }}
              </span>
            </div>

            <div class="wallet-bar">
              <div class="wallet-bar-fill" :style="{ width: wallet.used_percent + '%' }"></div>
            </div>

            <div class="wallet-meta">
              <span class="tiny muted">已用 ¥{{ wallet.used_yuan }} / 共 ¥{{ wallet.allocated_yuan }}</span>
            </div>

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
              <div class="wallet-bar weekly-bar">
                <div class="wallet-bar-fill weekly-fill" :style="{ width: wallet.weekly_percent + '%' }"></div>
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
              <span class="conv-title">{{ c.title }}</span>
              <button class="conv-del" title="删除" @click.stop="removeConversation(c.id)">×</button>
            </div>
          </div>
        </div>
      </aside>

      <!-- 中部：对话区 -->
      <main class="main">
        <div ref="scroller" class="messages">
          <!-- 空态：产品定位与引导语 -->
          <div v-if="!messages.length" class="empty-state">
            <ClussLogo :size="56" />
            <h2 class="empty-title">说说你卡在哪一步</h2>
            <p class="empty-sub">
              我不直接给答案，会先带你理清思路，再一步步给提示。<br />
              可以把题目、你的解法或困惑直接发给我。
            </p>

            <div class="chips">
              <button
                v-for="chip in chips"
                :key="chip"
                class="chip"
                @click="useChip(chip)"
              >{{ chip }}</button>
            </div>
          </div>

          <!-- 消息列表 -->
          <div
            v-for="(m, idx) in messages"
            :key="idx"
            class="msg"
            :class="m.role === 'user' ? 'msg-user' : 'msg-assistant'"
          >
            <div v-if="m.role === 'assistant'" class="msg-avatar">
              <ClussLogo :size="28" />
            </div>
            <div class="bubble" :class="m.role === 'user' ? 'bubble-user' : 'bubble-assistant'">
              <div v-if="m.role === 'assistant'" class="md-body" v-html="render(m.content)"></div>
              <div v-else class="user-text">{{ m.content }}</div>
              <span v-if="m.streaming" class="caret"></span>
            </div>
          </div>

          <!-- 出错提示：不遮挡内容，允许重试 -->
          <div v-if="streamError" class="stream-error alert alert-danger">
            <span>{{ streamError }}</span>
            <button class="btn btn-sm btn-ghost" @click="retry">重试</button>
          </div>
        </div>

        <!-- 输入区 -->
        <div class="composer-wrap">
          <div class="composer glass">
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
                class="btn btn-primary send-btn"
                :disabled="!canSend"
                @click="send"
              >
                {{ sending ? '生成中…' : '发送' }}
              </button>
            </div>
          </div>

          <div class="composer-foot tiny muted">
            Enter 发送，Shift + Enter 换行 · 回答由 AI 生成，请自行核对
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<script>
import ClussLogo from '@/components/ClussLogo.vue';
import { renderMarkdown } from '@/utils/markdown';

var CHIPS = [
  '这道题的思路是什么？',
  '帮我检查一下我的解法',
  '只给提示，别给答案',
  '这个公式我没看懂'
];

export default {
  name: 'ChatView',
  components: { ClussLogo },
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
      lastFailed: null,
      menuOpen: false,
      chips: CHIPS
    };
  },
  computed: {
    user: function() {
      return this.$store.state.auth.user || {};
    },
    wallet: function() {
      return this.$store.state.auth.wallet;
    },
    isAdmin: function() {
      return this.$store.getters['auth/isAdmin'];
    },
    displayName: function() {
      return this.user.real_name || this.user.net_name || '同学';
    },
    avatarChar: function() {
      var name = String(this.user.real_name || this.user.net_name || '?');
      return name.slice(0, 1);
    },
    availableValue: function() {
      if (!this.wallet) return 0;
      return Number(this.wallet.available_yuan || 0);
    },
    canAsk: function() {
      // 未开通额度或余额为负时，禁用输入并给出明确指引（前端体验层拦截，
      // 后端仍会独立校验一次，前端这道只是让用户不必白等一次请求）
      if (!this.wallet) return true;
      return this.wallet.is_allocated && this.availableValue > 0;
    },
    canSend: function() {
      return !this.sending && this.draft.trim().length > 0 && this.canAsk;
    },
    composerPlaceholder: function() {
      if (!this.wallet) return '说说你卡在哪一步…';
      if (!this.wallet.is_allocated) return '账号尚未开通额度，请联系管理员充值';
      if (this.availableValue <= 0) return '余额已用完，请联系管理员充值';
      return '说说你卡在哪一步…';
    }
  },
  mounted: function() {
    this.$store.dispatch('auth/fetchProfile').catch(function() {});
    this.loadWallet();
    this.loadModels();
    this.loadConversations();
  },
  beforeDestroy: function() {
    if (this._abort) this._abort.abort();
  },
  methods: {
    render: function(text) {
      return renderMarkdown(text);
    },

    loadWallet: function() {
      return this.$store.dispatch('auth/fetchWallet').catch(function() {});
    },

    loadModels: function() {
      var self = this;
      return this.$http.get('/models').then(function(resp) {
        if (resp.data.code !== 200) return;
        var data = resp.data.data;
        self.models = data.models || [];
        if (!self.modelId) {
          self.modelId = data.default_model || (self.models[0] && self.models[0].id) || '';
        }
      }).catch(function() {});
    },

    loadConversations: function() {
      var self = this;
      return this.$http.get('/conversations').then(function(resp) {
        if (resp.data.code !== 200) return;
        self.conversations = resp.data.data.conversations || [];
      }).catch(function() {});
    },

    openConversation: function(id) {
      var self = this;
      if (id === this.conversationId) return;

      return this.$http.get('/conversations/' + id).then(function(resp) {
        if (resp.data.code !== 200) return;
        var data = resp.data.data;
        self.conversationId = id;
        self.messages = (data.messages || []).map(function(m) {
          return { role: m.role, content: m.content, streaming: false };
        });
        if (data.conversation && data.conversation.model_id) {
          self.modelId = data.conversation.model_id;
        }
        self.streamError = '';
        self.scrollToBottom();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '打开失败', type: 'error' });
      });
    },

    newConversation: function() {
      this.conversationId = '';
      this.messages = [];
      this.streamError = '';
      this.$nextTick(this.focusInput);
    },

    removeConversation: function(id) {
      var self = this;
      this.$http.delete('/conversations/' + id).then(function(resp) {
        if (resp.data.code !== 200) return;
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

    focusInput: function() {
      if (this.$refs.input) this.$refs.input.focus();
    },

    autoGrow: function() {
      var el = this.$refs.input;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    },

    scrollToBottom: function() {
      var self = this;
      this.$nextTick(function() {
        var el = self.$refs.scroller;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    retry: function() {
      if (!this.lastFailed) return;
      this.streamError = '';
      this.draft = this.lastFailed;
      this.send();
    },

    logout: function() {
      var self = this;
      this.$store.dispatch('auth/logout').then(function() {
        self.$router.replace('/login');
      });
    },

    closeMenu: function() {
      this.menuOpen = false;
    },

    // 流式发送：用 fetch 手工解析 SSE（axios 在浏览器端拿不到增量）
    send: function() {
      var self = this;
      if (!this.canSend) return;

      var content = this.draft.trim();
      if (!content) return;

      this.draft = '';
      this.$nextTick(this.autoGrow);
      this.streamError = '';
      this.lastFailed = content;

      this.messages.push({ role: 'user', content: content, streaming: false });
      var assistant = { role: 'assistant', content: '', streaming: true };
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
          model_id: this.modelId || ''
        }),
        signal: controller.signal
      }).then(function(resp) {
        // 非流式错误（402 额度不足 / 503 未配置 / 401 失效等）
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
        return readStream(resp, {
          onMeta: function(meta) {
            if (meta.conversation_id) {
              self.conversationId = meta.conversation_id;
            }
          },
          onDelta: function(text) {
            assistant.content += text;
            self.scrollToBottom();
          },
          onDone: function(done) {
            assistant.streaming = false;
            self.lastFailed = null;
            self.loadWallet();
            self.loadConversations();
            if (done && done.estimated) {
              self.$store.dispatch('toast', { message: '本次用量为估算值（上游未返回精确用量）', type: 'info' });
            }
          },
          onError: function(message) {
            assistant.streaming = false;
            self.streamError = message || '生成失败，请重试';
          }
        });
      }).catch(function(err) {
        assistant.streaming = false;
        // 用户主动中断（切换会话等）不报错
        if (err && err.name === 'AbortError') return;
        self.streamError = err.message || '网络异常，请重试';
        // 额度不足时刷新余额卡，让学生立刻看到原因
        if (err && err.status === 402) self.loadWallet();
      }).then(function() {
        self.sending = false;
        self._abort = null;
        // 空回复且无错误：给出兜底提示，避免出现空白气泡
        if (!assistant.content && !self.streamError) {
          self.streamError = '未收到回复内容，请重试';
        }
      });
    }
  }
};

// SSE 解析：按 \n\n 分帧，逐行读 event / data
function readStream(resp, handlers) {
  var reader = resp.body.getReader();
  var decoder = new TextDecoder('utf-8');
  var buffer = '';

  function handleFrame(frame) {
    var lines = frame.split('\n');
    var event = 'message';
    var dataLines = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('event:') === 0) event = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;

    var payload;
    try { payload = JSON.parse(dataLines.join('\n')); } catch (e) { return; }

    if (event === 'meta' && handlers.onMeta) handlers.onMeta(payload);
    else if (event === 'delta' && handlers.onDelta) handlers.onDelta(payload.text || '');
    else if (event === 'done' && handlers.onDone) handlers.onDone(payload);
    else if (event === 'error' && handlers.onError) handlers.onError(payload.message);
  }

  function pump() {
    return reader.read().then(function(result) {
      if (result.done) {
        if (buffer.trim()) handleFrame(buffer);
        return;
      }
      buffer += decoder.decode(result.value, { stream: true });
      var frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].trim()) handleFrame(frames[i]);
      }
      return pump();
    });
  }

  return pump();
}
</script>

<style scoped>
.chat-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: var(--gap-md);
  gap: var(--gap-md);
}

/* ---------- 顶栏 ---------- */
.topbar {
  display: flex;
  align-items: center;
  gap: var(--gap-lg);
  padding: 12px 20px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-name {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.2;
}

.brand-sub {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.topbar-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.nav-item {
  padding: 7px 16px;
  border-radius: var(--radius-pill);
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-secondary);
  text-decoration: none;
  transition: background var(--transition), color var(--transition);
}

.nav-item.active,
.nav-item:hover {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}

.topbar-right {
  margin-left: var(--gap-md);
}

.user-chip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px 6px 6px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: background var(--transition);
}

.user-chip:hover {
  background: var(--glass-bg-strong);
}

.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: linear-gradient(140deg, #5b9bff, #2f6bdd);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.user-name {
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.25;
}

.user-sub {
  font-size: 11.5px;
  color: var(--text-tertiary);
  line-height: 1.25;
}

.user-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 200px;
  padding: 14px;
  border-radius: var(--radius-lg);
  z-index: 50;
}

.menu-head {
  padding-bottom: 10px;
  margin-bottom: 8px;
  border-bottom: 1px solid rgba(31, 41, 72, 0.08);
}

.menu-name {
  font-size: 14px;
  font-weight: 600;
}

.menu-sub {
  font-size: 12px;
  color: var(--text-tertiary);
}

.menu-badge {
  display: inline-block;
  margin-top: 6px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
}

.menu-item {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 13.5px;
  font-family: inherit;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.menu-item:hover {
  background: rgba(214, 69, 69, 0.1);
  color: var(--danger);
}

/* ---------- 主体 ---------- */
.body {
  display: grid;
  grid-template-columns: 296px minmax(0, 1fr);
  gap: var(--gap-md);
  flex: 1;
  min-height: 0;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  min-height: 0;
}

/* 额度卡 */
.wallet-card {
  padding: 18px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.wallet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
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
  transition: background var(--transition), color var(--transition);
}

.icon-btn:hover {
  background: rgba(31, 41, 72, 0.08);
  color: var(--text-primary);
}

.wallet-amount {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.wallet-symbol {
  font-size: 16px;
  color: var(--text-secondary);
}

.wallet-value {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.wallet-empty {
  color: var(--danger);
}

.wallet-bar {
  height: 6px;
  margin: 12px 0 8px;
  border-radius: var(--radius-pill);
  background: rgba(31, 41, 72, 0.08);
  overflow: hidden;
}

.wallet-bar-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  background: linear-gradient(90deg, #5b9bff, #2f6bdd);
  transition: width 0.4s cubic-bezier(0.32, 0.72, 0, 1);
}

.wallet-alert {
  margin-top: 12px;
  font-size: 12.5px;
}

.weekly {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid rgba(31, 41, 72, 0.07);
}

.weekly-head {
  display: flex;
  justify-content: space-between;
}

.weekly-bar {
  margin: 8px 0 0;
  height: 5px;
}

.weekly-fill {
  background: linear-gradient(90deg, #b9a2ff, #8b6bff);
}

/* 会话列表 */
.conv-panel {
  display: flex;
  flex-direction: column;
  padding: 18px;
  border-radius: var(--radius-lg);
  flex: 1;
  min-height: 0;
}

.conv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
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
  padding: 9px 10px;
  margin-bottom: 2px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition);
}

.conv-item:hover {
  background: rgba(31, 41, 72, 0.05);
}

.conv-item.active {
  background: var(--accent-soft);
}

.conv-title {
  flex: 1;
  font-size: 13px;
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
  transition: opacity var(--transition), background var(--transition);
  flex-shrink: 0;
}

.conv-item:hover .conv-del {
  opacity: 1;
}

.conv-del:hover {
  background: rgba(214, 69, 69, 0.12);
  color: var(--danger);
}

.conv-empty {
  padding: 14px 10px;
  text-align: center;
}

/* ---------- 对话区 ---------- */
.main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: var(--gap-md);
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 4px 4px 8px;
  min-height: 0;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  padding: 40px 20px;
}

.empty-title {
  margin: var(--gap-lg) 0 8px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.empty-sub {
  margin: 0;
  max-width: 480px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-top: var(--gap-lg);
  max-width: 560px;
}

.chip {
  padding: 9px 16px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-pill);
  background: var(--glass-bg);
  font-size: 13px;
  font-family: inherit;
  color: var(--text-secondary);
  cursor: pointer;
  transition: transform var(--transition), background var(--transition), color var(--transition);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
}

.chip:hover {
  transform: translateY(-1px);
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}

.msg {
  display: flex;
  gap: 12px;
  margin-bottom: var(--gap-lg);
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

.bubble {
  max-width: min(760px, 82%);
  padding: 14px 18px;
  border-radius: var(--radius-lg);
  font-size: 14.5px;
  line-height: 1.72;
}

.bubble-user {
  background: var(--accent);
  color: #fff;
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
  min-width: 60px;
}

.user-text {
  white-space: pre-wrap;
  word-break: break-word;
}

/* 流式光标 */
.caret {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--accent);
  border-radius: 2px;
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  to { visibility: hidden; }
}

.stream-error {
  margin: 0 auto var(--gap-md);
  max-width: 620px;
  justify-content: space-between;
}

/* ---------- 输入区 ---------- */
.composer-wrap {
  flex-shrink: 0;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 12px 12px 12px 18px;
  border-radius: var(--radius-xl);
}

.composer-input {
  flex: 1;
  max-height: 180px;
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
  gap: 10px;
  flex-shrink: 0;
}

.model-select {
  max-width: 190px;
  padding: 8px 10px;
  border: 1px solid rgba(31, 41, 72, 0.1);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.8);
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text-secondary);
  outline: none;
  cursor: pointer;
}

.send-btn {
  padding: 10px 22px;
  border-radius: var(--radius-md);
}

.composer-foot {
  margin-top: 10px;
  text-align: center;
}

/* ---------- 窄屏适配：侧栏折叠到上方 ---------- */
@media (max-width: 900px) {
  .body {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .sidebar {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--gap-sm);
  }

  .conv-panel {
    max-height: 132px;
  }

  .brand-sub,
  .user-meta {
    display: none;
  }
}
</style>