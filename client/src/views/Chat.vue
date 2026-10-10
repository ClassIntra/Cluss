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

              <!-- 谷时段提示只在活动时出现（常驻的优惠标语很快会被当成壁纸）。
                   用「优惠时段」不用「峰谷」：学生不需要知道运营黑话，
                   他只需要知道"现在用更省"。 -->
              <div v-if="offpeakZhe" class="alert alert-info wallet-alert">
                现在是优惠时段，消耗按 {{ offpeakZhe }} 折计算
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

            <!-- 会话多了才露搜索框：新用户列表一屏放得下，不必多一个控件。
                 显示之后**不再隐藏** —— 搜索命中少（甚至 0 条）时若把搜索框收掉，
                 学生连清空关键字的地方都没有了。 -->
            <div v-if="convSearchVisible" class="conv-search-bar">
              <input
                v-model="convQuery"
                class="input conv-search"
                type="search"
                placeholder="搜标题或对话内容…"
                @input="onConvQueryInput"
                @keyup.esc="clearConvQuery"
              />
              <button
                v-if="convQuery"
                class="icon-btn conv-search-clear"
                title="清空搜索"
                @click="clearConvQuery"
              >×</button>
            </div>

            <div class="conv-list">
              <div v-if="convLoading && !conversations.length" class="conv-empty tiny muted">加载中…</div>
              <div v-else-if="!conversations.length" class="conv-empty tiny muted">
                {{ convQuery ? '没有匹配的对话' : '还没有对话' }}
              </div>
              <div
                v-for="c in conversations"
                :key="c.id"
                class="conv-item"
                :class="{ active: c.id === conversationId }"
                @click="openConversation(c.id)"
              >
                <span class="conv-mode-dot" :class="'dot-' + (c.mode || 'study')" :title="modeLabel(c)"></span>

                <!-- 行内重命名：Enter 保存，Esc 取消；失焦视为保存 -->
                <input
                  v-if="renamingId === c.id"
                  ref="renameInput"
                  v-model="renameDraft"
                  class="input conv-rename-input"
                  maxlength="40"
                  @click.stop
                  @keyup.enter="saveRename(c)"
                  @keyup.esc="cancelRename"
                  @blur="saveRename(c)"
                />
                <!-- 标题 + 预览：两行都是单行省略。
                     预览取的是最后一条**有内容**的助手回复（服务端算好带下来），
                     比"最后一条消息"有用得多 —— 最后一条往往就是学生刚问的那句话。 -->
                <span v-else class="conv-main">
                  <span class="conv-title">{{ c.title }}</span>
                  <span v-if="c.preview" class="conv-preview">{{ c.preview }}</span>
                </span>

                <button v-if="renamingId !== c.id" class="conv-del" title="重命名" @click.stop="startRename(c)">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4.5 19.5l.9-3.6L15.9 5.4a2.1 2.1 0 0 1 3 3L8.4 18.9l-3.9.6zM13.9 7.4l3 3" />
                  </svg>
                </button>
                <button v-if="renamingId !== c.id" class="conv-del" title="删除" @click.stop="removeConversation(c.id)">×</button>
              </div>

              <!-- 游标分页：只在校验到服务端还有更早的会话时才出现。
                   这条按钮是"第 301 个会话看不见"那个硬上限的替代品 ——
                   以前服务端直接砍到 300 条，前端连"还有更多"都无从知道。 -->
              <button
                v-if="convHasMore"
                class="conv-more tiny"
                :disabled="convLoadingMore"
                @click="loadMoreConversations"
              >{{ convLoadingMore ? '加载中…' : '显示更早的对话' }}</button>
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
          <!-- 人格只在日常模式出现：学习/拍题要的是稳定准确，语气花活不进解题场景 -->
          <Segmented
            v-if="mode === 'daily' && personaOptions.length"
            v-model="persona"
            :options="personaOptions"
          />
          <!-- 无限制开关（仅日常模式）：
               它放开的是**内容与话题**（能聊娱乐、给攻略、纯闲聊），
               **不放开计费** —— 积分照常扣。按钮上的「无限制」指的是能不能聊，
               不是"免费用"，这一点写进 title 里，免得学生误以为开了就不扣积分。
               做成开关按钮而不是三分段：它是"开/关"一件事，用分段控件
               （受限 | 无限制）会让它看起来像和"模式"同级的另一个模式。 -->
          <button
            v-if="mode === 'daily'"
            type="button"
            class="free-btn"
            :class="{ 'is-on': dailyStyle === 'free' }"
            :disabled="sending"
            :aria-pressed="dailyStyle === 'free' ? 'true' : 'false'"
            :title="dailyStyle === 'free'
              ? '无限制已开启：什么都能聊，AI 会直接给娱乐内容的实质内容。积分照常扣除。'
              : '开启无限制：内容与话题都放开（能聊娱乐、给攻略、纯闲聊）。积分照常扣除。'"
            @click="toggleDailyStyle"
          >无限制</button>

          <!-- AI 人格与记忆：低频设置，收在一个图标按钮里。
               常显（不限日常模式）—— 记忆在学习模式下同样会产生，
               学生排查"它怎么知道我这个"时得能找到入口。 -->
          <button
            type="button"
            class="prefs-btn"
            title="AI 人格与记忆"
            aria-label="AI 人格与记忆"
            @click="openPrefs('persona')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7.5h9M18.5 7.5H20M4 16.5h3M12 16.5h8" />
              <circle cx="15.5" cy="7.5" r="2.2" />
              <circle cx="9.5" cy="16.5" r="2.2" />
            </svg>
          </button>

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
                  <!-- 用户消息里带过的附件：只显示缩略图占位，不重新加载原图。
                       点缩略图看全屏原图（识别错字时学生需要能放大核对） -->
                  <div v-if="m.role === 'user' && m.attachments && m.attachments.length" class="bubble-attachments">
                    <div v-for="a in m.attachments" :key="a.hash" class="mini-attach">
                      <img
                        v-if="a.kind === 'image'"
                        class="mini-attach-img"
                        :src="'/api/cloud/files/' + a.hash + '?thumb=1'"
                        :alt="a.name"
                        loading="lazy"
                        @click="previewUrl = '/api/cloud/files/' + a.hash"
                      />
                      <span v-else class="mini-attach-txt">TXT</span>
                    </div>
                  </div>

                  <!-- 渲染的是预计算好的 m.html，不是 render(m.content)。
                       在模板里调用渲染函数，意味着**任何**一次重渲染都会把所有历史消息
                       重新解析一遍（marked + KaTeX + DOMPurify），流式时每来一个字就全量重算，
                       几十条消息的会话直接卡死。改成只解析"变了的那一条"。 -->
                  <!-- 思考过程：推理型模型在吐正文前会先输出一大段推演。
                       以前这段被直接丢掉，学生只能对着"正在思考…"干等十几秒。
                       现在折叠展示：默认收起不占地方，但「它在动」这件事一眼可见。 -->
                  <details
                    v-if="m.role === 'assistant' && m.reasoning"
                    class="think-panel"
                    :open="m.reasoningOpen"
                    @toggle="m.reasoningOpen = $event.target.open"
                  >
                    <summary class="think-summary">
                      <span class="think-dot" v-if="m.streaming" aria-hidden="true"></span>
                      {{ m.streaming ? '正在推演思路…' : '思考过程' }}
                      <span class="think-toggle muted tiny">（{{ m.reasoningOpen ? '收起' : '展开' }}）</span>
                    </summary>
                    <div class="think-body">{{ m.reasoning }}</div>
                  </details>

                  <!-- 流式中的那条走「冻结段 + 尾段」两个节点（见 utils/stream-paint）。
                       只有 m.htmlFrozen 非空时才拆：历史消息与刚开始的那几帧保持原来的
                       单节点结构，把 DOM/CSS 的影响面限制在"正在生成的那一条"上。 -->
                  <div
                    v-if="m.role === 'assistant' && m.content && m.htmlFrozen"
                    class="md-body md-stream"
                  >
                    <div class="md-part" v-html="m.htmlFrozen"></div>
                    <div class="md-part" v-html="m.html"></div>
                  </div>
                  <div
                    v-else-if="m.role === 'assistant' && m.content"
                    class="md-body"
                    v-html="m.html"
                  ></div>
                  <!-- 还没出第一个字时给状态提示：三点波浪说明"在工作"，
                       文字说明"为什么可能慢"（8s / 20s 分级升级，见 utils/waiting）。
                       role=status 让读屏器也能听到"正在思考"，而不是只看到动画 -->
                  <div
                    v-else-if="m.role === 'assistant' && m.streaming"
                    class="waiting-hint"
                    role="status"
                  >
                    <span class="waiting-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>{{ waitText }}</span>
                  </div>
                  <div
                    v-else-if="m.role === 'assistant' && m.stopped && !m.streaming"
                    class="stopped-hint"
                  >已停止生成</div>
                  <div v-else-if="m.role === 'user'" class="user-text">{{ m.content }}</div>
                  <!-- 流式光标不再放在这里：容器后的行内元素会另起一行，
                       光标孤零零悬在正文下面。改为由 paint 注入渲染结果的
                       最后一行行内（见 utils/stream-caret 与 runTurn 里的 paint） -->
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

          <!-- 引用的笔记：与云盘附件分开一条通道（笔记是自己写的，不是外部资料） -->
          <div v-if="noteRefs.length" class="note-refs">
            <span class="note-refs-label tiny">引用笔记</span>
            <span
              v-for="n in noteRefs"
              :key="n.id"
              class="note-ref-chip"
            >
              {{ n.title }}
              <button class="note-ref-x" title="移除" @click="removeNoteRef(n.id)">×</button>
            </span>
          </div>

          <div class="composer glass">
            <button class="attach-btn" type="button" title="添加云盘附件" @click="pickerOpen = true">＋</button>
            <!-- 引用笔记：手绘 SVG（与 TabBar 同策略，不为一个图标引库）。
                 此前用 📎 emoji：它是唯一的彩色 emoji，混在一排单色控件里风格割裂，
                 且部分安卓 WebView 渲染成异形/豆腐块 —— 这就是"图标很奇怪"的来源。
                 语义不是"附件"而是"我写的文档"，用文档折角+文字线的 file 图标。 -->
            <button class="attach-btn" type="button" title="引用笔记" @click="notePickerOpen = true">
              <svg class="btn-ic" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 3v5h5" />
                <path d="M9 13h6M9 17h4" />
              </svg>
            </button>

            <textarea
              ref="input"
              v-model="draft"
              class="composer-input"
              :placeholder="composerPlaceholder"
              :disabled="sending || !canAsk"
              rows="1"
              @keydown="onComposerKeydown"
              @input="autoGrow"
            ></textarea>

            <div class="composer-actions">
              <!-- 深度思考开关：只有当前模型实测支持时才出现（服务端按模型
                   透出 supports_thinking，管理员在模型表单勾）。关 = 由上游自由发挥
                   （有时思考有时不思考、无法预期）；开 = 明确要求先输出思维链。
                   选择持久化在本地：这是"我的使用偏好"，跨会话沿用。 -->
              <button
                v-if="thinkingAvailable"
                type="button"
                class="think-btn"
                :class="{ 'think-btn-on': thinking }"
                :disabled="sending"
                :aria-pressed="thinking ? 'true' : 'false'"
                :title="thinking
                  ? '深度思考已开启：AI 先推演再作答，更稳但更慢'
                  : '开启深度思考：AI 先推演再作答（更慢但更稳）'"
                @click="thinking = !thinking"
              >深度思考</button>

              <!-- 只有一个可选模型时整个下拉没有意义（选谁都是它），
                   留着只会占地方，且没配模型时会缩成一条空缝 —— 直接不渲染。
                   学生只看到可用的模型（服务端已过滤），不会遇到"选中的这个不能用"。
                   不可用原因是给管理员看的，管理员仍能看到带徽标的完整列表。 -->
              <ModelSelect
                v-if="models.length > 1"
                v-model="modelId"
                :options="models"
                :disabled="sending"
                drop-up
              />

              <button
                class="btn send-btn"
                :class="sending ? 'btn-stop' : 'btn-primary'"
                :disabled="!sending && !canSend"
                @click="sending ? stop() : send()"
              >{{ sending ? '停止生成' : '发送' }}</button>
            </div>
          </div>

          <div class="composer-foot tiny muted">
            <span class="foot-kbd">Enter 发送，Shift + Enter 换行 · </span>回答由 AI 生成，请自行核对
          </div>
        </div>
      </main>
    </div>

    <transition name="fade">
      <div v-if="previewUrl" class="preview-mask" @click.self="previewUrl = ''">
        <img class="preview-img" :src="previewUrl" alt="附件原图" />
      </div>
    </transition>

    <CloudPicker
      v-if="pickerOpen"
      :max="4"
      title="添加到对话"
      hint="可选图片与文本文件，最多 4 个"
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

    <!-- AI 人格与记忆：人格 CRUD + 自动沉淀的记忆清单。
         @changed → 重新拉 /personas，否则新建/改名后选择器还是旧的。 -->
    <AiPrefs
      v-if="aiPrefsOpen"
      :initial-tab="aiPrefsTab"
      @changed="onPersonasChanged"
      @close="aiPrefsOpen = false"
    />
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import ClussLogo from '@/components/ClussLogo.vue';
import Segmented from '@/components/Segmented.vue';
import AttachmentChips from '@/components/AttachmentChips.vue';
import CloudPicker from '@/components/CloudPicker.vue';
import NotePicker from '@/components/NotePicker.vue';
import ModelSelect from '@/components/ModelSelect.vue';
import AiPrefs from '@/components/AiPrefs.vue';
import { renderMarkdown, renderStream } from '@/utils/markdown';
// 流式增量渲染（冻结已稳定的前缀，每帧只重渲染尾巴）——见 utils/stream-paint
import { createStreamPainter } from '@/utils/stream-paint';
import { appendStreamCaret } from '@/utils/stream-caret';
import { readSseStream } from '@/utils/sse';
import streamSession from '@/utils/stream-session';
import waiting from '@/mixins/waiting';
import streamFrame from '@/mixins/streamFrame';
import noteRefs from '@/mixins/note-refs';
import orientation from '@/mixins/orientation';
import mermaidCharts from '@/mixins/mermaid';

