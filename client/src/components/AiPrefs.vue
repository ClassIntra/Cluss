<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal glass">
      <h3 class="modal-title">偏好设置</h3>
      <p class="modal-sub tiny muted">
        外观与默认打开页决定 Cluss 用起来的样子；人格决定日常对话用什么语气说话；
        记忆是 AI 在聊天里记住的关于你的事，用来让它更懂你。
      </p>

      <div class="tabs">
        <button
          type="button"
          class="tab"
          :class="{ active: tab === 'appearance' }"
          @click="tab = 'appearance'"
        >外观</button>
        <button
          type="button"
          class="tab"
          :class="{ active: tab === 'general' }"
          @click="tab = 'general'"
        >通用</button>
        <button
          type="button"
          class="tab"
          :class="{ active: tab === 'persona' }"
          @click="tab = 'persona'"
        >人格</button>
        <button
          type="button"
          class="tab"
          :class="{ active: tab === 'memory' }"
          @click="switchToMemory"
        >记忆<span v-if="memories.length" class="tab-count">{{ memories.length }}</span></button>
        <!-- 校园 tab **只在接入 ClassIntra 时出现**。
             独立部署不该留一个永远空着的入口 —— 那是"我明明买了这个功能却用不了"
             的同一种失落，不如干脆不存在（与独立性原则一致）。 -->
        <button
          v-if="campusLinked"
          type="button"
          class="tab"
          :class="{ active: tab === 'campus' }"
          @click="tab = 'campus'"
        >校园</button>
      </div>

      <div class="form-scroll">
        <!-- ============ 外观 ============ -->
        <template v-if="tab === 'appearance'">
          <div class="note tiny muted">
            这里改的是 Cluss 的整体配色。切换立刻全站生效，不需要重开页面。
          </div>

          <div class="sec-head">主题</div>
          <div class="list">
            <button
              v-for="t in appearance"
              :key="t.value"
              type="button"
              class="opt-row"
              :class="{ active: theme === t.value }"
              @click="setTheme(t.value)"
            >
              <span class="opt-name">{{ t.label }}</span>
              <span v-if="theme === t.value" class="tag">当前</span>
            </button>
          </div>
        </template>

        <!-- ============ 通用 ============ -->
        <template v-else-if="tab === 'general'">
          <div class="note tiny muted">
            下次打开 Cluss 时生效 —— 改完不会把你从当前正在看的页面弹走。
          </div>

          <div class="sec-head">默认打开页</div>
          <div class="list">
            <button
              v-for="p in homePages"
              :key="p.value"
              type="button"
              class="opt-row"
              :class="{ active: homePage === p.value }"
              @click="setHomePage(p.value)"
            >
              <span class="opt-name">{{ p.label }}</span>
              <span v-if="homePage === p.value" class="tag">当前</span>
            </button>
          </div>

          <!-- 学习偏好：跟着每一次提问一起交给 AI，用来调整讲解的详略与举例。
               放在「通用」而不是「人格」：人格管的是**日常闲聊的语气**，
               这里是**学习时的讲解方式**，两件事。 -->
          <div class="sec-head">学习偏好</div>
          <div class="note tiny muted">
            这些会随每次提问一起交给 AI：它据此调整讲解的详略与举例。
            只影响表达方式，不改变它对准确性的要求。
          </div>

          <div class="list">
            <button
              v-for="s in replyStyles"
              :key="s.value"
              type="button"
              class="opt-row"
              :class="{ active: prefs.replyStyle === s.value }"
              @click="setReplyStyle(s.value)"
            >
              <span class="opt-name">
                <span class="opt-name-main">{{ s.label }}</span>
                <span class="opt-name-sub tiny muted">{{ s.desc }}</span>
              </span>
              <span v-if="prefs.replyStyle === s.value" class="tag">当前</span>
            </button>
          </div>

          <div class="field-label pref-label">常学的科目（可多选，可不选）</div>
          <div class="chip-group">
            <button
              v-for="s in subjectOptions"
              :key="s"
              type="button"
              class="chip"
              :class="{ on: prefs.subjects.indexOf(s) !== -1 }"
              @click="toggleSubject(s)"
            >{{ s }}</button>
          </div>

          <!-- 整行可点：用 <label> 而不是 <button> ——
               开关本身是 checkbox，把 input 嵌进 button 是非法嵌套（点击会双触发）。 -->
          <label class="pref-toggle" :class="{ on: prefs.useRecords }">
            <span class="pref-toggle-main">
              <span class="pref-toggle-title">参考我的历史数据</span>
              <span class="pref-toggle-desc tiny muted">
                开启后，AI 会结合系统为你积累的学习画像、关联信息与历史记忆来调整讲法。
                关闭后，每次只依据当前这段对话，系统也不再读取这些数据。
              </span>
            </span>
            <ToggleSwitch
              :checked="prefs.useRecords"
              label="参考我的历史数据"
              @change="toggleRecords"
            />
          </label>

          <!-- 默契度：回答「AI 和我熟不熟」。
               放在「通用」是因为它跟上面的开关一样，是跨页面生效的长期状态。
               规则全部服务端结算（每日封顶、探索一次性），这里只展示。 -->
          <div class="sec-head">默契度</div>
          <div v-if="affinityLoading" class="empty tiny muted">读取中…</div>
          <div v-else-if="affinity" class="affinity-card">
            <div class="affinity-head">
              <span class="affinity-title">Lv{{ affinity.level }} · {{ affinity.title }}</span>
              <span class="tiny muted">{{ affinity.points }} 分</span>
            </div>
            <div class="affinity-bar">
              <div class="affinity-bar-fill" :style="{ width: Math.round(affinity.progress * 100) + '%' }"></div>
            </div>
            <div v-if="affinity.nextTitle" class="tiny muted">
              距「{{ affinity.nextTitle }}」还差 {{ affinity.nextPoints - affinity.points }} 分
              <span v-if="affinity.streakDays >= 2"> · 已连续活跃 {{ affinity.streakDays }} 天</span>
            </div>
            <div v-else class="tiny muted">已是最高默契度，谢谢你一直都在。</div>
            <div class="affinity-rules tiny muted">
              每天来聊聊 +2；连续活跃 3 天起每天 +1、7 天起 +2；
              AI 记住你一件新事 +3；第一次用新功能 +2。每天最多 8 分 ——
              默契度不刷分，靠日子堆出来。等级越高，AI 越记得你的事。
            </div>
          </div>

          <!-- 隐私：一份密码管两处（隐藏的对话 + 笔记的隐私空间）。
               放在「通用」而不是新开 tab：它就是长期状态，与上面两个开关同族；
               且入口必须好找 —— 学生想不起密码时第一个找的地方就是设置。 -->
          <div class="sec-head">隐私</div>
          <div class="note tiny muted">
            一个密码同时保护两处：对话侧栏里「隐藏的对话」和笔记里的「隐私空间」。
            解锁后 30 分钟内不用再输；重启 Cluss 会重新锁上。
          </div>

          <div v-if="lockLoading" class="empty tiny muted">读取中…</div>
          <template v-else>
            <div class="lock-state-row">
              <span
                class="lock-state-tag"
                :class="lockStatus.hasPassword ? (lockStatus.unlocked ? 'is-on' : 'is-off') : 'is-none'"
              >{{ lockStatus.hasPassword ? (lockStatus.unlocked ? '已解锁' : '已锁定') : '未设置' }}</span>
              <span class="tiny muted">
                {{ lockStatus.hasPassword ? '隐藏的内容现在' + (lockStatus.unlocked ? '可以查看' : '被藏起来了') : '还没有隐藏的内容' }}
              </span>
            </div>

            <div class="lock-btn-row">
              <button v-if="!lockStatus.hasPassword" type="button" class="mini-btn is-primary" @click="onSetupLock">设置密码</button>
              <template v-else>
                <button v-if="!lockStatus.unlocked" type="button" class="mini-btn is-primary" @click="onUnlockLock">解锁</button>
                <button v-else type="button" class="mini-btn" @click="onLockNow">立即上锁</button>
                <button type="button" class="mini-btn" @click="changingLock = !changingLock">修改密码</button>
                <button type="button" class="mini-btn is-danger" @click="onRemoveLock">移除密码</button>
              </template>
            </div>

            <!-- 改密码：就地展开，不另开弹窗 —— 三个输入框的小事不值得一层浮层 -->
            <div v-if="changingLock" class="lock-change-form">
              <input v-model="lockOldPwd" class="input" type="password" maxlength="32" placeholder="原密码" />
              <input v-model="lockNewPwd" class="input" type="password" maxlength="32" placeholder="新密码（4~32 位）" />
              <input v-model="lockNewPwd2" class="input" type="password" maxlength="32" placeholder="再输一遍新密码" />
              <div class="lock-btn-row">
                <button type="button" class="mini-btn is-primary" :disabled="lockBusy" @click="onChangeLock">
                  {{ lockBusy ? '请稍候…' : '确认修改' }}
                </button>
                <button type="button" class="mini-btn" @click="changingLock = false">取消</button>
              </div>
            </div>
          </template>
        </template>

        <!-- ============ 人格 ============ -->
        <template v-else-if="tab === 'persona'">
          <div class="note tiny muted">
            人格只在「日常」模式生效 —— 学习 / 拍题要的是稳定准确，语气设定不参与解题。
            自定义人格只描述希望的语气，不能改变 AI 的身份与安全底线。
          </div>

          <div class="sec-head">内置人格</div>
          <div class="list">
            <div v-for="p in builtins" :key="p.id" class="row is-static">
              <div class="row-main">
                <div class="row-name">{{ p.label }}</div>
                <div class="row-desc tiny muted">{{ p.desc }}</div>
              </div>
              <span class="tag">内置</span>
            </div>
          </div>

          <div class="sec-head">
            我的人格
            <span class="sec-hint tiny muted">（{{ customs.length }}/{{ limits.max_count }}）</span>
          </div>

          <div v-if="!customs.length" class="empty tiny muted">
            还没有自定义人格。在下面写一个，比如「毒舌学姐」「耐心的学长」。
          </div>

          <div class="list">
            <div v-for="p in customs" :key="p.id" class="row">
              <div class="row-main">
                <div class="row-name">{{ p.name }}</div>
                <div class="row-desc tiny muted">{{ p.prompt }}</div>
              </div>
              <button type="button" class="mini-btn" @click="startEdit(p)">编辑</button>
              <button type="button" class="mini-btn is-danger" @click="removePersona(p)">删除</button>
            </div>
          </div>

          <div class="editor">
            <div class="editor-title">
              {{ editingId ? '编辑人格' : '新建人格' }}
            </div>
            <label class="field">
              <span class="field-label">名字（最多 {{ limits.max_name }} 字）</span>
              <input
                v-model="form.name"
                class="input"
                type="text"
                :maxlength="limits.max_name"
                placeholder="如 毒舌学姐"
              />
            </label>
            <label class="field">
              <span class="field-label">希望它用什么语气说话（最多 {{ limits.max_prompt }} 字）</span>
              <textarea
                v-model="form.prompt"
                class="input"
                rows="3"
                :maxlength="limits.max_prompt"
                placeholder="如：说话直接一点，别绕弯子，可以适度吐槽，但讲知识点要准确。"
              ></textarea>
            </label>

            <div v-if="error" class="alert alert-danger">{{ error }}</div>

            <div class="editor-actions">
              <button v-if="editingId" type="button" class="btn btn-ghost" @click="resetForm">取消编辑</button>
              <button
                type="button"
                class="btn btn-primary"
                :disabled="busy || !canSave"
                @click="savePersona"
              >{{ busy ? '保存中…' : (editingId ? '保存修改' : '新建人格') }}</button>
            </div>
          </div>
        </template>

        <!-- ============ 校园（仅联动部署）============
             ⚠️ 必须排在 v-else 之前：v-else-if 出现在 v-else 之后时条件链断掉，
             组件根本不渲染（面板一片空白，且没有任何报错，实测踩到）。 -->
        <CampusContext v-else-if="tab === 'campus'" />

        <!-- ============ 记忆 ============ -->
        <template v-else>
          <div class="note tiny muted">
            这些是 AI 在和你聊天的过程中自己记下来的，只存在你自己的账号里。
            每聊满 4 轮它会整理一次<span v-if="typeof memoriesLeft === 'number'">（再聊 {{ memoriesLeft }} 轮就会更新）</span>。
            如果哪条记错了、或者你不想让它记，直接删掉 —— 删了它就真的忘了。
          </div>

          <div v-if="loadingMemories" class="empty tiny muted">读取中…</div>
          <div v-else-if="!memories.length" class="empty tiny muted">
            还没记住什么。每聊满 4 轮它会整理一次——多聊聊，它会记住你的偏好、习惯和在意的事。
          </div>

          <div v-else class="list">
            <div v-for="m in memories" :key="m.key" class="row">
              <div class="row-main">
                <div class="row-name">{{ m.content }}</div>
                <div class="row-desc tiny muted">{{ m.key }}</div>
              </div>
              <button type="button" class="mini-btn is-danger" @click="removeMemory(m)">忘记</button>
            </div>
          </div>
        </template>
      </div>

      <div class="modal-actions">
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost" @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script>
// 偏好设置弹窗（原「AI 人格与记忆」）
//
// 为什么这几件事放一个弹窗：
//   它们回答的都是同一个问题 ——「Cluss 该以什么样子、什么语气对我」。
//   外观 / 默认打开页是我对界面的设置，人格是我主动设的语气，记忆是它自己记的；
//   学生排查"它为什么这么跟我说话"时要一起看，分成多个入口反而要来回找。
//
// 为什么不做成独立页面 / 现在怎么打开：
//   做成弹窗改完就能立刻验证（切主题当场可见、切人格回对话页即生效）。
//   它已挂进 AppNav（顶栏），所以全站右上角都能打开；原来只有对话页能开。

