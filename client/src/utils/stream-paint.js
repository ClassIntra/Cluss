// 流式渲染的增量封装 —— 把「每帧全量重渲染」变成「冻结前缀 + 只渲染尾巴」
//
// ── 为什么需要它（实测数据，真 Chrome，6x CPU 降频模拟平板）──
// renderStream 每帧对**整篇**内容跑一遍 marked + DOMPurify，再把结果整块塞进
// innerHTML。每帧成本随当前长度线性增长，总量是 O(n²)：
//     1245 字 → 23.6ms/帧、卡顿 2 次
//     2490 字 → 22.2ms/帧、卡顿 2 次
//     3735 字 → 32.7ms/帧、卡顿 21 次
//     4980 字 → 35.7ms/帧、卡顿 49 次
// 而 LOW_PERF_MIN_GAP(80ms) 只在低端设备兜底，非低端走 rAF(16ms) —— 35ms/帧
// 意味着**每帧都掉**。长解题过程（三五千字）就会明显一顿一顿。
//
// 做法：已经不会再变的前缀渲染一次就永久缓存，每帧只重渲染尾巴那一小块。
// 尾巴通常只有几十到几百字符，单帧成本因此近似常数。
//
// ── 正确性 ──
// 关键全在「切点是否安全」。Markdown 的块级结构会跨行，切错位置会让两段各自
// 渲染出与整体不同的结果。最常见的两个坑：
//   · 松散列表：`- a\n\n- b` 是**同一个** <ul>（marked 标为 loose，每项包 <p>），
//     从中间切开会变成两个 tight <ul>，DOM 与样式都变了；
//   · 末行是列表项时，后面带缩进的行会被当成该项的续行。
// 所以判定刻意保守：**判不准就不切**，退化成全量渲染（= 改造前的行为），
// 宁慢不错。切点规则见 findSafeCut 的注释。
//
// 安全性另有一道实证闸门：scripts 里的差分测试会把「分块渲染」与「整篇渲染」
// 在每个流式前缀上逐一比对，覆盖真实回答的语料。规则写错会被它当场抓住。

// 行首是围栏（``` 或 ~~~）—— 用于跟踪是否还在代码块内
var FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

// 列表项：`- x` / `* x` / `+ x` / `1. x` / `1) x`
var LIST_LINE = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;

// 可能「接上」前一块的行首：缩进、列表项、引用、表格行
// 出现在这些行之前就不切
function isContinuationStart(line) {
  if (/^\s/.test(line)) return true;          // 缩进续行 / 缩进代码块
  if (LIST_LINE.test(line)) return true;      // 列表项（可能与前面的列表是同一个）
  if (/^\s*>/.test(line)) return true;        // 引用块
  if (/^\s*\|/.test(line)) return true;       // 表格行
  return false;
}

