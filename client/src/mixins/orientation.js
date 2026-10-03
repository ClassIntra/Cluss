// 方向判定 + 竖屏抽屉 + 边缘侧滑手势（对话 / 拍题 / 作文三页共用）
//
// ============================================================
// 一、为什么不能再用「视口宽高比」判断方向
// ============================================================
//
// 软键盘弹出时视口高度会掉 300px 以上。在 680×960 的竖屏平板上，
// 键盘一起来视口就变成约 680×630 —— 宽度反而比高度大，
// 宽高比判定直接翻转成"横屏"。于是三件事同时发生，
// 而且都发生在学生**正在打字**的时候：
//
//   1. JS 的 isPortrait 变 false → 常驻侧栏突然冒出来，正文被挤成一条缝
//   2. CSS 的 @media (orientation: portrait) 失效 → 竖屏专属样式消失
//   3. 反过来触发 @media (orientation: landscape) and (max-height: 800px)
//
// 键盘只改变**高度**，不改变方向。所以判据换成**设备方向**
// （screen.orientation），并把结果写到 <html> 的 class 上，
// 让 CSS 和 JS 走同一个真相来源 —— 各判各的迟早会不一致。
//
// ============================================================
// 二、两个类名，各管一件事
// ============================================================
//
//   html.is-portrait  设备物理竖屏（不管多宽）
//   html.use-drawer   设备竖屏 **且** 视口宽度 ≤ 1024 → 侧栏改抽屉
//
// 为什么分开：1600×2560 的大竖屏平板物理上是竖屏，但横向空间够，
// 侧栏常驻更好用；只有窄竖屏（680~1024）才需要抽屉。
//
// 关键：**抽屉的样式必须由 use-drawer 驱动，不能再用媒体查询**。
// 因为 JS 在 use-drawer 为真时会把侧栏 v-show 隐藏起来 ——
// 如果 CSS 那边因为键盘翻转而不把它变成抽屉，侧栏就彻底没入口了。

function detectPortrait() {
  // 首选：浏览器直接给的方向
  try {
    var so = window.screen && window.screen.orientation;
    if (so && typeof so.type === 'string') {
      if (so.type.indexOf('portrait') === 0) return true;
      if (so.type.indexOf('landscape') === 0) return false;
    }
  } catch (e) { /* 老 WebView 没有 screen.orientation */ }

  // 次选：物理屏幕尺寸（同样不受键盘影响）
  try {
    var sw = window.screen && window.screen.width;
    var sh = window.screen && window.screen.height;
    if (sw && sh && sw !== sh) return sw < sh;
  } catch (e) { /* ignore */ }

  // 兜底：只能看视口比例（会被键盘影响，但总比没有强）
  return window.innerHeight >= window.innerWidth;
}

var DRAWER_MAX_WIDTH = 1024;   // 超过这个宽度就不必用抽屉
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
    this.syncOrientation();

    // 只在方向真的可能变时重算。单纯的高度变化（地址栏、软键盘）不触发 ——
    // 这正是原来那个 bug 的来源。
    window.addEventListener('orientationchange', this.syncOrientation);
    if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
      window.screen.orientation.addEventListener('change', this.syncOrientation);
    }
    // 宽度变化仍要跟（旋转会改宽度；桌面拖窗口也要跟），但节流到一帧
    window.addEventListener('resize', this.onViewportResize);

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
    window.removeEventListener('orientationchange', this.syncOrientation);
    if (window.screen && window.screen.orientation && window.screen.orientation.removeEventListener) {
      window.screen.orientation.removeEventListener('change', this.syncOrientation);
    }
    window.removeEventListener('resize', this.onViewportResize);

    document.removeEventListener('touchstart', this._onTouchStart);
    document.removeEventListener('touchmove', this._onTouchMove);
    document.removeEventListener('touchend', this._onTouchEnd);
    document.removeEventListener('touchcancel', this._onTouchEnd);
    document.documentElement.classList.remove('drawer-open');
  },

  methods: {
    // resize 很密（地址栏收缩、键盘动画都会刷），节流到一帧
    onViewportResize: function() {
      if (this._resizeQueued) return;
      this._resizeQueued = true;
      var self = this;
      var raf = window.requestAnimationFrame || function(cb) { return setTimeout(cb, 16); };
      raf(function() {
        self._resizeQueued = false;
        self.syncOrientation();
      });
    },

    syncOrientation: function() {
      var portrait = detectPortrait();
      // 宽度用视口宽度：它不受键盘影响（键盘只减高度），旋转时会变
      var narrow = window.innerWidth <= DRAWER_MAX_WIDTH;
      var useDrawer = portrait && narrow;

      this.isPortrait = portrait;
      this.useDrawer = useDrawer;

      // 写到 <html> 上，让 CSS 用同一个判据（见文件头的说明）
      var root = document.documentElement;
      root.classList.toggle('is-portrait', portrait);
      root.classList.toggle('use-drawer', useDrawer);

      // 不再是抽屉模式时把抽屉状态收干净，否则转回横屏会看到遮罩残留
      if (!useDrawer) {
        this.drawerOpen = false;
        this.drawerDragX = null;
      }
    },

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