import modalEsc from '@/mixins/modal-esc';
import CampusContext from '@/components/CampusContext.vue';
// 开关外观与服务/校园面板共用同一个组件（此前两边各一套，尺寸配色都不同）
import ToggleSwitch from '@/components/ToggleSwitch.vue';
// 外观两档的取值直接来自 theme store —— 不在这里再列一份，避免与 store 漂移
import { THEMES as THEME_VALUES } from '@/store/theme';
// 学习偏好的选项与读写：与对话页 / 学习页共用同一份口径（见该模块顶部说明）
import {
  PREF_SUBJECTS as SUBJECT_OPTIONS,
  PREF_REPLY_STYLES as REPLY_STYLES,
  readStudentPrefs,
  writeStudentPrefs
} from '@/utils/student-prefs';

// 「默认打开页」四选一：读/写/校验都收敛在 utils/home-page 里 ——
// 生效点有两个（登录后落地、已登录再打开），必须是同一份实现。
import { HOME_PAGES, readHomePage, writeHomePage } from '@/utils/home-page';

var THEME_LABELS = { light: '浅色', dark: '深色' };
var APPEARANCE = THEME_VALUES.map(function(v) {
  return { value: v, label: THEME_LABELS[v] || v };
});

// 可定位的初始 tab 白名单；非法值兜底到 persona（沿用原行为）
var INITIAL_TABS = ['appearance', 'general', 'persona', 'memory', 'campus'];

