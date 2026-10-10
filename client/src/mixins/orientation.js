// 方向适配 + 竖屏抽屉 + 边缘侧滑手势（对话 / 拍题 / 作文等页共用）
//
// ============================================================
// ⚠️ 方向**不在这里算**
// ============================================================
// 唯一真相源是 `utils/device-orientation.js`（由 `main.js` 启动，全局只跑一份）。
// 本 mixin 只做两件事：
//   1. 订阅方向结果，投影到组件的 `isPortrait` / `useDrawer` 供模板用；
//   2. 提供竖屏抽屉的开合状态与左缘侧滑手势。
//
// 为什么必须这样切：方向原来散在四处各算各的（本 mixin、TabBar、Study 页、
// CSS 媒体查询），判据还各不相同（设备 API / 物理尺寸 / 视口比例），
// 任两处不一致就会出现「同一屏一半横一半竖」。现在 <html> 上的类与各页面
// 模板绑定**同源**，页面生灭不再影响方向类。
//
// 为什么不用「视口宽高比」判方向：软键盘只改变**高度**，680×960 的竖屏平板
// 键盘一起来视口变成约 680×630 —— 宽高比直接翻转成"横屏"，侧栏突然冒出来、
// 正文被挤成一条缝，而且就发生在学生**正在打字**的时候。
// 判据的完整推导（含受管平板上 screen.orientation.type 撒谎的实测）见
// utils/device-orientation.js。
//
// 两个类名各管一件事（仍由 util 写到 <html> 上）：
//   html.is-portrait  设备竖屏（不管多宽）
//   html.use-drawer   设备竖屏 **且** 视口宽度 ≤ 1024 → 侧栏改抽屉
// 1600×2560 的大竖屏平板物理上是竖屏，但横向空间够，侧栏常驻更好用；
// 只有窄竖屏（680~1024）才需要抽屉。**抽屉样式必须由 use-drawer 驱动，
// 不能再用媒体查询**：JS 在 use-drawer 为真时会把侧栏 v-show 隐藏起来，
// CSS 那边若因为键盘翻转而不把它变成抽屉，侧栏就彻底没入口了。

import { subscribeOrientation } from '../utils/device-orientation';

var EDGE_ZONE = 26;            // 左边缘多宽算"从边缘起手"
var OPEN_RATIO = 0.34;         // 拖过抽屉宽度的这个比例就判定为打开

