import { mountMermaidCharts, invalidateMermaidCharts } from '@/utils/mermaid';
import { openChartViewer, closeChartViewer } from '@/utils/mermaid-viewer';

/**
 * 图表渲染 mixin
 *
 * 给"会渲染 AI 回复"的页面挂上就行，页面模板一行都不用改：
 *   - updated 后扫一遍本组件里的 .mermaid-chart，把待渲染的画出来
 *   - 点图表全屏放大（平板上不看全屏根本读不清流程图里的字）
 *   - 切主题后按新主题重画（主题只是换 <html data-theme>，不会触发组件重渲染，
 *     不主动听就永远停在旧配色的图上）
 *
 * 为什么不注册成全局 mixin：那样每个小按钮组件（导航项、分段控件…）
 * 每次更新都会扫一遍自己的子树，纯属浪费。只挂真正渲染 Markdown 的 5 个页面。
 */
export default {
  computed: {
    // 前缀 $ 是 Vue 约定：不会和页面的 data/computed 撞名
    $_mdIsDark: function() {
      try {
        return !!this.$store.getters['theme/isDark'];
      } catch (e) {
        return false;
      }
    },

    // 当前是否正在流式输出。各页面用自己的 data 声明（对话页是 sending），
    // 没声明的页面恒为 false —— 行为与加这个判断之前完全一致，不会漏画。
    //
    // 需要它的原因见 updated 里的说明：流式期间这次扫描 100% 是空转，
    // 而对话页的整棵子树包含侧栏会话列表和全部历史气泡，每帧扫一遍不便宜。
    $_mdStreaming: function() {
      return !!(this.sending || this.streaming);
    }
  },

  watch: {
    '$_mdIsDark': function() {
      // 丢掉"已渲染"标记 → 下一次扫描按新主题重画（缓存按主题分开存，不会拿到旧图）
      if (this.$el) {
        invalidateMermaidCharts(this.$el);
        this.$_mdMountCharts();
      }
    },

    // 流式**结束**的那一帧补扫一次。
    // updated 在流式期间被跳过了，而真正的图表只可能出现在收尾那次全量渲染之后
    // （流式中恒为 data-pending 占位），所以这里是唯一会画出图表的时机。
    // 不补这一下，"回答里带流程图"就会变成永远停在骨架上。
    '$_mdStreaming': function(now) {
      if (!now) this.$nextTick(this.$_mdMountCharts);
    }
  },

  mounted: function() {
    this.$_mdBindChartTap();
    this.$_mdMountCharts();
  },

  // keep-alive 回来的页面同样要补一次（重新进入时 DOM 是复用的）
  activated: function() {
    this.$_mdMountCharts();
  },

  updated: function() {
    // 流式输出期间**不扫图表**。
    //
    // 为什么必须拦：updated 在每一次组件重渲染之后都会触发，而流式期间每一帧
    // 都在改 m.html —— 于是每帧都要对整棵子树跑一次 querySelectorAll('.mermaid-chart')。
    // 可流式期间渲染出来的图表恒为 data-pending="1" 的占位（markdown 的 lightMode
    // 决定的），真正的绘制必然发生在收尾那一次全量渲染之后 —— 这次扫描 100% 空转。
    // 而对话页的整棵子树包含侧栏会话列表和全部历史气泡，每帧扫一遍不便宜。
    //
    // 收尾的补扫由 $_mdStreaming 的 watcher 负责（见上），不会漏画。
    if (this.$_mdStreaming) return;
    this.$_mdMountCharts();
  },

  beforeDestroy: function() {
    // 全屏浮层挂在 body 上，不随组件销毁；切页时必须自己收掉
    closeChartViewer();
    if (this.$el && this.$el.removeEventListener) {
      this.$el.removeEventListener('click', this.$_mdOnChartTap);
    }
  },

  methods: {
    $_mdMountCharts: function() {
      mountMermaidCharts(this.$el, this.$_mdIsDark);
    },

    $_mdBindChartTap: function() {
      if (!this.$el || !this.$el.addEventListener) return;
      // 用委托而不是给每个图表绑：图表是 v-html 注入的，
      // 每次重渲染都会换一批新节点，逐个绑必然漏。
      this.$el.addEventListener('click', this.$_mdOnChartTap);
    },

    $_mdOnChartTap: function(e) {
      var target = e.target;
      if (!target || !target.closest) return;
      // 图里的链接有自己的去处，不要被"点图放大"截胡
      if (target.closest('a')) return;
      var chart = target.closest('.mermaid-chart');
      if (!chart) return;
      // 只有真画出来的图才给放大；骨架与错误态点开是空的，反而让人困惑
      if (chart.getAttribute('data-state') !== 'done') return;
      if (!chart.querySelector('svg')) return;
      openChartViewer(chart);
    }
  }
};