export default {
  name: 'AiPrefs',
  // Esc 关闭（组件由 v-if 控制，存在即打开，见 mixin 说明）
  mixins: [modalEsc],
  components: { CampusContext, ToggleSwitch },
  props: {
    // 打开时定在哪个 tab：'appearance' | 'general' | 'persona' | 'memory' | 'campus'
    initialTab: { type: String, default: 'persona' }
  },
  data: function() {
    return {
      tab: INITIAL_TABS.indexOf(this.initialTab) !== -1 ? this.initialTab : 'persona',
      personas: [],
      limits: { max_count: 20, max_name: 20, max_prompt: 600 },
      memories: [],
      loadingMemories: false,
      memoriesLoaded: false,
      // 距下次后台整理还差几轮（服务端 nextExtractIn）。
      // 旧服务端没这个字段时保持 undefined，模板里的提示句自动不显示。
      memoriesLeft: undefined,
      // 默契度（GET /api/affinity）。加载失败保持 null，卡片整块不显示 ——
      // 它是展示项，不该因为读不到就在设置里摆一个报错。
      affinity: null,
      affinityLoading: false,
      editingId: '',
      form: { name: '', prompt: '' },
      busy: false,
      error: '',
      // 外观两档 / 默认打开页四选一：就地持有当前值，改动即写回
      appearance: APPEARANCE,
      homePages: HOME_PAGES,
      homePage: readHomePage(),
      // 学习偏好：选项列表 + 当前值（读取/写入都走 utils/student-prefs，
      // 与对话页、学习页共用同一份存储口径）
      replyStyles: REPLY_STYLES,
      subjectOptions: SUBJECT_OPTIONS,
      prefs: readStudentPrefs(),
      // 是否接入 ClassIntra：决定"校园" tab 出不出来。
      // 独立部署下它是 false，整块功能等于不存在（独立性要求）。
      campusLinked: false,
      // ---- 隐私锁（统一密码）----
      // 状态以 store/lock 为准（三个页面共用一份），这里只放交互用的临时字段。
      lockLoading: false,
      changingLock: false,
      lockOldPwd: '',
      lockNewPwd: '',
      lockNewPwd2: '',
      lockBusy: false
    };
  },
  computed: {
    // 当前主题：读法与 AppNav 一致，都走 theme store 的 getter
    theme: function() {
      return this.$store.getters['theme/theme'];
    },
    // 隐私锁状态镜像（store/lock 是唯一真相源）
    lockStatus: function() {
      var s = this.$store.state.lock;
      return { hasPassword: s.hasPassword, unlocked: s.unlocked };
    },
    builtins: function() {
      return this.personas.filter(function(p) { return p.builtin === 1; });
    },
    customs: function() {
      return this.personas.filter(function(p) { return p.builtin !== 1; });
    },
    canSave: function() {
      return this.form.name.trim().length > 0 && this.form.prompt.trim().length > 0;
    },
    // 到上限时禁掉新建（编辑不受限）
    atLimit: function() {
      return !this.editingId && this.customs.length >= this.limits.max_count;
    },
    // 上限文案固定成一处，供 watcher 比对后自动清除
    limitMessage: function() {
      return '自定义人格最多 ' + this.limits.max_count + ' 个，先删掉一个再新建';
    }
  },
  watch: {
    atLimit: function(v) {
      // 上限提示用了 error 位，切换/删除后要能自动撤掉，否则会一直挂着
      if (!v && this.error === this.limitMessage) this.error = '';
    }
  },
  mounted: function() {
    this.loadPersonas();
    this.probeCampus();
    this.loadAffinity();
    this.loadLock();
  },
  methods: {
    // ---- 隐私锁 ----
    // 打开弹窗时读一次服务端状态。失败不打扰：lock 的 refresh 自己兜底成
    // "没密码、没解锁"，最坏情况是这一块显示「未设置」，不影响别的 tab。
    loadLock: function() {
      var self = this;
      this.lockLoading = true;
      return this.$store.dispatch('lock/refresh').then(function() {
        self.lockLoading = false;
      });
    },
    onSetupLock: function() {
      var self = this;
      this.$store.dispatch('lock/promptSetup').then(function(ok) {
        if (!ok) return;
        self.$store.dispatch('toast', { message: '密码已设置', type: 'success' });
      });
    },
    onUnlockLock: function() {
      var self = this;
      this.$store.dispatch('lock/promptUnlock').then(function(ok) {
        if (ok) self.$store.dispatch('toast', { message: '已解锁 30 分钟', type: 'success' });
      });
    },
    onLockNow: function() {
      var self = this;
      this.$store.dispatch('lock/lock').then(function() {
        self.$store.dispatch('toast', { message: '已上锁', type: 'info' });
      });
    },
    onChangeLock: function() {
      var self = this;
      if (this.lockNewPwd.length < 4 || this.lockNewPwd.length > 32) {
        this.$store.dispatch('toast', { message: '新密码长度 4~32 位', type: 'error' });
        return;
      }
      if (this.lockNewPwd !== this.lockNewPwd2) {
        this.$store.dispatch('toast', { message: '两次输入不一致', type: 'error' });
        return;
      }
      this.lockBusy = true;
      this.$store.dispatch('lock/change', { oldPassword: this.lockOldPwd, newPassword: this.lockNewPwd })
        .then(function(r) {
          self.lockBusy = false;
          if (!r.ok) {
            self.$store.dispatch('toast', { message: r.message, type: 'error' });
            return;
          }
          self.changingLock = false;
          self.lockOldPwd = '';
          self.lockNewPwd = '';
          self.lockNewPwd2 = '';
          self.$store.dispatch('toast', { message: '密码已修改', type: 'success' });
        });
    },
    onRemoveLock: function() {
      var self = this;
      this.$store.dispatch('confirm', {
        title: '移除隐藏密码',
        message: '移除后，已隐藏的对话和笔记里的隐私空间都不再受密码保护。还有隐藏内容时会自动阻止。确定移除吗？',
        danger: true,
        confirmText: '移除'
      }).then(function(ok) {
        if (!ok) return;
        self.$store.dispatch('lock/remove').then(function(r) {
          if (!r.ok) {
            self.$store.dispatch('toast', { message: r.message, type: 'error' });
            return;
          }
          self.changingLock = false;
          self.$store.dispatch('toast', { message: '密码已移除', type: 'success' });
        });
      });
    },
    // 默契度：打开弹窗时读一次。只读展示，不做任何写入。
    loadAffinity: function() {
      var self = this;
      this.affinityLoading = true;
      return this.$http.get('/affinity').then(function(r) {
        if (r.data.code === 200 && r.data.data) self.affinity = r.data.data;
      }).catch(function() {
        self.affinity = null;
      }).then(function() {
        self.affinityLoading = false;
      });
    },
    // 探测是否接入 ClassIntra。**只读缓存、绝不触发 CI 请求** ——
    // 这个弹窗一打开就打一次 CI 的话，CI 慢的时候"打开设置"会跟着卡住。
    // 失败即当作未联动（校园 tab 不出现），不影响弹窗其它部分。
    probeCampus: function() {
      var self = this;
      return this.$http.get('/campus-context').then(function(r) {
        self.campusLinked = !!(r.data.code === 200 && r.data.data && r.data.data.linked);
      }).catch(function() {
        self.campusLinked = false;
      });
    },

    // 切主题：复用 theme store 的 setTheme（内部 commit SET_THEME，
    // 会落 cluss_theme 存储键并 applyToDom）。**不自己写 localStorage** ——
    // 存储键与启动时的读取都归 store 管，两处各写一份必然漂移。
    setTheme: function(value) {
      this.$store.dispatch('theme/setTheme', value);
    },

    // 选默认打开页：就地记住 + 落 localStorage，**下次打开应用**时生效
    //（早先只写在"下次登录后生效"，而已登录的人再打开根本不经过登录页 → 永远不生效）
    setHomePage: function(value) {
      this.homePage = value;
      writeHomePage(value);
    },

    // 打开记忆 tab 时才拉 —— 没点进去就不必多打一次接口
    switchToMemory: function() {
      this.tab = 'memory';
      if (!this.memoriesLoaded && !this.loadingMemories) this.loadMemories();
    },

    // ---- 学习偏好：改动即写回（无需"保存"按钮，与主题/默认打开页一致）----
    // 写回失败（隐私模式）不影响本次会话：值仍在内存里，本轮之后的提问照样带着它，
    // 只是下次打开会回到默认 —— 顶多这次没记住，不该报错。
    setReplyStyle: function(value) {
      this.prefs.replyStyle = value;
      writeStudentPrefs(this.prefs);
    },

    // 科目是多选：点一下切换选中态（再点取消）
    toggleSubject: function(subject) {
      var i = this.prefs.subjects.indexOf(subject);
      if (i === -1) this.prefs.subjects.push(subject);
      else this.prefs.subjects.splice(i, 1);
      writeStudentPrefs(this.prefs);
    },

    // next 由开关组件给出（它的 checkbox 已经点过了），这里不自己取反：
    // 自取反会和组件的受控回写打架
    toggleRecords: function(next) {
      this.prefs.useRecords = !!next;
      writeStudentPrefs(this.prefs);
    },

    loadPersonas: function() {
      var self = this;
      return this.$http.get('/personas').then(function(r) {
        if (r.data.code !== 200) return;
        var d = r.data.data || {};
        self.personas = d.personas || [];
        if (d.limits) self.limits = d.limits;
      }).catch(function() {
        self.error = '人格列表读取失败，请稍后重试';
      });
    },

    loadMemories: function() {
      var self = this;
      this.loadingMemories = true;
      return this.$http.get('/memories', { params: { limit: 100 } }).then(function(r) {
        if (r.data.code !== 200) return;
        self.memories = (r.data.data && r.data.data.items) || [];
        self.memoriesLeft = r.data.data ? r.data.data.nextExtractIn : undefined;
        self.memoriesLoaded = true;
      }).catch(function() {
        self.error = '记忆读取失败，请稍后重试';
      }).then(function() {
        self.loadingMemories = false;
      });
    },

    startEdit: function(p) {
      this.editingId = p.id;
      this.form = { name: p.name, prompt: p.prompt };
      this.error = '';
    },

    resetForm: function() {
      this.editingId = '';
      this.form = { name: '', prompt: '' };
      this.error = '';
    },

    // 上限文案要固定一句、供 watcher 比对自动清除
    savePersona: function() {
      var self = this;
      if (!this.canSave || this.busy) return;
      if (this.atLimit) {
        this.error = this.limitMessage;
        return;
      }

      this.busy = true;
      this.error = '';
      var payload = { name: this.form.name.trim(), prompt: this.form.prompt.trim() };
      var req = this.editingId
        ? this.$http.put('/personas/' + this.editingId, payload)
        : this.$http.post('/personas', payload);

      req.then(function(r) {
        if (r.data.code !== 200) {
          self.error = r.data.message || '保存失败';
          return;
        }
        self.$store.dispatch('toast', { message: r.data.message || '已保存', type: 'success' });
        self.resetForm();
        // 保存成功要通知外层刷新人格选择器（新增/改名后列表就变了）
        return self.loadPersonas().then(function() { self.$emit('changed'); });
      }).catch(function(err) {
        // 服务端的校验文案（重名 / 与内置撞名 / 超字数）比一句"保存失败"有用得多
        self.error = (err && err.message) || '保存失败';
      }).then(function() {
        self.busy = false;
      });
    },

    removePersona: function(p) {
      var self = this;
      this.$http.delete('/personas/' + p.id).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
        if (self.editingId === p.id) self.resetForm();
        self.$store.dispatch('toast', { message: '已删除', type: 'success' });
        return self.loadPersonas().then(function() { self.$emit('changed'); });
      }).catch(function(err) {
        self.error = (err && err.message) || '删除失败';
      });
    },

    removeMemory: function(m) {
      var self = this;
      // key 里可能有空格转下划线之外的可读字符，必须编码
      this.$http.delete('/memories/' + encodeURIComponent(m.key)).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
        self.memories = self.memories.filter(function(x) { return x.key !== m.key; });
        self.$store.dispatch('toast', { message: '已忘记', type: 'success' });
      }).catch(function(err) {
        self.error = (err && err.message) || '删除失败';
      });
    }
  }
};
</script>

