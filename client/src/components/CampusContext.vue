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
    <label class="master-row" :class="{ 'is-on': enabled, 'is-off': !enabled }">
      <div class="master-text">
        <div class="master-name">让 AI 参考我的校园信息</div>
        <div class="master-desc tiny muted">
          {{ enabled ? '已开启' : '已关闭，AI 完全不使用这些信息' }}
        </div>
      </div>
      <ToggleSwitch
        :checked="enabled"
        :disabled="busy"
        label="让 AI 参考我的校园信息"
        @change="toggleMaster"
      />
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

          <ToggleSwitch
            :checked="enabled && it.on"
            :disabled="busy || !enabled"
            :label="'让 AI 参考' + it.label"
            @change="toggleItem(it, $event)"
          />
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

// 开关外观走全站唯一的那个组件（此前本文件自带一套，与设置弹窗尺寸/配色都不同）
import ToggleSwitch from './ToggleSwitch.vue';

export default {
  name: 'CampusContext',
  components: { ToggleSwitch },
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

    // next 由开关组件给出（DOM 已经点过了）：这里不自己取反 ——
    // 自取反会和组件的受控回写打架，快速连点时状态会来回跳
    toggleMaster: function(next) {
      var self = this;
      next = !!next;
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

    toggleItem: function(it, next) {
      var self = this;
      next = !!next;
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
/* 与设置弹窗里的「参考我的历史数据」同款：都是"整行可点的开关卡片"，
   所以边框、底色、开启态的强调色必须一样，否则两个面板像两个产品。 */
.master-row {
  display: flex;
  align-items: center;
  padding: 11px 12px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-md);
  background: var(--ink-1);
  cursor: pointer;
  transition: border-color var(--transition), background var(--transition);
}

.master-row.is-on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

@media (hover: hover) {
  /* 只放 hover 规则本身 —— 顺手写进来的常规样式会变成"只在有鼠标的设备生效" */
  .master-row:hover {
    border-color: var(--accent);
  }
}

.master-text {
  flex: 1;
  min-width: 0;
}

/* 开关不再自带外边距（原先写在校内那套 .switch 上），由使用处决定呼吸距离 */
.master-row > .tgl,
.row > .tgl {
  margin-left: 10px;
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