export default {
  data: function() {
    return {
      isPortrait: false,
      useDrawer: false,
      drawerOpen: false,
      // 手势跟随中的位移（px）。null 表示没在拖 —— 此时交给 CSS 过渡
      drawerDragX: null
    };
  },

  watch: {
    // 抽屉开合写到 <html> 上：底栏（TabBar）等抽屉之外的元素
    // 也要跟着退让（视差），它们拿不到组件实例，只能认类名
    drawerOpen: function(val) {
      this.syncDrawerClass();
    }
  },

  computed: {
    // 拖动时用行内样式接管 transform；松手后置回 null，让 CSS 的过渡接手
    drawerStyle: function() {
      if (this.drawerDragX === null) return null;
      return {
        transform: 'translateX(calc(-102% + ' + this.drawerDragX + 'px))',
        transition: 'none'
      };
    }
  },

  mounted: function() {
    var self = this;

    // 订阅全局方向结果（订阅时会立刻回调一次当前值）
    this._unsubOrientation = subscribeOrientation(function(s) {
      if (self.isPortrait === s.portrait && self.useDrawer === s.useDrawer) return;
      self.isPortrait = s.portrait;
      self.useDrawer = s.useDrawer;
      // 不再是抽屉模式时把抽屉状态收干净，否则转回横屏会看到遮罩残留
      if (!s.useDrawer) {
        self.drawerOpen = false;
        self.drawerDragX = null;
      }
    });

    // 侧滑手势
    this._onTouchStart = this.handleTouchStart.bind(this);
    this._onTouchMove = this.handleTouchMove.bind(this);
    this._onTouchEnd = this.handleTouchEnd.bind(this);
    document.addEventListener('touchstart', this._onTouchStart, { passive: true });
    document.addEventListener('touchmove', this._onTouchMove, { passive: false });
    document.addEventListener('touchend', this._onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', this._onTouchEnd, { passive: true });

    // 新页面从关闭状态起手；前一个页面销毁时若抽屉开着，类会残留，这里兜底清掉
    document.documentElement.classList.remove('drawer-open');
  },

  beforeDestroy: function() {
    // ⚠️ 只退订，**不动** is-portrait / use-drawer —— 那两个类归 utils/device-orientation
    // 全局维护。切页时新组件先挂载、旧组件后销毁，在这里清理会把新页面刚写好的类抹掉。
    if (this._unsubOrientation) {
      this._unsubOrientation();
      this._unsubOrientation = null;
    }

    document.removeEventListener('touchstart', this._onTouchStart);
    document.removeEventListener('touchmove', this._onTouchMove);
    document.removeEventListener('touchend', this._onTouchEnd);
    document.removeEventListener('touchcancel', this._onTouchEnd);
    document.documentElement.classList.remove('drawer-open');
  },

  methods: {
    syncDrawerClass: function() {
      document.documentElement.classList.toggle('drawer-open', !!this.drawerOpen);
    },

    toggleDrawer: function() {
      this.drawerOpen = !this.drawerOpen;
    },

    openDrawer: function() {
      this.drawerOpen = true;
    },

    closeDrawer: function() {
      this.drawerOpen = false;
      this.drawerDragX = null;
    },

    // ---- 边缘侧滑 ----
    //
    // 竖屏平板上"左上角的菜单按钮"离拇指很远，侧滑是更自然的入口。
    // 只在左边缘起手（26px 内）或抽屉已打开时才接管，
    // 避免和学生真正想做的横向滚动（表格、代码块）抢手势。

    handleTouchStart: function(e) {
      if (!this.useDrawer) return;
      var t = e.touches && e.touches[0];
      if (!t) return;

      var fromEdge = t.clientX <= EDGE_ZONE;
      if (!fromEdge && !this.drawerOpen) return;

      this._drag = {
        startX: t.clientX,
        startY: t.clientY,
        startAt: Date.now(),
        // 打开状态下起手 = 准备关闭；关闭状态下从边缘起手 = 准备打开
        mode: this.drawerOpen ? 'close' : 'open',
        locked: null,   // 'h' 横滑 / 'v' 竖滚，判定后锁定
        // 起手时的抽屉位移。动画中途抓住时它不是端点值 ——
        // 拖动从当前位置接续（真正的"打断"，见 handleTouchMove 的锁定分支）
        startOffset: 0
      };
      this._drawerWidth = this.drawerWidth();
    },

    drawerWidth: function() {
      var el = this.$el && this.$el.querySelector && this.$el.querySelector('.app-sidebar-drawer');
      if (el && el.offsetWidth) return el.offsetWidth;
      return Math.min(320, window.innerWidth * 0.84);
    },

    // 抽屉当前的实际位移（0 = 全关，W = 全开）。
    // 关键：读的是 getComputedStyle 的**插值中**值 ——
    // CSS 过渡进行到一半时，这里拿到的是半路位置，抓住就接住，不跳变。
    currentDrawerOffset: function() {
      var W = this._drawerWidth || this.drawerWidth();
      var fallback = this.drawerOpen ? W : 0;
      var el = this.$el && this.$el.querySelector && this.$el.querySelector('.app-sidebar-drawer');
      if (!el) return fallback;
      try {
        var t = getComputedStyle(el).transform;
        if (!t || t === 'none') return fallback;
        var M = window.WebKitCSSMatrix || window.DOMMatrix;
        if (!M) return fallback;
        var m = new M(t);
        // 关闭态是 translateX(-102%)，映射回 0..W
        var offset = m.m41 + W * 1.02;
        return Math.max(0, Math.min(W, offset));
      } catch (e) {
        return fallback;
      }
    },

    handleTouchMove: function(e) {
      var d = this._drag;
      if (!d) return;
      var t = e.touches && e.touches[0];
      if (!t) return;

      var dx = t.clientX - d.startX;
      var dy = t.clientY - d.startY;

      // 前 10px 内先判定是横滑还是竖滚：竖滚就立刻放手，
      // 不然会把学生本来要滚动的动作吞掉
      if (d.locked === null) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        d.locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
        if (d.locked === 'v') { this._drag = null; return; }
        // 锁定为横滑的瞬间，从过渡的**当前位置**接手 ——
        // 比如抽屉正在播放关闭动画，这时抓住边缘，抽屉停在半路跟着手指走，
        // 松手再决定开还是关；若是从头重播，会先瞬移回端点，一眼假。
        d.startOffset = this.currentDrawerOffset();
        this.drawerDragX = d.startOffset;
        // 从关闭侧拖出：抽屉正在"出现"，底栏立刻开始退让，
        // 不用等松手判定 —— 视差要跟手，而不是跟结果
        if (d.mode === 'open') {
          document.documentElement.classList.add('drawer-open');
        }
      }

      if (d.locked !== 'h') return;

      // 接管了手势就阻止默认行为，否则页面会跟着横向滑动
      if (e.cancelable) e.preventDefault();

      var offset = Math.max(0, Math.min(this._drawerWidth, d.startOffset + dx));
      this.drawerDragX = offset;
    },

    handleTouchEnd: function() {
      var d = this._drag;
      this._drag = null;
      if (!d || d.locked !== 'h') return;

      var offset = this.drawerDragX;
      this.drawerDragX = null;   // 交回 CSS 过渡
      if (offset === null || offset === undefined) return;

      var elapsed = Math.max(1, Date.now() - d.startAt);
      var velocity = offset / elapsed;   // px/ms
      var far = offset > this._drawerWidth * OPEN_RATIO;
      var flick = velocity > 0.35;

      if (d.mode === 'open') {
        this.drawerOpen = !!(far || flick);
      } else {
        // 关闭方向：拖回得足够多就保持关闭
        this.drawerOpen = !(offset < this._drawerWidth * (1 - OPEN_RATIO) || flick);
      }

      // watcher 只在值变化时触发：拖动期间手动加上的类，
      // 要在这里按最终状态对齐（比如拖出一半又放回去）
      this.syncDrawerClass();
    }
  }
};