<style scoped>
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
  line-height: 1.5;
}

/* ---------- tab ---------- */
.tabs {
  display: flex;
  align-items: center;
  gap: var(--gap-xs);
  margin-bottom: var(--gap-md);
  padding: 4px;
  border-radius: var(--radius-md);
  background: var(--ink-2);
  flex-shrink: 0;
}
html.no-flex-gap .tabs > * + * {
  margin-left: var(--gap-xs);
}

.tab {
  flex: 1;
  padding: 7px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-family: inherit;
  font-size: 13.5px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--transition), color var(--transition);
}

.tab.active {
  background: var(--surface-3);
  color: var(--accent);
  font-weight: 600;
}

@media (hover: hover) {
.tab:not(.active):hover {
  color: var(--text-primary);
}
}

.tab-count {
  display: inline-block;
  min-width: 16px;
  margin-left: 5px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  vertical-align: 1px;
}

/* ---------- 滚动体 ---------- */
.form-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  margin: 0 -6px;
  padding: 0 6px;
}

.note {
  margin-bottom: var(--gap-md);
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  line-height: 1.6;
}

.sec-head {
  margin: var(--gap-md) 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

/* 默契度卡片：与 pref-toggle 完全同族（同底色同描边），保持设置弹窗里的视觉一致性 */
.affinity-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px 12px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-md);
  background: var(--ink-1);
}

