<template>
  <div class="campus">
    <!-- 说明：这一段话是整个功能的合法性来源，不能省。
         学生看到"AI 知道我的校园信息"的第一反应是被监视，
         只有在同一屏里立刻看到"你可以关掉"，这件事才成立。 -->
    <div class="note tiny muted">
      Cluss 从学校系统拿到了下面这些信息，用来让 AI 更懂你。
      <strong>关掉任何一项，AI 就不再用它</strong> —— 不是隐藏，是真的不再参考。
    </div>

    <!-- 总开关 -->
    <label class="master-row" :class="{ 'is-off': !enabled }">
      <div class="master-text">
        <div class="master-name">让 AI 参考我的校园信息</div>
        <div class="master-desc tiny muted">
          {{ enabled ? '已开启' : '已关闭，AI 完全不使用这些信息' }}
        </div>
      </div>
      <span class="switch" :class="{ 'is-on': enabled }">
        <input
          type="checkbox"
          :checked="enabled"
          :disabled="busy"
          aria-label="让 AI 参考我的校园信息"
          @change="toggleMaster"
        />
        <span class="switch-track"><span class="switch-knob"></span></span>
      </span>
    </label>

    <!-- 取不到素材：说清是"暂时"，并给一个可以自己点的刷新 -->
    <div v-if="linked && !available" class="empty tiny muted">
      暂时没取到校园信息。下一次聊天时会自动再试。
      <button type="button" class="link retry" :disabled="refreshing" @click="refresh">
        {{ refreshing ? '读取中…' : '立刻重试' }}
      </button>
    </div>

    <!-- 逐项 -->
    <template v-else-if="available && items.length">
      <div class="sec-head">具体内容</div>

      <div class="list">
        <div v-for="it in items" :key="it.key" class="row" :class="{ 'is-off': enabled && !it.on }">
          <div class="row-main">
            <div class="row-name">{{ it.label }}</div>

            <!-- 学业倒计时：带天数，是最有分量的一项，单独排版 -->
            <div v-if="it.key === 'exams' && it.exams && it.exams.length" class="exams">
              <div
                v-for="e in it.exams"
                :key="e.title + e.target_date"
                class="exam"
                :class="{ 'is-urgent': e.urgent }"
              >
                <span class="exam-title">{{ e.title }}</span>
                <span class="exam-days">{{ examDaysText(e) }}</span>
              </div>
            </div>

            <div v-else class="row-desc tiny muted">{{ it.text }}</div>
          </div>

          <span class="switch" :class="{ 'is-on': enabled && it.on }">
            <input
              type="checkbox"
              :checked="enabled && it.on"
              :disabled="busy || !enabled"
              :aria-label="'让 AI 参考' + it.label"
              @change="toggleItem(it)"
            />
            <span class="switch-track"><span class="switch-knob"></span></span>
          </span>
        </div>
      </div>

      <div class="foot tiny muted">
        这些信息只在你自己的账号里用到，不会出现在任何回答里 —— 你也不会看到 AI 主动提起它们。
      </div>
    </template>

    <!-- 联动了但这个学生在 CI 侧没有任何可用素材 -->
    <div v-else-if="available && !items.length" class="empty tiny muted">
      学校系统里暂时没有可提供的信息。这不影响 Cluss 的任何功能。
    </div>
  </div>
</template>

<script>
// 「校园信息」面板
//
// 为什么要有这个面板（而不是继续让素材只活在提示词里）：
//   素材此前**只**进提示词，且提示词里明令「绝对不要主动提起」——
//   因为一旦被说出来，学生的感受是"被监视"。于是联动做了等于没做：
//   学生完全感知不到 Cluss 认识他，而那批素材也只能偷偷影响一下语气。
//
//   被监视感的本质不是"系统知道"，而是"**我不知道它知道、且我关不掉**"。
//   把同一批素材摆到台面上、给一个真能切断链路的开关，
//   它的性质就从"系统在背后贴标签"变成"我自己决定让 AI 知道什么"。
//
// 独立性：CI 未联动时父组件根本不会渲染本组件，
// 且本组件拿到的 linked=false 也不渲染任何内容 —— 独立部署下它不存在。