// 行首是一个「块级标记」—— markdown 无论如何都会在这里开一个新块。
// 返回块类型；'' 表示这一行不是块起始。
//
// ⚠️ 这里只收**被差分测试实测证安全**的两类。别凭直觉往上加，下面两处
//    已经踩过坑（2026-10-11，由 .tmp-qa/verify-stream-paint.cjs 当场抓出）：
//
//   · 代码围栏（fence）曾经收过 —— 错。
//     '用程序验算一下结果：\n```py\n' 整篇渲染是 `<p>用程序验算一下结果：<br></p>` + 围栏，
//     而切分后冻结段 '用程序验算一下结果：\n' 的**尾部换行被 marked 吃掉**，`<br>` 就没了。
//     同一个换行，整篇时算段落内换行（breaks 生效）、切开后不算 —— 位置一换语义就变。
//
//   · 列表项（list）曾经收过 —— 更隐蔽的错。
//     '步骤：\n- 甲\n-' 整篇渲染是 `<h2>步骤：<br>- 甲</h2>`：
//     末尾那个孤零零的 `-` 被当成 **setext 标题的下划线**，反过来把前面的段落抬成了标题。
//     切开后下划线落在尾段、标题内容却横跨两段，两边必然对不上。
//     根子在于 setext 的判定能**向上吞过切点**，所以"尾段里可能出现 - / = 开头的行"
//     这类位置一律不安全 —— 而流式中间态里这种孤立行遍地都是。
//
//   两者都回归「前面有空行」的老规则（blankSince）：那里段落已被空行收束，
//   既没有尾部换行的歧义，也不存在被 setext 上吞的可能。宁可少切，不可错切。
function blockStartKind(line) {
  if (/^ {0,3}#{1,6}(\s|$)/.test(line)) return 'heading';  // ATX 标题
  if (/^ {0,3}>/.test(line)) return 'quote';                // 引用块
  return '';
}

// 这一行虽然带块级标记，但它真的会**打断前一块**吗？只有打断才切得安全。
//
// 判不准一律返回 false —— 退化成不切（= 改造前的全量渲染），宁慢不错。
function isForcedBreak(kind, prevNonEmpty) {
  var prevIsQuote = /^\s*>/.test(prevNonEmpty);

  if (kind === 'heading') return true;        // ATX 标题总是结束前一块

  if (kind === 'quote') return !prevIsQuote;  // 前一行也是引用 = 同一个引用块

  return false;
}

// 数一行里**单个** $ 的个数（排除 $$，它是块级公式的分隔符）。
// 用转义反斜杠的数量判断该 $ 是否被转义。
function countSingleDollar(line) {
  var n = 0;
  for (var i = 0; i < line.length; i++) {
    if (line[i] !== '$') continue;
    // 数前面连续的反斜杠
    var bs = 0;
    for (var j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
    if (bs % 2 === 1) continue;               // 被转义的 $ 不算分隔符
    if (line[i + 1] === '$') { i++; continue; } // $$ 交给块级计数，不算单个
    n++;
  }
  return n;
}

// 数一行里的 $$（同样跳过被转义的）
function countDoubleDollar(line) {
  var n = 0;
  for (var i = 0; i < line.length - 1; i++) {
    if (line[i] !== '$' || line[i + 1] !== '$') continue;
    var bs = 0;
    for (var j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
    if (bs % 2 === 1) { i++; continue; }
    n++; i++;
  }
  return n;
}

/**
 * 在 text 中找一个安全切点：返回值 c 满足
 *   - from <= c <= text.length
 *   - text.slice(0, c) 与 text.slice(c) 各自独立渲染的结果，拼起来等于整篇渲染的结果
 * 找不到时返回 from（调用方据此退化为全量渲染）。
 *
 * @param {string} text  完整原文
 * @param {number} from  已冻结到的位置（只从这之后找）
 * @param {string} prevLastLine 冻结前缀里最后一个非空行（用于判断能否在此接上）
 */
export function findSafeCut(text, from, prevLastLine) {
  if (typeof text !== 'string' || text.length <= from) return from;

  var tail = text.slice(from);
  var lines = tail.split('\n');

  // 最后一行可能还没写完（下一帧还会长），永远不拿它当切点前的行
  var lastIdx = lines.length - 1;

  var inFence = false;          // 当前是否在 ``` 围栏内
  var dollarOpen = false;       // 当前是否在 $$ 块级公式内
  var pendingInlineOpen = false; // 上一行留下了未闭合的行内 $

  var off = 0;
  var prevNonEmpty = String(prevLastLine || '');
  var prevWasList = LIST_LINE.test(prevNonEmpty);
  var blankSince = false;       // 上一行是空行
  var best = from;

  for (var i = 0; i < lastIdx; i++) {
    var line = lines[i];
    var lineStart = off;
    off += line.length + 1;

    if (inFence) {
      // 围栏内：只关心闭合
      if (FENCE_LINE.test(line)) inFence = false;
      prevNonEmpty = line.trim() ? line : prevNonEmpty;
      blankSince = false;
      continue;
    }

    if (FENCE_LINE.test(line)) {
      // 围栏**没有**就地切点：它前面若紧邻普通段落，切开会丢掉 marked 在
      // breaks 模式下为那个尾部换行生成的 <br>（实测证据见 blockStartKind 的注释）。
      // 围栏前的可切边界交给 blankSince（前面有空行）那条老规则兜住。
      //
      // 顺带清掉一处双重失效的死代码：原实现在这里留了
      //   `if (blankSince) { /* 已在下面的统一判定里处理 */ }`
      // 它既因为上一行刚把 blankSince 置成 false 而永不成立，
      // 又因为本分支 continue 而根本走不到"下面的统一判定"。留着只会误导后来人。
      inFence = true;
      prevNonEmpty = line;
      prevWasList = false;
      blankSince = false;
      pendingInlineOpen = false;
      continue;
    }

    // 块级公式开关
    var dd = countDoubleDollar(line);
    if (dd % 2 === 1) dollarOpen = !dollarOpen;

    var trimmed = line.trim();

    if (trimmed === '') {
      // 空行：这里只是"前面的块结束了"，真正的切点判定放在下一行行首
      if (!dollarOpen) blankSince = true;
      continue;
    }

    // ---- 切点判定：两种情形可以在这一行之前切 ----
    //
    // A. 前面紧邻空行，且这一行不是前一块的续行（最保守，仍是主力路径）
    // B. 这一行自带「会打断前一块」的块级标记（# / ``` / > / - ）
    //
    // B 是这次补上的关键一档。只靠 A 的话，遇到"单换行分段"的中文回答
    // （通篇没有 \n\n：靠 \n 分行，靠标题、列表、引用、围栏分段 —— AI 讲题
    // 时这恰恰是最常见的形态），blankSince 一次都不成立 → 一次都不切 →
    // 尾段 = 全文，整条增量链路退化成每帧全量渲染，等于改造前的 O(n²)。
    // 实测这类语料的整轮渲染字符量是「每帧全量」基线的 100%，优化完全失效。
    var kind = blockStartKind(line);
    var canCut = false;

    if (blankSince
        && !dollarOpen
        && !pendingInlineOpen
        && !prevWasList
        && !isContinuationStart(line)) {
      canCut = true;                                      // A
    } else if (kind && !dollarOpen && !pendingInlineOpen) {
      canCut = isForcedBreak(kind, prevNonEmpty);  // B
    }

    if (canCut) {
      // ⚠️ 必须加 from：lineStart 是**相对 tail** 的偏移，而调用方拿它当
      //    绝对下标去 slice 原文。漏掉这个加法会切在句子中间
      //    （实测把行内公式 `$mg\sin\theta$` 从中间切断，前半段留在冻结块里、
      //     后半段成了尾块，两边的渲染结果都对不上）——
      //    这个 bug 正是被 .tmp-qa/verify-stream-paint.cjs 的差分测试抓出来的。
      best = from + lineStart;
    }

    // 更新下一轮用的状态
    prevNonEmpty = line;
    prevWasList = LIST_LINE.test(line);
    var sd = countSingleDollar(line);
    // 只有真正的公式行才可能留下未闭合的 $（避免把"价格 $5"这类误判）
    pendingInlineOpen = (sd % 2 === 1);
    blankSince = false;
  }

  return best;
}

/**
 * 建一个增量渲染器。
 * @param {(text: string) => string} render 渲染函数（这里传 renderStream）
 */
// render       —— 尾段的渲染函数（轻量，每帧都要跑）
// renderFrozen —— 冻结段的渲染函数（完整，每段只跑一次），不传则与 render 相同
//
// 为什么要分两个：
//   流式期间公式与图表一律走占位（renderStream 的 lightMode）—— 这是对的，
//   因为尾段每帧都在变，真渲染的话每帧都要跑一遍 KaTeX。
//   但**冻结段是"再也不会变"的内容**，它只需要渲染一次 ——
//   于是完全可以用完整渲染，让学生看到公式**随着答案一段段出现**，
//   而不是等整篇写完才一起蹦出来。
//   （一段数学解答里最刺眼的就是：明明已经"写完了"的段落，
//     公式还显示成 `\frac{a}{b}` 原文。）
// 收尾：把一条流式渲染的结果"落地"。对话 / 学习 / 作文三页共用同一套策略，
// 差异（字段名、滚动方法）由参数传进来 —— 避免三份各自演化的收尾代码。
//
// 策略：
//   · 冻结段零重建 —— 它们本来就是完整渲染出来的，内容与整篇渲染逐字一致；
//   · 只把**尾段**从轻量升级为完整；
//   · 尾段过长（整篇没有可冻结的块级边界）时，按**时间预算**分帧升级，
//     每帧最多 8ms —— 宁可让升级过程"看起来还在渲染"，也不要一次长任务卡住界面。
//
// 参数：
//   painter     —— createStreamPainter 返回的对象
//   renderFull  —— 完整渲染函数（renderMarkdown）
//   apply(parts, tail) —— 把结果写回调用方的响应式字段
//   onTick      —— 每帧结束后的跟随动作（滚动到底等），可选
//   setRaf(id)  —— 让调用方存下 rAF id，以便销毁时撤销
//   syncLimit   —— 尾段短于这个字数就同步升级（默认 1200）
//
// 返回 true 表示已接管收尾（调用方不要再自己渲染整篇）。
export function finalizeStreamPainter(opts) {
  var painter = opts.painter;
  if (!painter) return false;

  var renderFull = opts.renderFull;
  var apply = opts.apply;
  var onTick = opts.onTick;
  var syncLimit = opts.syncLimit || 1200;
  var plan = painter.finalizePlan();

  // 常见路径：尾段不长，一次同步升级就完事
  if (plan.tailChars <= syncLimit) {
    var out = painter.finalize(renderFull);
    apply(out.parts, out.tail);
    if (onTick) onTick();
    return true;
  }

  // 长尾段：分帧升级。尾段先清空而不是保留旧版 ——
  // 新旧两部分内容重叠，留着会看到"重复了一段"。
  var chunks = plan.chunks;
  var idx = 0;
  apply(plan.parts, '');

  var now = function () { return (window.performance || Date).now(); };
  var step = function () {
    var t0 = now();
    while (idx < chunks.length - 1 && (now() - t0) < 8) {
      // parts 就是调用方持有的那个数组（引用不变），push 会被 Vue 感知
      plan.parts.push(renderFull(chunks[idx]));
      idx++;
    }
    if (idx < chunks.length - 1) {
      opts.setRaf(window.requestAnimationFrame(step));
    } else {
      apply(plan.parts, chunks.length ? renderFull(chunks[idx]) : '');
      opts.setRaf(null);
    }
    if (onTick) onTick();
  };
  opts.setRaf(window.requestAnimationFrame(step));
  return true;
}

export function createStreamPainter(render, renderFrozen) {
  var renderFrozenFn = renderFrozen || render;
  var frozenText = '';
  // 最后一次 update 收到的完整文本。收尾时要用它取"尾段"的原文。
  var lastText = '';
  // 已冻结的每一块各存一段 HTML，**按顺序追加**，不做字符串拼接。
  //
  // 为什么不再攒成一个大字符串：
  //   攒字符串的话，"冻结段"只要推进一次，累积至今的整段 HTML 就得整块
  //   重新赋给 innerHTML —— 实测 5000 字的规范 Markdown 下，冻结推进 65 次、
  //   累计向 innerHTML 重写了 16.3 万字符（33 倍冗余），每一次都是
  //   "拆掉整棵子树 → 重新解析 HTML → 重建 → 布局失效"。
  //   改成按块 push 后，新冻结的那一块只会 append 一个新节点，
  //   已经渲染好的旧节点从头到尾一动不动。
  var frozenParts = [];
  // 每一段的**原文**。存它是为了 katex 就绪后能重算 ——
  //   引擎没到位时 renderMarkdown 会退回 <code> 原文占位，
  //   而冻结段一旦渲染就不再触发，不存原文就永远补不上真公式。
  var frozenSegments = [];
  var prevLastLine = '';
  var fullRenders = 0;   // 供排障/测试观察
  var chunkRenders = 0;

  function reset() {
    frozenText = '';
    lastText = '';
    // 换一条新数组而不是 length = 0：调用方持有的是上一次的引用，
    // 原地清空会让 Vue 的响应式数组 diff 拿不到"元素被替换"的信号。
    frozenParts = [];
    frozenSegments = [];
    prevLastLine = '';
  }

  function lastNonEmptyLine(s) {
    var lines = String(s || '').split('\n');
    for (var i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() !== '') return lines[i];
    }
    return '';
  }

  return {
    reset: reset,

    /**
     * 更新到最新的完整原文，返回可渲染的两段。
     * @returns {{frozen: string, tail: string, grew: number}}
     */
    update: function (text) {
      var s = String(text || '');
      lastText = s;

      // 内容不是原前缀的延伸（切换消息 / 重新生成 / 服务端续写回填）→ 整体重来
      if (s.indexOf(frozenText) !== 0) {
        reset();
        lastText = s;
      }

      var cut = findSafeCut(s, frozenText.length, prevLastLine);
      if (cut > frozenText.length) {
        var segment = s.slice(frozenText.length, cut);
        // 追加一个新块，而不是把整段重新拼一遍（理由见 frozenParts 的声明处）。
        // 冻结段用**完整渲染** —— 它不会再变，所以这一次渲染是划算的，
        // 换来的是一段段"真公式"随答案出现（见 createStreamPainter 的说明）。
        frozenSegments.push(segment);
        frozenParts.push(renderFrozenFn(segment));
        chunkRenders++;
        frozenText = s.slice(0, cut);
        prevLastLine = lastNonEmptyLine(frozenText);
      }

      var tailText = s.slice(frozenText.length);
      var tail = '';
      if (tailText) {
        tail = render(tailText);
        fullRenders++;
      }

      return {
        // parts：按块存放，交给视图层逐个渲染成节点（旧节点可复用）
        parts: frozenParts,
        // frozen：parts 拼起来的整串。差分测试与"退化为单节点"的场景仍用它，
        // 两者内容恒等 —— 差别只在视图层是重建一棵树还是 append 一个节点。
        frozen: frozenParts.join(''),
        tail: tail,
        grew: frozenText.length
      };
    },

    // 用当前(必然是更完整的)渲染函数重算所有已冻结的段。
    //
    // 什么时候需要：katex 从"开始下载"到"真正就绪"隔着好几秒，
    //   而冻结段一旦渲染就不再触发 —— 如果某几段是在引擎到位前冻结的，
    //   它们会一直显示 <code> 原文占位，直到收尾才被整篇重渲染纠正。
    //   在 onKatexReady 里调一次这个方法就能当场补上真公式。
    //
    // ⚠️ 必须用 splice 而不是 `frozenParts = []`：
    //   调用方（页面）持有的是**这个数组的引用**，换数组会让它指向上一次的快照，
    //   视图永远看不到更新。splice 是 Vue 拦得到的变更方法，能正确触发刷新。
    repaintFrozen: function () {
      frozenParts.splice(0, frozenParts.length);
      for (var i = 0; i < frozenSegments.length; i++) {
        frozenParts.push(renderFrozenFn(frozenSegments[i]));
      }
      return frozenParts;
    },

    // ---------- 收尾：零重建（Zero-Rebuild Finalization）----------
    //
    // 传统做法（改前）：收尾时丢掉全部冻结段，把整篇内容重渲染一遍。
    //   代价有两层，且都随答案长度线性增长：
    //   ① 计算 —— 把已经渲染过的 N 段**再渲染一遍**，O(全文) 而非 O(尾段)；
    //   ② DOM —— 整棵子树被重建：滚动位置要重算、已经画好的图表 SVG
    //      被整颗丢掉再重画。这就是"最后那一下又卡、又轻微跳动"的来源。
    //
    // 但请想清楚一件事：**冻结段本来就是用完整渲染器出来的**
    //   （见 createStreamPainter 顶部关于 renderFrozen 的说明），
    //   它们的内容与"整篇渲染"逐字一致 —— 收尾时凭什么重做？
    //   真正需要升级的只有尾段：它走轻量渲染，公式还是原文。
    //
    // 所以收尾只做一件事：把尾段用完整渲染器重渲染一次。
    // 冻结段的 DOM 一个节点都不动。
    finalize: function (renderFull) {
      var fn = renderFull || renderFrozenFn;
      var tailText = lastText.slice(frozenText.length);
      return {
        parts: frozenParts,                                   // 原样保留
        tail: tailText ? fn(tailText) : '',
        frozenChars: frozenText.length,
        tailChars: tailText.length
      };
    },

    // 尾段**很长**时的分帧升级计划（配合调用方按时间预算逐帧渲染）。
    //
    // 什么情况下尾段会很长：整篇都没有可冻结的块级边界（比如通篇无标题的长文），
    // 那时 frozenText 几乎为空、尾段就是全文 —— 同步渲染它就是一次长任务。
    // 这里用与流式**完全相同**的切点规则把尾段切片，保证"切开的渲染结果之和"
    // 与"整段渲染"一致（这条不变量由 verify-stream-paint 的差分测试守着）。
    finalizePlan: function () {
      var tailText = lastText.slice(frozenText.length);
      var chunks = [];
      var cursor = 0;
      var guard = 0;
      while (cursor < tailText.length && guard++ < 500) {
        var cut = findSafeCut(tailText, cursor, lastNonEmptyLine(tailText.slice(0, cursor)));
        if (cut <= cursor) break;
        chunks.push(tailText.slice(cursor, cut));
        cursor = cut;
      }
      if (cursor < tailText.length) chunks.push(tailText.slice(cursor));
      return {
        parts: frozenParts,      // 冻结段：原样保留，一个节点都不重建
        chunks: chunks,          // 尾段切片（按顺序）
        frozenChars: frozenText.length,
        tailChars: tailText.length
      };
    },

    // 测试与排障用
    stats: function () {
      return { frozenChars: frozenText.length, chunkRenders: chunkRenders, tailRenders: fullRenders };
    }
  };
}