.affinity-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.affinity-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.affinity-bar {
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--ink-4);
  overflow: hidden;
}

.affinity-bar-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--accent);
  /* 宽度由 Vue 内联样式给出；这里只负责过渡。transition 只写 transform/opacity
     之外的 width 是例外：进度条就那一个元素，重排代价可忽略 */
  transition: width var(--duration-normal) var(--ease-standard);
}

.affinity-rules {
  line-height: 1.6;
}

/* ---------- 隐私（统一密码） ---------- */
/* mini-btn 的主色调变体：淡色系里"该点这个"的指引。
   只改描边和字色不填实底 —— 这个弹窗里没有第二处实底按钮，
   突然出现一个会抢走整页的视觉重心。 */
.mini-btn.is-primary {
  border-color: var(--accent);
  color: var(--accent);
}

.lock-state-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
html.no-flex-gap .lock-state-row > * + * {
  margin-left: 8px;
}

/* 状态章：三态一眼可辨，但都不刺眼 —— 它是信息不是警告 */
.lock-state-tag {
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--ink-3);
  font-size: 11.5px;
  color: var(--text-secondary);
}
.lock-state-tag.is-on {
  border-color: var(--accent);
  color: var(--accent);
}
.lock-state-tag.is-off {
  border-color: var(--warning);
  color: var(--warning);
}