export default {
  name: 'CampusContext',
  data: function() {
    return {
      linked: false,
      available: false,
      enabled: true,
      items: [],
      busy: false,
      refreshing: false
    };
  },
  mounted: function() {
    var self = this;
    this.load().then(function() {
      // 缓存为空（首次进入 / 服务刚重启）时自动补一次。
      // 服务端 GET 已经后台触发过一次刷新，但那一趟可能还没回来 ——
      // 与其让学生对着空白"暂时没取到"，不如自己再问一次（这时通常已经有了）。
      // 只补一次，不重试到底：CI 真的不可用时，反复请求只会让面板迟迟不出。
      if (self.linked && !self.available) self.refresh(true);
    });
  },
  methods: {
    load: function() {
      var self = this;
      return this.$http.get('/campus-context').then(function(r) {
        if (r.data.code !== 200) return;
        var d = r.data.data || {};
        self.linked = !!d.linked;
        self.available = !!d.available;
        self.enabled = !!d.enabled;
        self.items = d.items || [];
      }).catch(function() {
        // 读失败就当作"没联动"：这个面板是增强项，
        // 绝不能因为它让"AI 人格与记忆"整个弹窗不能用
        self.linked = false;
      });
    },

    // silent=true：自动补的那一次，失败也不弹提示（学生没要求，不该打扰他）
    refresh: function(silent) {
      var self = this;
      if (this.refreshing) return;
      this.refreshing = true;
      this.$http.post('/campus-context/refresh').then(function(r) {
        if (r.data.code === 200) {
          var d = r.data.data || {};
          self.linked = !!d.linked;
          self.available = !!d.available;
          self.items = d.items || [];
        }
        if (!self.available && !silent) {
          self.$store.dispatch('toast', { message: '还是没取到，下次聊天会自动再试', type: 'warn' });
        }
      }).catch(function() {
        if (!silent) {
          self.$store.dispatch('toast', { message: '读取失败，请稍后再试', type: 'danger' });
        }
      }).then(function() {
        self.refreshing = false;
      });
    },

    toggleMaster: function() {
      var self = this;
      var next = !this.enabled;
      this.busy = true;
      // 乐观更新：开关要跟手，不能等网络回来才动（触屏上尤其明显）
      this.enabled = next;

      this.$http.put('/campus-context/enabled', { enabled: next }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '保存失败');
        self.$store.dispatch('toast', { message: r.data.message, type: 'success' });
      }).catch(function(err) {
        self.enabled = !next; // 回滚
        self.$store.dispatch('toast', { message: (err && err.message) || '保存失败', type: 'danger' });
      }).then(function() {
        self.busy = false;
      });
    },

    toggleItem: function(it) {
      var self = this;
      var next = !it.on;
      this.busy = true;
      it.on = next;

      this.$http.put('/campus-context/items/' + encodeURIComponent(it.key), { on: next })
        .then(function(r) {
          if (r.data.code !== 200) throw new Error(r.data.message || '保存失败');
          self.$store.dispatch('toast', { message: r.data.message, type: 'success' });
        }).catch(function(err) {
          it.on = !next;
          self.$store.dispatch('toast', { message: (err && err.message) || '保存失败', type: 'danger' });
        }).then(function() {
          self.busy = false;
        });
    },

    // 「还有 3 天」「就是今天」—— 人话，别让前端出现 "0 天后"
    examDaysText: function(e) {
      var d = Number(e.days_left);
      if (d <= 0) return '就是今天';
      if (d === 1) return '明天';
      return '还有 ' + d + ' 天';
    }
  }
};
</script>

<style scoped>
.note {
  margin-bottom: var(--gap-md);
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  line-height: 1.6;
}