var CHIPS = {
  study: ['这道题的思路是什么？', '帮我检查一下我的解法', '只给提示，别给答案', '这个公式我没看懂'],
  daily: ['帮我解释一下这个概念', '这段代码哪里有问题', '帮我看看这篇作文', '做个一周复习计划']
};

export default {
  name: 'ChatView',
  components: { AppNav, ClussLogo, Segmented, AttachmentChips, CloudPicker, NotePicker, ModelSelect, AiPrefs },
  mixins: [waiting, streamFrame, orientation, noteRefs, mermaidCharts],
  data: function() {
    return {
      conversations: [],
      conversationId: '',
      messages: [],
      models: [],
      modelId: '',
      // 谷时段活动信息（/models 下发；null = 全天平价）
      offpeak: null,
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
      // 主输入是否为触摸（安卓平板 = true）：决定 Enter 是发送还是换行
      isTouch: false,
      // 日常模式人格（服务端 /personas 下发定义，内置 + 我自建；'' = 伙伴默认）
      personas: [],
      persona: '',
      // 日常模式的「无限制」风格：'' = 受限（默认）| 'free' = 无限制。
      //
      // ⚠️ 刻意**不**像 persona 那样存 localStorage：
      //   persona 是观感偏好（换个语气而已），新会话沿用很自然；
      //   而"无限制"放开的是内容边界 —— 让新建的会话**默认**就是放开的，
      //   学生会忘了自己开过。所以新会话一律回落到受限，
      //   只有真正打开过的那个历史会话会带着它的设定回来（服务端存了）。
      dailyStyle: '',
      // AI 人格与记忆弹窗
      aiPrefsOpen: false,
      aiPrefsTab: 'persona',
      // 会话模式
      mode: 'study',
      studyStyle: 'guided',
      // 深度思考开关：true = 要求当前模型先输出思维链再作答。
      // 只对 supports_thinking=1 的模型可见（thinkingAvailable 把关）；
      // 本地持久化，跨会话沿用（见 watch.thinking）
      thinking: false,
      // 会话搜索。语义已变：以前是**本地**按标题过滤（列表只有最近 100 条，
      // 学生想找的那条很可能根本没被拉下来），现在打到服务端，
      // 服务端同时匹配标题与**任意一条消息的正文** ——
      // "搜我上次问过的那道题"终于是能用的。
      convQuery: '',
      // 首屏列表超过 5 条之后就一直显示搜索框（once true，不回退）
      convSearchVisible: false,
      convHasMore: false,
      // 下一页的游标（服务端给的 opaque 串，前端只负责原样回传，不解析）
      convNextCursor: '',
      convLoading: false,
      convLoadingMore: false,
      // 行内重命名：renamingId 指向正在改的会话，'' 表示没有在改
      renamingId: '',
      renameDraft: '',
      // 附件全屏预览的原图地址；'' 表示关闭
      previewUrl: ''
    };
  },
  computed: {
    user: function() { return this.$store.state.auth.user || {}; },
    wallet: function() { return this.$store.state.auth.wallet; },

    // 谷时段折扣的「折」口径（0.5 → 5，0.65 → 6.5）；不在活动期返回空。
    //
    // 按**当前选中的模型**取折扣（后端逐模型计算）：峰谷不是全局一刀切的 ——
    // 有的模型根本不参与峰谷。用全局开关去挂这条横幅，会给不参与峰谷的模型
    // 错误地显示"现在打折"，学生一算账发现没便宜，信任度就掉了。
    // （老后端不返回 offpeak_discount → undefined，此时回退顶层 offpeak，兼容。）
    offpeakZhe: function() {
      var m = null;
      for (var i = 0; i < this.models.length; i++) {
        if (this.models[i].id === this.modelId) { m = this.models[i]; break; }
      }
      var raw = (m && m.offpeak_discount !== undefined)
        ? Number(m.offpeak_discount)
        : Number(this.offpeak && this.offpeak.discount);
      if (!raw || raw <= 0 || raw >= 1) return '';
      return String(Math.round(raw * 100) / 10);
    },

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
    // 人格选项（服务端 /personas 下发；id/label/desc 均由服务端定义，前端不硬编码）
    // 自定义人格的 label/desc 由服务端补齐（见 persona-store.rowToPersona），
    // 这里不再按来源分支 —— 列表形状是统一的。
    personaOptions: function() {
      return this.personas.map(function(p) {
        return { id: p.id, label: p.label || p.name, hint: p.desc || '' };
      });
    },
    modeHint: function() {
      if (this.mode === 'daily') {
        var cur = this.personas.filter(function(p) { return p.id === this.persona; }, this)[0];
        var tone = cur ? ('语气：' + (cur.desc || cur.label)) : '通用学习助手，不主动出题';
        // 无限制是"这个会话的边界"，比语气更该让人一眼看到，放前面
        return this.dailyStyle === 'free' ? ('无限制 · ' + tone) : tone;
      }
      return this.studyStyle === 'direct' ? '直接给出完整步骤与答案' : '先给提示，逐步引导';
    },
    currentChips: function() {
      return CHIPS[this.mode] || CHIPS.study;
    },
    // 当前选中的模型是否实测支持深度思考（服务端透出 supports_thinking）。
    // 不支持时开关整个不显示 —— 宁可没有开关，也不给一个"点了没反应"的开关。
    thinkingAvailable: function() {
      var id = this.modelId;
      for (var i = 0; i < this.models.length; i++) {
        if (this.models[i].id === id) return this.models[i].supports_thinking === 1;
      }
      return false;
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
      // 只引了笔记没写字也允许发送：笔记本身就是这次提问的上下文
      return !this.sending &&
        (this.draft.trim().length > 0 || this.attachments.length > 0 || this.noteRefs.length > 0) &&
        this.canAsk;
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
    // 原先这里有一个 visibleConversations（本地按标题过滤）。
    // 已删除：过滤改由服务端做，理由见 data.convQuery 的注释。
    // 保留这段说明是为了让后来者知道"这里曾经有过一个 computed"，
    // 而不是以为模板漏用了什么。
  },
  watch: {
    // 切到日常模式时恢复人格：优先用当前会话存的，其次用本地记住的偏好
    mode: function(val) {
      if (val === 'daily' && !this.persona) {
        this.persona = this.lastStoredPersona();
      }
      // 切回学习模式不清空 persona：它只在 daily 分支下随请求发送
    },
    // 记住最近一次选择：新会话 / 切模式时沿用，不必每次重新挑
    persona: function(val) {
      if (val) {
        try { localStorage.setItem('cluss_persona', val); } catch (e) { /* 隐私模式下忽略 */ }
      }
    },
    // 深度思考偏好持久化：开过一次之后每次进来都还是开的 ——
    // 学生开它是因为"想要可靠"，每次要重新开一遍会让他以为没生效
    thinking: function(val) {
      try { localStorage.setItem('cluss_thinking', val ? '1' : '0'); } catch (e) { /* 隐私模式下忽略 */ }
    }
  },
  mounted: function() {
    // 主输入是否为触摸（决定 Enter 是发送还是换行，见 onComposerKeydown）
    try { this.isTouch = window.matchMedia('(hover: none)').matches; } catch (e) { /* 探测失败按桌面处理 */ }

    // 方向与抽屉手势由 mixins/orientation 统一处理（三个页面共用）
    this.$store.dispatch('auth/fetchProfile').catch(function() {});
    this.loadWallet();
    this.loadModels();
    this.loadPersonas();
    // 打开页面时若本地记住过人格，先恢复上（不等接口回来，避免选择器闪一下）
    if (this.mode === 'daily') this.persona = this.lastStoredPersona();
    // 深度思考偏好同理：先恢复，不等 /models 回来（开关的可见性由模型能力决定）
    try { this.thinking = localStorage.getItem('cluss_thinking') === '1'; } catch (e) { /* 忽略 */ }
    this.loadConversations();
    // 后台可能还挂着一轮生成（学生切走过又回来）：挂上去就能接着看
    streamSession.attach('chat', this);
  },
  beforeDestroy: function() {
    clearTimeout(this._copyTimer);
    // 搜索防抖挂着的定时器：不撤的话它会在这块已销毁的 vm 上继续跑一次请求
    clearTimeout(this._convQueryTimer);
    this.clearServerPoll();
    // 滚动节流自己排队的 rAF（不是 mixin 的渲染帧，得单独撤）
    if (this._scrollRaf) {
      var cancel = window.cancelAnimationFrame || clearTimeout;
      cancel(this._scrollRaf);
      this._scrollRaf = null;
    }
    // 等待提示的定时器与挂起的渲染帧分别由 mixins/waiting、mixins/streamFrame 清理
    //
    // ⚠️ 这里**绝不** abort 在途请求 —— 切页面不等于不想生成了。
    // 请求交给 utils/stream-session 在后台继续消费，回来 attach 时接着显示；
    // 服务端本来也不因为客户端断开而中断（它会生成完再入库）。
    // 只有学生主动点「停止生成」才真的掐断（见 stop）。
    streamSession.detach(this);
    // 供 runTurn 的收尾判断"组件还在不在"：已经销毁就不能把后台会话收掉，
    // 否则学生切回来什么都看不到
    this.destroyed = true;
  },
  methods: {

    modeLabel: function(c) {
      if (c.mode === 'daily') {
        // 会话列表的圆点靠 title 区分模式，无限制要标出来 ——
        // 否则学生看到一个日常会话，想不起自己把它设成了无限制
        return c.daily_style === 'free' ? '日常对话 · 无限制' : '日常对话';
      }
      return (c.study_style === 'direct' ? '学习·直答' : '学习·引导') + ' ' + c.title;
    },

    // 切换「无限制」。纯本地状态，随下一轮请求一起上报并由服务端落到会话列上 ——
    // 与 persona 的机制完全一致（改了就生效，不必单独打一次接口）。
    toggleDailyStyle: function() {
      this.dailyStyle = this.dailyStyle === 'free' ? '' : 'free';
    },

    openPrefs: function(tab) {
      this.aiPrefsTab = tab === 'memory' ? 'memory' : 'persona';
      this.aiPrefsOpen = true;
    },

    // 人格被增/删/改后：重新拉列表，并校正当前选择
    //
    // 为什么必须校正：学生可能把当前**正在用**的那个人格删掉了。
    // 不校正的话，本地还留着它的 id，下一轮照常带上，服务端解析不到记录
    // → 静默回落成默认语气。学生看到的是"我删了它，语气却没变（还是默认）"，
    // 分不清是没删掉还是没生效。这里显式把它清成默认，行为就可预期了。
    onPersonasChanged: function() {
      var self = this;
      return this.loadPersonas().then(function() {
        if (self.persona && !self.personas.some(function(p) { return p.id === self.persona; })) {
          self.persona = '';
          try { localStorage.removeItem('cluss_persona'); } catch (e) { /* 忽略 */ }
        }
      });
    },

    loadWallet: function() {
      return this.$store.dispatch('auth/fetchWallet').catch(function() {});
    },

    loadModels: function() {
      var self = this;
      return this.$http.get('/models').then(function(r) {
        if (r.data.code !== 200) return;
        self.models = r.data.data.models || [];
        self.offpeak = r.data.data.offpeak || null;
        if (!self.modelId) {
          self.modelId = r.data.data.default_model || (self.models[0] && self.models[0].id) || '';
        }
      }).catch(function() {});
    },

    // ---- 会话列表：游标分页 + 服务端搜索 ----
    //
    // 三件事从本地搬到了服务端，每一件都是"本地做不了"而不是"服务端更优雅"：
    //   1. 分页 —— 本地拿不到第 301 条（旧接口硬砍到 300 条）；
    //   2. 搜索正文 —— 本地只有内存里这 30~100 条，学生要找的很可能不在其中；
    //   3. 预览 —— 要算"最后一条有内容的助手回复"，本地得为每条会话再拉一次详情。
    //
    // 统一走 fetchConversations：列表首屏、搜索、加载更多、刷新共用同一条路径，
    // 避免四处各写一遍 then 回调然后逐处漂移（这正是本地过滤时代留下的问题）。

    // 首屏 / 搜索：从第一页开始，替换整个列表
    loadConversations: function() {
      return this.fetchConversations({ limit: 30, cursor: '' });
    },

    // 拉最新但不丢掉"已经加载更多"的部分。
    // 一轮对话结束、删除会话之后调用它 —— 直接 loadConversations 会把学生
    // 翻了五页才翻到的第 120 条会话收回去，那是一种很莫名的"我的列表被重置了"。
    // 上限 100 是服务端对单页的硬约束，超出部分接受退化（比整表重拉便宜得多）。
    refreshConversations: function() {
      var want = Math.min(Math.max(this.conversations.length, 30), 100);
      return this.fetchConversations({ limit: want, cursor: '' });
    },

    fetchConversations: function(opts) {
      var self = this;
      var o = opts || {};
      var reset = !o.cursor;

      var params = { limit: o.limit || 30, q: this.convQuery.trim() };
      if (o.cursor) params.cursor = o.cursor;

      if (reset) this.convLoading = true; else this.convLoadingMore = true;

      return this.$http.get('/conversations', { params: params }).then(function(r) {
        if (r.data.code !== 200) return;
        var d = r.data.data || {};
        var list = d.conversations || [];
        self.conversations = reset ? list : self.conversations.concat(list);
        self.convHasMore = !!d.has_more;
        self.convNextCursor = d.next_cursor || '';
        // 列表够长之后就把搜索框露出来（once true，不回退 —— 见模板里的说明）
        if (!params.q && self.conversations.length > 5) self.convSearchVisible = true;
      }).catch(function() {
        // 拉不到就保持现状：会话列表是导航，不该因为它失败把整个页面推成错误态
      }).then(function() {
        self.convLoading = false;
        self.convLoadingMore = false;
      });
    },

    loadMoreConversations: function() {
      if (!this.convNextCursor || this.convLoadingMore) return;
      return this.fetchConversations({ cursor: this.convNextCursor });
    },

    // 搜索输入防抖 300ms：一个字母一个请求在校园网下会明显卡，
    // 而 300ms 在手感上仍然是"我一边打它一边在筛"。
    onConvQueryInput: function() {
      var self = this;
      if (this._convQueryTimer) clearTimeout(this._convQueryTimer);
      this._convQueryTimer = setTimeout(function() {
        self._convQueryTimer = null;
        self.loadConversations();
      }, 300);
    },

    clearConvQuery: function() {
      if (this._convQueryTimer) { clearTimeout(this._convQueryTimer); this._convQueryTimer = null; }
      this.convQuery = '';
      this.loadConversations();
    },

    // 人格定义由服务端下发（唯一来源在 prompt-registry，加人格只改服务端）
    loadPersonas: function() {
      var self = this;
      return this.$http.get('/personas').then(function(r) {
        if (r.data.code !== 200) return;
        self.personas = (r.data.data && r.data.data.personas) || [];
        // 拉回来后再决定用哪个：本地记住的偏好可能已经不在列表里（服务端删过人格）
        if (self.mode === 'daily' && !self.persona) {
          self.persona = self.lastStoredPersona();
        }
      }).catch(function() {
        // 拉不到就不显示人格选择器（模板有 personaOptions.length 判断），
        // 而不是报错 —— 人格是锦上添花，不该因为它用不了整个对话页
      });
    },

    // 本地记住的最近一次人格选择。
    // 为什么用 localStorage 而不是服务端：这是"我这个人的偏好"，跨会话、跨设备无意义，
    // 存本地最省事；而且换新会话时不该丢掉（学生每次重挑一遍会烦）。
    // 返回值必须校验：服务端可能已经删掉某个人格，而本地还存着它的 id，
    // 直接带上会让后端把它归零（回到默认），学生就以为"我选的人格没生效"。
    lastStoredPersona: function() {
      var saved = '';
      try { saved = localStorage.getItem('cluss_persona') || ''; } catch (e) { saved = ''; }
      if (!saved) return '';
      // 列表还没拉回来时先信它（后续 loadPersonas 会再校一次）
      if (!this.personas.length) return saved;
      var valid = this.personas.some(function(p) { return p.id === saved; });
      return valid ? saved : '';
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
            // 流式增量渲染的冻结段。历史消息恒为空（整篇已在 html 里），
            // 只有"正在生成"的那条会被 paintStream 填上。
            // ⚠️ 必须在**对象创建时**就声明：Vue 2 不会追踪后加的属性，
            //    运行期再赋值视图不会更新（表现为"冻结段不显示"）。
            htmlFrozen: '',
            attachments: m.attachments || [],
            // 服务端标记"还在生成"（迁移 019）：显示光标，并交给轮询把后续内容补上
            streaming: !!m.streaming,
            enter: false
          };
        });
        // 服务端那边这一轮还没写完（换设备 / 重开应用回来最常见）→ 轮询到它写完。
        // 这是 stream-session 之外的另一条恢复路径：那条只在同一浏览器会话内有效，
        // 页面被关掉后就没有了，只能靠服务端这条。
        self.pollServerStream();
        if (data.conversation) {
          if (data.conversation.model_id) self.modelId = data.conversation.model_id;
          // 打开历史会话时把模式同步过来，否则用户会以为当前模式已生效
          if (data.conversation.mode) self.mode = data.conversation.mode;
          if (data.conversation.study_style) self.studyStyle = data.conversation.study_style;
          // 恢复该会话的人格；会话没存过（旧会话）就沿用本地记住的偏好
          if (self.mode === 'daily') {
            self.persona = data.conversation.persona || self.lastStoredPersona();
          }
          // 无限制按会话恢复，且**不做** localStorage 兜底（与 persona 不同）：
          // 新会话 / 没开过的旧会话一律从"受限"开始 —— 内容边界这种设定
          // 不该靠"我上次开过"悄悄沿用（见 data 里 dailyStyle 的说明）。
          self.dailyStyle = data.conversation.daily_style || '';
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
      // 新会话回到"受限"：无限制是按会话存的，新开一个就该从安全默认开始
      this.dailyStyle = '';
      // 换了会话就别再轮询上一轮的服务端生成了
      this.clearServerPoll();
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

    // ---- 会话重命名（行内编辑，PATCH /conversations/:id 的 title 字段）----
    startRename: function(c) {
      this.renamingId = c.id;
      this.renameDraft = c.title || '';
      this.$nextTick(function() {
        // v-for 里的 ref 是数组，取到当前这条的输入框
        var el = this.$refs.renameInput;
        var input = Array.isArray(el) ? el[0] : el;
        if (input) {
          input.focus();
          input.select();
        }
      });
    },

    saveRename: function(c) {
      // Enter 与 blur 都会触发：第一次执行后 renamingId 已清空，第二次直接跳过
      if (this.renamingId !== c.id) return;
      var title = this.renameDraft.trim().slice(0, 40);
      this.renamingId = '';
      if (!title || title === c.title) return;

      var self = this;
      this.$http.patch('/conversations/' + c.id, { title: title }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '重命名失败');
        c.title = title;
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '重命名失败', type: 'error' });
      });
    },

    cancelRename: function() {
      this.renamingId = '';
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

    // Enter 行为按输入设备分流：
    //   桌面（有鼠标）：Enter 发送，Shift + Enter 换行 —— 键盘党的效率习惯
    //   触屏（目标设备安卓平板）：软键盘没有 Shift，Enter 一律换行，
    //     发送交给按钮 —— 与微信等主流 App 一致；否则多行输入没法换行。
    // 判据用 (hover: none)（主输入是触摸），平板插了物理键盘也按触屏算。
    onComposerKeydown: function(e) {
      if (this.isTouch) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.send();
      }
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

    // 判断是否贴着底部：留 48px 容差，手指滑动时轻微偏移不该算"离开底部"。
    // 滚动事件一帧可能触发好几次，每次都要读 scrollHeight/scrollTop/clientHeight
    // 三个布局属性 —— 低端设备上这正是"滚动发涩"的直接来源之一。
    // 用独立的 rAF 合并到每帧至多一次。刻意不复用 scheduleFrame：那个被流式
    // 渲染占用（调它等于把挂起的那次渲染顶掉），两者必须各排队各的。
    onScroll: function() {
      var self = this;
      if (this._scrollRaf) return;
      var raf = window.requestAnimationFrame || function(cb) { return setTimeout(cb, 16); };
      this._scrollRaf = raf(function() {
        self._scrollRaf = null;
        var el = self.$refs.scroller;
        if (!el) return;
        self.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      });
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
      // 先把这轮标记为结束 —— 否则学生停止后再切走，后台会话会以为它还在生成，
      // 回来就把一条已停住的内容当成"还在写"继续显示。
      // （AbortError 在 runTurn 的 catch 里被直接 return 跳过，不会走到 finish）
      streamSession.finish();
      // controller 由后台会话持有：从后台恢复过来的组件自己没有 _abort，
      // 走 session 才掐得断（两处是同一个 controller，abort 是幂等的）
      streamSession.abort();
      if (this._abort) this._abort.abort();
    },

    // ---------- 后台流式会话（切页面不断流）----------
    //
    // 这一轮生成的状态存在 utils/stream-session 里，不在组件里。
    // 组件只是观察者：切走 detach、回来 attach，所以下面几个都是"接线口"。

    // 渲染当前进行中的助手消息。
    // 流式期间走轻量渲染（renderStream），结束 / 中断的收尾那次走完整渲染 ——
    // 公式与图表必须在最后真出来，不能一直停在占位状态。
    //
    // 流式期间另外做**增量**渲染：换写 stream-paint，把已经不会再变的前缀冻结住，
    // 每帧只重渲染尾巴那一小块。实测（真 Chrome，6x CPU 降频）4980 字的回答
    // 从 45ms/帧（97 次卡顿）降到 12ms/帧（0 次卡顿），且每帧成本不再随长度增长。
    // 正确性由 utils/stream-paint 的切点规则 + 差分测试保证（见该文件顶部说明）。
    paintStream: function() {
      var a = this.streamAssistant;
      if (!a) return;

      if (a.streaming) {
        if (!a._painter) a._painter = createStreamPainter(renderStream);
        var out = a._painter.update(a.content);
        a.htmlFrozen = out.frozen;
        a.html = appendStreamCaret(out.tail);
      } else {
        // 收尾：丢掉增量状态，做一次完整渲染（公式真出来、图表真画）
        a._painter = null;
        a.htmlFrozen = '';
        a.html = renderMarkdown(a.content);
      }

      if (this.atBottom) this.scrollToBottom();
    },

    // 后台会话每收到一个增量都会回调这里（组件已 detach 时不会回调）
    _onStreamSync: function() {
      if (!streamSession.isActive('chat')) return;
      var s = streamSession.getState();

      // 还没接过线（组件是重新挂载的）→ 先把结构与历史补齐
      if (!this.streamAssistant) {
        if (!this.resuming) this.resumeStream();
        return;
      }
      // 这轮不属于当前打开的会话（学生切去看别的历史了）：只管在后台累积，别动当前界面
      if (s.conversationId && this.conversationId && s.conversationId !== this.conversationId) return;

      var a = this.streamAssistant;
      a.content = s.text;
      a.reasoning = s.reasoning;
      a.streaming = !s.done;
      this.sending = !s.done;
      // 恢复过来的组件没经历过"首字到达"那一刻（那次判定发生在旧组件里），
      // 等待提示会一直挂着 —— 这里按"已经出过字"补撤一次
      if (s.streaming && this.waitText) this.stopWaiting();
      this.scheduleFrame(this.paintStream);
    },

    // 从后台会话恢复：把历史拉回来，再把累积到现在的正文补在末尾
    resumeStream: function() {
      var self = this;
      var s = streamSession.getState();

      // 用户消息在发起时就入库了，所以历史能拉回来；
      // 助手消息要等整轮生成完才入库，进行中的那部分只有后台会话里有
      var load = s.conversationId ? this.openConversation(s.conversationId) : null;
      this.resuming = true;

      return Promise.resolve(load).then(function() {
        if (!streamSession.isActive('chat')) { self.resuming = false; return; }
        var st = streamSession.getState();

        var last = self.messages[self.messages.length - 1];
        var a;
        if (last && last.role === 'assistant') {
          a = last;
        } else {
          a = {
            role: 'assistant', content: '', html: '', htmlFrozen: '', attachments: [],
            streaming: true, reasoning: '', reasoningOpen: false
          };
          self.messages.push(a);
        }

        // 取较长的那份：历史里可能已经存了完整版（生成完入库），也可能一行都还没有
        if (st.text && st.text.length > (a.content || '').length) a.content = st.text;
        if (st.reasoning) a.reasoning = st.reasoning;
        a.streaming = !st.done;
        self.streamAssistant = a;
        self.sending = !st.done;
        self.stopped = false;
        self.resuming = false;
        self.paintStream();

        if (st.done) {
          // 后台已经生成完了：补一次钱包与会话列表刷新，然后收摊
          self.loadWallet();
          self.refreshConversations();
          streamSession.end();
        } else {
          // 还在生成：把等待提示挂回去（它本该在首字到达时才撤）
          self.startWaiting('chat');
          self.scrollToBottom();
        }
      });
    },

    // ---------- 服务端"生成中"的轮询恢复 ----------
    //
    // 什么时候会走到这里：库里有一条 streaming=1 的助手消息，而本地没有活跃的
    // 后台会话 —— 也就是「这一轮不是在**当前这个页面**发起的」，典型是学生换了
    // 设备、或把应用关掉后重新打开。服务端还在跑，我们就隔一会儿拉一次，直到它写完。
    // 这是 stream-session 之外的第二条恢复路径（那条只在同一浏览器会话内有效）。

    pollServerStream: function() {
      var self = this;
      var convId = this.conversationId;
      this.clearServerPoll();
      if (!convId) return;

      // 只有确实存在"还在生成"的助手消息才值得轮询
      var pending = this.messages.some(function(m) {
        return m.role === 'assistant' && m.streaming;
      });
      if (!pending) return;

      this._serverPoll = setInterval(function() {
        // 学生换了会话 / 页面已切走 → 停
        if (!self.conversationId || self.conversationId !== convId) { self.clearServerPoll(); return; }
        // 本地这一轮正在流（后台会话在跑）→ 由它负责，别叠加两套更新
        if (streamSession.isActive('chat')) { self.clearServerPoll(); return; }

        self.$http.get('/conversations/' + convId).then(function(r) {
          if (r.data.code !== 200) return;
          var msgs = r.data.data.messages || [];
          self.applyServerStreaming(msgs);
          var still = msgs.some(function(m) { return m.role === 'assistant' && m.streaming; });
          if (!still) {
            self.clearServerPoll();
            self.refreshConversations();
          }
        }).catch(function() { /* 网络抖动，下一轮再试 */ });
      }, 1500);
    },

    clearServerPoll: function() {
      if (this._serverPoll) {
        clearInterval(this._serverPoll);
        this._serverPoll = null;
      }
    },

    // 只更新**已存在**的助手消息正文（按顺序一一对应），不重建整个列表 ——
    // 重建会把学生刚打进输入框、刚发的新消息一起冲掉。
    // 轮询场景下本地与服务端的助手序列是一致的（就是同一条从半截变完整），
    // 所以按下标对齐是安全的。
    applyServerStreaming: function(msgs) {
      var serverAssistants = (msgs || []).filter(function(m) { return m.role === 'assistant'; });
      var localAssistants = this.messages.filter(function(m) { return m.role === 'assistant'; });
      for (var i = 0; i < localAssistants.length && i < serverAssistants.length; i++) {
        var s = serverAssistants[i];
        var l = localAssistants[i];
        if (s.content && s.content !== l.content) {
          l.content = s.content;
          l.html = renderMarkdown(s.content);
          // 正文被整体换掉了，增量渲染的冻结段作废。
          // 不清的话旧冻结段会和新正文拼在一起，看起来像内容重复了一段。
          // （就算忘了清，paintStream 里 painter 发现"新内容不是旧前缀的延伸"
          //   也会自动重置；这里显式清一次是为了不依赖那个兜底。）
          l.htmlFrozen = '';
        }
        l.streaming = !!s.streaming;
      }
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
      // 沿用上一轮的笔记引用（存在消息里），否则重新生成会丢掉笔记上下文
      this.runTurn(lastUser.content, (lastUser.attachments || []).slice(), (lastUser.notes || []).slice());
    },

    retry: function() {
      this.regenerate();
    },

    send: function() {
      if (!this.canSend) return;

      var content = this.draft.trim();
      var atts = this.attachments.slice();
      var notes = this.noteRefs.slice();
      // 只引了笔记没写字也算有输入：笔记本身就是这次提问的上下文
      if (!content && !atts.length && !notes.length) return;

      this.draft = '';
      this.attachments = [];
      this.clearNoteRefs();
      this.$nextTick(this.autoGrow);
      this.runTurn(content, atts, notes);
    },

    // 一轮对话的完整编排：send 与 regenerate 共用，避免两处行为走偏
    //
    // notes：本轮引用的笔记（[{ id, title }]）。
    // 与 atts 一样随消息存一份（仅前端内存），regenerate 时才能沿用同一批引用——
    // 否则重新生成会把笔记上下文弄丢，学生看到的是"换了套说法但不提笔记"的答案。
    runTurn: function(content, atts, notes) {
      var self = this;

      this.streamError = '';
      this.visionStatus = '';
      this.stopped = false;

      // enter: 只有本轮新加的消息才播进场动画（历史消息不播，见样式里的说明）
      this.messages.push({
        role: 'user', content: content, attachments: atts || [],
        notes: notes || [], streaming: false, enter: true
      });
      // 助手消息不设 enter：它在原地"长出来"，出现这一步已经由等待提示承担了
      var assistant = {
        role: 'assistant', content: '', html: '', htmlFrozen: '', attachments: [], streaming: true,
        reasoning: '', reasoningOpen: false
      };
      this.messages.push(assistant);
      // 这一轮交给后台会话托管：切走页面时组件会被销毁，但生成不能断
      this.streamAssistant = assistant;
      this.resuming = false;
      this.sending = true;
      this.startWaiting('chat');
      this.scrollToBottom();

      // 渲染 + 跟随滚动合并成一次"上色"动作，交给 rAF 节流（见 mixins/streamFrame）。
      // 收口到 paintStream —— 组件重新挂载、从后台会话恢复之后，同一个方法还能接着用
      var paint = function() { self.paintStream(); };

      var controller = new AbortController();
      this._abort = controller;
      streamSession.begin('chat', { conversationId: this.conversationId });
      streamSession.setController(controller);

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
          persona: this.mode === 'daily' ? this.persona : '',
          // 无限制：仅在日常模式上报。
          // 学生端只发 'free' / 'limited' 两个值（服务端把 'limited' 归一为 ''），
          // 学习模式下发空串 = "别动这一列"，与 persona 同规则。
          daily_style: this.mode === 'daily' ? (this.dailyStyle === 'free' ? 'free' : 'limited') : '',
          // 深度思考：用户偏好原样上报，"当前模型认不认"由服务端按
          // supports_thinking 把关（换模型后不带开关也不会把请求打坏）
          thinking: this.thinking === true,
          attachment_hashes: (atts || []).map(function(a) { return a.hash; }),
          note_ids: (notes || []).map(function(n) { return n.id; })
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
            // 第一份思考内容到达就撤掉"正在思考…"：
            // 此时它已经在实实在在地推演，占位文案再挂着就成了噪声。
            // 面板默认折叠——大部分学生不想对着一大串推理文本，
            // 但要能一眼看出"它在动"，而不是盯着三个点怀疑卡死。
            if (self.waitText) self.stopWaiting();
            assistant.reasoning += text;
            // 同时喂给后台会话：组件在不在都照样累积，切走回来才能接着看
            streamSession.feed('', text);
            // 组件已经销毁（学生切走了）→ 别再为它排渲染帧：
            // 那是对着一块看不见的 DOM 白烧 CPU，还会拖慢他正在看的页面。
            // 内容由后台会话继续累积，回来 attach 时一次性补上。
            if (self.destroyed) return;
            self.scheduleFrame(paint);
          },
          onDelta: function(text) {
            // 第一个字一到就撤掉等待提示，别让它和正文并存
            if (self.waitText) self.stopWaiting();
            assistant.content += text;
            streamSession.feed(text, '');
            if (self.destroyed) return;
            // 交给 rAF 合并渲染与跟随滚动（见 mixins/streamFrame）
            self.scheduleFrame(paint);
          },
          onDone: function(done) {
            assistant.streaming = false;
            streamSession.finish();
            // 收尾补一次完整渲染：合并期间到达的最后几个字不能丢
            self.cancelFrame();
            paint();
            self.visionStatus = '';
            // 钱包是唯一消耗出口：每轮结束立即刷新，学生看到的是准确的余量。
            // 估算轮次（上游未回 usage）不弹提示——那是管理员要修的配置问题，
            // 弹给学生只会制造焦虑（他既改不了，也无从判断）；用量页保留「约」标记。
            self.loadWallet();
            self.refreshConversations();
          },
          onError: function(message) {
            assistant.streaming = false;
            streamSession.finish(message);
            self.visionStatus = '';
            self.streamError = message || '生成失败，请重试';
          }
        });
      }).catch(function(err) {
        assistant.streaming = false;
        self.visionStatus = '';
        // 主动停止的那次在 stop() 里已经 finish 过了，这里不再覆盖
        if (err && err.name === 'AbortError') return;

        // 409 = 同一个会话上一条回复还在生成（一般是同一个账号在另一台设备上发的）。
        // 这一轮**根本没落库** —— 服务端在校验阶段就拒了，用户消息与助手占位都没写。
        // 所以要把乐观回显的那两条撤回：
        //   留着它们，学生会以为"发出去了"；等下次打开这个会话消息却不见了，
        //   比当场告诉他"这次没发出去"困惑得多。
        // 同时把他打的那句话与附件放回输入框 —— 他一心想发的东西不能凭空消失。
        if (err && err.status === 409) {
          var ai = self.messages.indexOf(assistant);
          if (ai >= 0) {
            var lo = (ai > 0 && self.messages[ai - 1] && self.messages[ai - 1].role === 'user')
              ? ai - 1 : ai;
            self.messages.splice(lo, ai - lo + 1);
          }
          // 断开 streamAssistant：否则收尾的 paintStream 会继续往已摘掉的对象上写
          self.streamAssistant = null;
          if (!self.draft) self.draft = content;
          if (!self.attachments.length) self.attachments = atts || [];
          if (!self.noteRefs.length) self.noteRefs = notes || [];
          self.$nextTick(self.autoGrow);
          self.streamError = err.message || '上一条回复还在生成中。等它写完，或先点「停止生成」再重发。';
          streamSession.finish(self.streamError);
          return;
        }

        streamSession.finish(err.message);
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
          streamSession.end();
          return;
        }
        if (!assistant.content && !self.streamError) {
          self.streamError = '未收到回复内容，请重试';
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
.chat-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  /* 完全贴边：去掉固定留白，仅保留刘海/手势区安全边距（无刘海设备上为 0） */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
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
  /* 大屏下把命中区做大：26px 在触屏上很容易点空（WCAG 2.5.5 建议 44px）。
     下限 26 保证 960×680 基线一字不变。 */
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

@media (hover: hover) {
.conv-item:hover {
  background: var(--ink-1);
}
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

/* 标题在 .conv-main（纵向 flex）里，所以**不能**再写 flex:1 ——
   那是给横向容器用的，放进纵向容器会让它纵向长开、把预览挤下去。
   这里只需要 min-width:0 让省略号生效。 */
.conv-title {
  min-width: 0;
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

@media (hover: hover) {
.conv-item:hover .conv-del {
  opacity: 1;
}
}

/* 触屏没有 hover：竖屏触控设备上操作按钮常显（靠低对比让位正文，
   与桌面"悬停才出现"的克制并存） */
html.is-portrait .conv-del {
  opacity: 1;
}

@media (hover: hover) {
.conv-del:hover {
  background: var(--danger-tint);
  color: var(--danger);
}
}

.conv-del svg {
  display: block;
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 标题 + 预览两行。
   min-width: 0 是关键：flex 子项默认 min-width:auto，不加它省略号不生效，
   长标题会把右侧的重命名/删除按钮挤出可视区。 */
.conv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
html.no-flex-gap .conv-main > * + * {
  margin-top: 1px;
}

/* 预览：最后一条有内容的助手回复的前 200 字。
   一行省略 —— 侧栏是导航，不是阅读区；换行会让每行高度不一致、扫视变慢。 */
.conv-preview {
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* "显示更早的对话"：整行宽、低对比，读起来像列表的自然延伸而不是主按钮 */
.conv-more {
  display: block;
  width: 100%;
  margin: 6px 0 2px;
  padding: 7px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  cursor: pointer;
  transition: background var(--transition);
}

@media (hover: hover) {
.conv-more:hover {
  background: var(--ink-1);
}
}

.conv-more:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 会话搜索：会话多了以后快速定位。
   ⚠️ 过滤是在**服务端**做的（标题 + 任意一条消息的正文），
   不是本地筛内存里这几十条 —— 见 data.convQuery 的说明。 */
.conv-search-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 0 8px;
  flex-shrink: 0;
}
html.no-flex-gap .conv-search-bar > * + * {
  margin-left: 4px;
}

.conv-search {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  font-size: 13px;
  border-radius: var(--radius-sm);
}

/* 清空按钮固定在右侧、不参与收缩，避免它出现/消失时输入框宽度跳动 */
.conv-search-clear {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  font-size: 16px;
}

/* 行内重命名输入框：贴着原标题的字号与行高，不引起行高跳动 */
.conv-rename-input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  font-size: 12.5px;
  border-radius: var(--radius-2xs);
}

.conv-empty {
  padding: 12px 10px;
  text-align: center;
}

/* ---------- 附件全屏预览（与错题本同款交互：点图看原图，点空白关） ---------- */
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

/* ---------- 无限制开关（仅日常模式） ---------- */
.free-btn {
  flex-shrink: 0;
  padding: 6px 13px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-pill);
  background: transparent;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  /* 按下即时、松开柔和回落（与全站触屏手感一致） */
  transition: color var(--transition), border-color var(--transition), background var(--transition);
}

/* 开启态：主色实心底 + 反白字。
   它是"当前生效的设定"，必须比普通描边按钮更显眼 ——
   学生要能一眼看出这个会话是放开的，而不是回头去翻设置。 */
.free-btn.is-on {
  border-color: transparent;
  background: var(--accent);
  color: var(--text-invert);
  font-weight: 600;
}

@media (hover: hover) {
.free-btn:not(.is-on):hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
}

.free-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 竖屏触控：命中区放大到一指高（与 tool-btn 同一套处理） */
html.is-portrait .free-btn {
  padding: 9px 16px;
  font-size: 13px;
}

/* ---------- AI 人格与记忆入口 ---------- */
.prefs-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 大屏下同步放大命中区；下限 30px 保证 960×680 基线一字不变 */
  width: clamp(30px, 20px + 1vw, 44px);
  height: clamp(30px, 20px + 1vw, 44px);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: background var(--transition), color var(--transition);
}

.prefs-btn svg {
  display: block;
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

@media (hover: hover) {
.prefs-btn:hover {
  background: var(--ink-2);
  color: var(--text-primary);
}
}

/* 日常模式下这一行要放下「模式」+「人格」+「无限制」+「设置」+ 这段说明，
   是全程最挤的一行。让它可压缩、超长收省略号，而不是把模式栏顶成两行 ——
   模式栏一换行，下面消息区的高度就会跳一下，滚动位置也跟着抖。 */
.mode-hint {
  margin-left: auto;
  white-space: nowrap;
  flex: 1 1 120px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
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

@media (hover: hover) {
.scroll-bottom:hover {
  color: var(--accent);
  border-color: var(--accent);
}
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
  max-width: clamp(460px, 30vw, 680px);
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
  max-width: clamp(540px, 36vw, 800px);
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

@media (hover: hover) {
.chip-suggest:hover {
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}
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
  /* 大屏下放宽消息列：原先固定 760px，在 1920 的主区（约 1584px）里只占一半，
     两侧全是空白，观感就是「内容挤在中间一条」。
     clamp 下限锁 760，保证 960×680 基线一个像素都不变。 */
  max-width: min(clamp(760px, 54vw, 1080px), 84%);
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

.msg-tools:focus-within {
  opacity: 1;
}
@media (hover: hover) {
.msg:hover .msg-tools {
  opacity: 1;
}
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
  /* 视觉尺寸保持紧凑（这是消息气泡下方的次级操作，不该跟主操作抢视觉重量），
     但命中区向上下扩到 40px 可点 —— 原理见 styles/global.css「触控命中区」。

     为什么不用 padding 撑大：那会把气泡下方整行撑高，
     破坏消息列表的垂直节奏；伪元素只扩「点得到」的范围，不动布局。 */
  position: relative;
}

.tool-btn::after {
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
.tool-btn:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
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

/* 流式光标样式在 global.css（.stream-caret）：三页共用同一份，
   避免三个 scoped 副本在"形态调优"时走偏 */

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
  max-width: clamp(620px, 38vw, 860px);
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

/* 引用的笔记：与附件 chips 分开一行，用不同色调区分"自己写的"与"外部资料" */
.note-refs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
html.no-flex-gap .note-refs > * + * {
  margin-left: 6px;
}

.note-refs-label {
  color: var(--text-tertiary);
  flex-shrink: 0;
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
  /* 输入框旁的附件按钮：大屏下同步放大命中区（下限 34 = 原值） */
  width: clamp(34px, 24.4px + 1vw, 48px);
  height: clamp(34px, 24.4px + 1vw, 48px);
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  /* SVG 图标需要真居中：块级图标放进固定尺寸按钮，纯 line-height 对不齐 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

@media (hover: hover) {
.attach-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* SVG 图标继承按钮字色（hover 变色自动跟随），尺寸与 34px 按钮协调 */
.btn-ic {
  display: block;
  width: 18px;
  height: 18px;
  margin: 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
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
  /* 学生打字的地方，大屏下同步放大（下限 14.5 = 原值） */
  font-size: clamp(14.5px, 12.58px + 0.2vw, 16.5px);
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

/* 深度思考开关：小胶囊按钮。
   不用渐变/阴影/过渡（低配设备上都是合成开销），开=实色、关=描边即可。 */
.think-btn {
  flex-shrink: 0;
  white-space: nowrap;
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill, 999px);
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
}
.think-btn-on {
  background: var(--accent);
  color: #fff;
}
.think-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 触屏无 hover，防粘连（项目硬约定：:hover 必须包 @media (hover: hover)） */
@media (hover: hover) {
  .think-btn:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .think-btn-on:hover:not(:disabled) {
    background: var(--accent);
    opacity: 0.9;
  }
}

.send-btn {
  padding: 10px 20px;
}

.composer-foot {
  text-align: center;
}

/* 触屏上没有 Shift 键，「Enter 发送」的说明不成立（Enter 是换行），整段收起 */
@media (hover: none) {
  .foot-kbd {
    display: none;
  }
}

@media (max-width: 900px) {
  .mode-hint {
    display: none;
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