.lock-btn-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
html.no-flex-gap .lock-btn-row > * + * {
  margin-left: 8px;
}

.lock-change-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-md);
  background: var(--ink-1);
}
html.no-flex-gap .lock-change-form > * + * {
  margin-top: 8px;
}

.lock-change-form .input {
  width: 100%;
  height: 40px;
}

.sec-hint {
  font-weight: 400;
}

.empty {
  padding: 14px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  text-align: center;
  line-height: 1.6;
}

/* ---------- 列表行 ---------- */
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
html.no-flex-gap .list > * + * {
  margin-top: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
}
html.no-flex-gap .row > * + * {
  margin-left: 8px;
}

/* 内置人格是只读展示，压暗一档与"我的人格"区分开 */
.row.is-static {
  opacity: 0.85;
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-name {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.45;
  word-break: break-word;
}

.row-desc {
  margin-top: 2px;
  line-height: 1.45;
  word-break: break-word;
}

.tag {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--ink-2);
  color: var(--text-tertiary);
  font-size: 11px;
}

/* 可选项行（外观 / 默认打开页）：整行是一个按钮，选中态用强调色描边。
   不复用 .row 是因为 .row 是 div 展示行，这里是可点的 button，需要清掉
   浏览器给 button 的默认外观（边框/背景/居中）。 */