.note strong {
  color: var(--text-primary);
  font-weight: 600;
}

/* ---------- 总开关 ---------- */
.master-row {
  display: flex;
  align-items: center;
  padding: 11px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  cursor: pointer;
}

.master-text {
  flex: 1;
  min-width: 0;
}

.master-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.master-desc {
  margin-top: 2px;
}

/* 总开关关掉时整块压暗一档：一眼看出"这一片都不生效了" */
.master-row.is-off .master-name {
  color: var(--text-secondary);
}

/* ---------- 滑块开关 ---------- */
/*
 * 为什么不用原生 checkbox：它在 Chrome 里只有 13px 见方，
 * 触屏上既看不清也点不准（项目红线：常显控件命中区至少 40px）。
 * 这里做成 46×28 的滑块，再用 ::after 把命中区撑到 44px 高。
 * input 视觉上隐藏但**保留在文档流里**（不用 display:none）——
 * 键盘 focus 与读屏都还能工作。
 */
.switch {
  position: relative;
  flex-shrink: 0;
  margin-left: 10px;
}

.switch input {
  position: absolute;
  left: 0;
  top: 0;
  width: 46px;
  height: 28px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 2;
}

/* 命中区向四周撑开（视觉不变） */
.switch::after {
  content: '';
  position: absolute;
  left: -4px;
  right: -4px;
  top: 50%;
  height: 44px;
  transform: translateY(-50%);
  background: transparent;
  z-index: 1;
}

.switch-track {
  display: block;
  width: 46px;
  height: 28px;
  border-radius: 14px;
  background: var(--ink-3);
  transition: background var(--transition);
}

.switch-knob {
  display: block;
  width: 24px;
  height: 24px;
  margin: 2px;
  border-radius: 50%;
  background: var(--text-primary);
  /* 位移用 transform（合成层），不用 margin/left（会触发重排） */
  transform: translateX(0);
  transition: transform var(--transition);
}

.switch.is-on .switch-track {
  background: var(--accent);
}

.switch.is-on .switch-knob {
  transform: translateX(18px);
}

/* 禁用态（总开关关着时，逐项不可操作） */
.switch input:disabled {
  cursor: not-allowed;
}

.switch input:disabled + .switch-track {
  opacity: 0.5;
}

@media (hover: hover) {
.switch:hover .switch-track {
  background: var(--ink-4, var(--ink-3));
}
.switch.is-on:hover .switch-track {
  background: var(--accent);
}
}

/* 键盘可见焦点（触屏不显示，靠 :focus-visible 区分） */
.switch input:focus-visible + .switch-track {
  box-shadow: 0 0 0 2px var(--accent);
}

/* ---------- 列表 ---------- */
.sec-head {
  margin: var(--gap-md) 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

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
  padding: 9px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
}

/* 逐项关掉：压暗 + 名称转次级色，与开启状态明显区分 */
.row.is-off {
  opacity: 0.72;
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-name {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.45;
}

.row-desc {
  margin-top: 2px;
  line-height: 1.45;
  word-break: break-word;
}

/* ---------- 学业倒计时 ---------- */
.exams {
  margin-top: 4px;
}

.exam {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 3px 0;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.exam-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.exam-days {
  flex-shrink: 0;
  margin-left: 10px;
  font-variant-numeric: tabular-nums;
}

/* 临考（≤14 天）：换成强调色 + 加粗，这是唯一需要"催一下"的信息 */
.exam.is-urgent .exam-title {
  color: var(--text-primary);
  font-weight: 600;
}

.exam.is-urgent .exam-days {
  color: var(--warning, var(--accent));
  font-weight: 600;
}

/* ---------- 其它 ---------- */
.empty {
  padding: 14px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  text-align: center;
  line-height: 1.7;
}

.retry {
  display: inline-block;
  margin-top: 4px;
}

.foot {
  margin-top: var(--gap-md);
  line-height: 1.6;
}
</style>
