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
      inFence = true;
      prevNonEmpty = line;
      prevWasList = false;
      blankSince = false;
      pendingInlineOpen = false;
      // 围栏开始前如果是空行且本行不是续行 —— 可以切
      if (blankSince) { /* 已在下面的统一判定里处理 */ }
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

    // 非空行：如果它是"新块的开始"，且前面紧邻空行、不在围栏/公式里、
    // 前一块不是可能续上的列表，也不是未闭合的行内公式 —— 那这里就是安全切点
    if (blankSince
        && !dollarOpen
        && !inFence
        && !pendingInlineOpen
        && !prevWasList
        && !isContinuationStart(line)) {
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
export function createStreamPainter(render) {
  var frozenText = '';
  var frozenHtml = '';
  var prevLastLine = '';
  var fullRenders = 0;   // 供排障/测试观察
  var chunkRenders = 0;

  function reset() {
    frozenText = '';
    frozenHtml = '';
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

      // 内容不是原前缀的延伸（切换消息 / 重新生成 / 服务端续写回填）→ 整体重来
      if (s.indexOf(frozenText) !== 0) {
        reset();
      }

      var cut = findSafeCut(s, frozenText.length, prevLastLine);
      if (cut > frozenText.length) {
        var segment = s.slice(frozenText.length, cut);
        frozenHtml += render(segment);
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

      return { frozen: frozenHtml, tail: tail, grew: frozenText.length };
    },

    // 测试与排障用
    stats: function () {
      return { frozenChars: frozenText.length, chunkRenders: chunkRenders, tailRenders: fullRenders };
    }
  };
}