.opt-row {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 10px;
  /* 窄屏（平板竖屏）下标签与「当前」标可能放不下，允许换行，
     不让它们互相挤（Chrome 80 惯例：flex 行都给 flex-wrap） */
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-md);
  background: var(--ink-1);
  font-family: inherit;
  font-size: 13px;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--transition), background var(--transition);
}
html.no-flex-gap .opt-row > * + * {
  margin-left: 10px;
}

@media (hover: hover) {
.opt-row:hover {
  border-color: var(--accent);
}
}

.opt-row.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.opt-name {
  flex: 1;
  min-width: 0;
}

/* 带说明的选项行（回复风格）：主标题 + 一行解释 */
.opt-name-main {
  display: block;
}

.opt-name-sub {
  display: block;
  margin-top: 2px;
  line-height: 1.45;
}

/* ---------- 学习偏好 ---------- */
/* 常学科目：多选胶囊 */
.chip-group {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
}
html.no-flex-gap .chip-group > * + * {
  margin-left: var(--gap-sm);
}

.chip {
  padding: 7px 14px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-pill);
  background: var(--ink-1);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color var(--transition), background var(--transition), color var(--transition);
}

@media (hover: hover) {
.chip:hover {
  border-color: var(--accent);
}
}

.chip.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.pref-label {
  margin-top: var(--gap-md);
}

