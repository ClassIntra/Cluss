/**
 * 图表全屏查看器
 *
 * 为什么是命令式浮层而不是 Vue 组件：
 *   它要被 6 个页面共用，而这些页面的模板各不相同。做成组件就得在
 *   6 个模板里各加一行、各接一次 props、各处理一次销毁；做成浮层
 *   则 mixin 里一行 openChartViewer(el) 就够了，样式统一收在 global.css。
 *
 * 为什么必须要有它：
 *   聊天气泡在竖屏平板上只有三百来像素宽，流程图里的字会小到看不清。
 *   "能画出来"和"看得清"是两件事，只做前者等于没做。
 *
 * 手势：单指/鼠标拖动平移、双指捏合缩放、滚轮缩放、双击复位，
 *       点图外的空白处或按 ESC 关闭。
 */

var current = null;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function svgOf(source) {
  if (typeof source === 'string') return source;
  if (source && source.querySelector && source.querySelector('svg')) return source.innerHTML;
  return '';
}

/**
 * 打开图表查看器
 * @param {Element|string} source 已渲染好的 .mermaid-chart 容器，或一段 SVG 字符串
 */
export function openChartViewer(source) {
  closeChartViewer();

  var svgHtml = svgOf(source);
  if (!svgHtml) return;

  var overlay = document.createElement('div');
  overlay.className = 'chart-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '图表查看');
  overlay.innerHTML =
    '<div class="chart-viewer-bar">' +
      '<span class="chart-viewer-tip">双指缩放 · 拖动平移</span>' +
      '<div class="chart-viewer-actions">' +
        '<button type="button" class="chart-viewer-btn" data-act="out" aria-label="缩小">−</button>' +
        '<span class="chart-viewer-scale">100%</span>' +
        '<button type="button" class="chart-viewer-btn" data-act="in" aria-label="放大">＋</button>' +
        '<button type="button" class="chart-viewer-btn" data-act="fit">适应</button>' +
        '<button type="button" class="chart-viewer-btn is-close" data-act="close">关闭</button>' +
      '</div>' +
    '</div>' +
    '<div class="chart-viewer-stage"><div class="chart-viewer-inner"></div></div>';

  var stage = overlay.querySelector('.chart-viewer-stage');
  var inner = overlay.querySelector('.chart-viewer-inner');
  var scaleEl = overlay.querySelector('.chart-viewer-scale');

  inner.style.position = 'absolute';
  inner.style.left = '0';
  inner.style.top = '0';
  inner.style.width = '100%';
  inner.style.transformOrigin = '0 0';

  inner.innerHTML = svgHtml;
  var svg = inner.querySelector('svg');
  if (svg) {
    // 气泡里那套「按自然宽夹」的宽度三件套在这里必须让位：
    // 缩放由查看器自己管，留着 min-width 会把舞台撑破。
    svg.style.maxWidth = '100%';
    svg.style.minWidth = '0';
    svg.style.width = '100%';
    svg.style.height = 'auto';
    svg.style.display = 'block';
  }

  // 缩放/平移状态放闭包里，不挂在 DOM 节点上
  var t = { s: 1, x: 0, y: 0 };

  function apply() {
    inner.style.transform = 'translate(' + t.x + 'px,' + t.y + 'px) scale(' + t.s + ')';
    scaleEl.textContent = Math.round(t.s * 100) + '%';
  }

  function fit() {
    // 先归位再量：否则量到的是被 transform 放大后的框
    inner.style.transform = 'none';
    var w = inner.offsetWidth;
    var h = inner.offsetHeight;
    if (!w || !h) { t = { s: 1, x: 0, y: 0 }; apply(); return; }
    var contain = Math.min(
      (stage.clientWidth - 32) / w,
      (stage.clientHeight - 32) / h
    );
    // 只求「装得下」是不够的 —— 学生点开查看器的唯一理由就是"看不清"，
    // 而一张 960 宽的甘特图整个装进 360 的手机时缩放只有 0.34，字还是 3px，等于白点一次。
    // 所以要求至少按**图的原始尺寸**显示：viewBox 一个单位 = 1 个 CSS 像素。
    // vbW / w 正好就是这个缩放比（w 是图当前被布局成的宽度），此时 mermaid 的 16px 字
    // 就是实打实的 16px。两者取大，宁可让他滑、也不让他眯。
    var vbW = (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) || 0;
    var oneToOne = vbW ? vbW / w : 0;
    t.s = clamp(Math.max(contain, oneToOne), 0.05, 10);
    // 装得下就居中；装不下就**贴左上**。
    // 居中看着对称，实则有害：流程图是从上往下读的，12 个节点的图在手机上必然超高，
    // 居中的结果是学生点开先看到图的正中间，起点框反而在屏幕外 —— 而"图比屏幕大"
    // 恰恰就是最需要看清的那一类，第一眼必须落在起点上。
    var cw = stage.clientWidth;
    var ch = stage.clientHeight;
    t.x = w * t.s <= cw ? (cw - w * t.s) / 2 : 0;
    t.y = h * t.s <= ch ? (ch - h * t.s) / 2 : 0;
    apply();
  }

  function zoomAt(factor, cx, cy) {
    var next = clamp(t.s * factor, 0.1, 10);
    var k = next / t.s;
    t.x = cx - k * (cx - t.x);
    t.y = cy - k * (cy - t.y);
    t.s = next;
    apply();
  }

  // ---------- 事件 ----------

  function onBarClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'close') { closeChartViewer(); return; }
    if (act === 'fit') { fit(); return; }
    var cx = stage.clientWidth / 2;
    var cy = stage.clientHeight / 2;
    if (act === 'in') zoomAt(1.25, cx, cy);
    if (act === 'out') zoomAt(0.8, cx, cy);
  }

  var dragging = false;
  var moved = false;
  var lastX = 0;
  var lastY = 0;
  var pinchDist = 0;

  function onPointerDown(e) {
    if (pinchDist) return;                 // 正在双指缩放，别当成拖拽
    dragging = true;
    moved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    // 监听挂在 document 上而不是用指针捕获：捕获会把 click 的 target
    // 改写成捕获元素，我们就分不清"点在图上"和"点在空白处"了
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    var dx = e.clientX - lastX;
    var dy = e.clientY - lastY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    t.x += dx;
    t.y += dy;
    lastX = e.clientX;
    lastY = e.clientY;
    apply();
    if (e.cancelable) e.preventDefault();
  }

  function onPointerUp() {
    dragging = false;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
  }

  function onStageClick(e) {
    // 拖完手松开那一下不算点击，否则每次平移都会顺手把它关掉
    if (moved) { moved = false; return; }
    if (e.target.closest('.chart-viewer-bar')) return;
    // 点在图上不关：平板上很容易误触，关掉还得重新找回来
    if (e.target.closest('svg')) return;
    closeChartViewer();
  }

  function onDblClick(e) {
    if (e.target.closest('svg')) fit();
  }

  function onWheel(e) {
    e.preventDefault();
    var rect = stage.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - rect.left, e.clientY - rect.top);
  }

  function onTouchStart(e) {
    if (e.touches.length === 2) {
      dragging = false;
      pinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }

  function onTouchMove(e) {
    if (e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault();
    var dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (!pinchDist) { pinchDist = dist; return; }
    var rect = stage.getBoundingClientRect();
    var cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
    var cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
    zoomAt(dist / pinchDist, cx, cy);
    pinchDist = dist;
  }

  function onTouchEnd() {
    pinchDist = 0;
  }

  function onKey(e) {
    if (e.key === 'Escape') { closeChartViewer(); return; }
    var cx = stage.clientWidth / 2;
    var cy = stage.clientHeight / 2;
    if (e.key === '+' || e.key === '=') zoomAt(1.25, cx, cy);
    if (e.key === '-') zoomAt(0.8, cx, cy);
    if (e.key === '0') fit();
  }

  overlay.addEventListener('click', onBarClick);
  stage.addEventListener('click', onStageClick);
  stage.addEventListener('dblclick', onDblClick);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('touchstart', onTouchStart, { passive: true });
  stage.addEventListener('touchmove', onTouchMove, { passive: false });
  stage.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('keydown', onKey);

  var prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  current = {
    overlay: overlay,
    onKey: onKey,
    onPointerUp: onPointerUp,
    // ⚠️ onPointerMove 也必须一起存下来。
    //   正常收尾（拖完松开）由 onPointerUp 自己摘掉它，所以平时看不出问题；
    //   但"拖动中途被关闭"（拖动时切页、或拖动中触发关闭）走的是
    //   closeChartViewer，那条路径不经过 onPointerUp —— 不在这里存一份，
    //   外面就没有任何办法把它从 document 上摘下来。
    onPointerMove: onPointerMove,
    prevOverflow: prevOverflow
  };

  // 挂上去的下一帧再量尺寸：刚 append 时 clientWidth 可能还是 0
  requestAnimationFrame(function() {
    if (current && current.overlay === overlay) fit();
  });
}

export function closeChartViewer() {
  if (!current) return;
  var c = current;
  current = null;
  document.removeEventListener('keydown', c.onKey);
  // 卸 pointermove 时必须传 onPointerMove —— 原先传的是 c.onPointerUp，
  // 而 pointermove 上挂的根本不是它，等于一次什么都没删的"假清理"。
  // 后果：只要在拖动中途关闭浮层（切页最常见），onPointerMove 就永久留在
  // document 上，且它闭包里的 dragging 仍为 true —— 此后页面上每一次
  // pointermove 都会对着一块已被移除的浮层执行 apply()（写 transform）
  // 并 preventDefault()，白白吃掉每一次手势。
  document.removeEventListener('pointermove', c.onPointerMove);
  document.removeEventListener('pointerup', c.onPointerUp);
  document.removeEventListener('pointercancel', c.onPointerUp);
  document.documentElement.style.overflow = c.prevOverflow;
  if (c.overlay.parentNode) c.overlay.parentNode.removeChild(c.overlay);
}