/* 开关行（参考我的历史数据）：整行可点，右侧是一个开关滑块 */
.pref-toggle {
  display: flex;
  align-items: center;
  width: 100%;
  gap: var(--gap-sm);
  /* 窄屏下长说明会把开关挤变形，允许换行（Chrome 80 惯例） */
  flex-wrap: wrap;
  margin-top: var(--gap-md);
  padding: 11px 12px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-md);
  background: var(--ink-1);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--transition), background var(--transition);
}
html.no-flex-gap .pref-toggle > * + * {
  margin-left: var(--gap-sm);
}

@media (hover: hover) {
.pref-toggle:hover {
  border-color: var(--accent);
}
}

.pref-toggle.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.pref-toggle-main {
  flex: 1;
  min-width: 0;
}

.pref-toggle-title {
  display: block;
  font-size: 13px;
  color: var(--text-primary);
}

.pref-toggle-desc {
  display: block;
  margin-top: 3px;
  line-height: 1.5;
}

.mini-btn {
  flex-shrink: 0;
  padding: 5px 11px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-pill);
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  /* 按下即时、松开柔和回落（与全站触屏手感一致） */
  transition: color var(--transition), border-color var(--transition), background var(--transition);
  /* 28px 高在触屏上偏小，而这是人格的「编辑 / 删除」—— 误触代价高。
     命中区向上下扩到 40px，视觉不变（原理见 styles/global.css「触控命中区」）。 */
  position: relative;
}

.mini-btn::after {
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
.mini-btn:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
}

@media (hover: hover) {
.mini-btn.is-danger:hover {
  border-color: var(--danger);
  background: var(--danger-tint);
  color: var(--danger);
}
}

/* ---------- 编辑器 ---------- */
.editor {
  margin-top: var(--gap-md);
  padding: 14px;
  border-radius: var(--radius-lg);
  background: var(--ink-1);
}

.editor-title {
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
}

.field {
  display: block;
  margin-bottom: 10px;
}

.field-label {
  display: block;
  margin-bottom: 5px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* textarea 用 .input 的盒子样式，但高度可变、且要能纵向拉伸 */
textarea.input {
  width: 100%;
  resize: vertical;
  line-height: 1.6;
  font-family: inherit;
}

.editor-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}
html.no-flex-gap .editor-actions > * + * {
  margin-left: 10px;
}

/* ---------- 底部 ---------- */
.modal-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: var(--gap-md);
  padding-top: var(--gap-md);
  border-top: 1px solid var(--ink-2);
  flex-shrink: 0;
}
html.no-flex-gap .modal-actions > * + * {
  margin-left: 10px;
}

.spacer {
  flex: 1;
}

@media (max-width: 600px) {
  .modal-mask {
    padding: 0;
    align-items: flex-end;
  }

  .modal {
    max-height: 94vh;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
}
</style>
