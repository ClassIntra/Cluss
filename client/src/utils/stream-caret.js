// 流式光标：把光标注入渲染后的 Markdown HTML 末尾（行内，跟在最后一行文字后）
//
// 为什么不直接在容器后放一个 <span class="caret">：
//   结果容器是块级元素，容器后的行内元素会**另起一行** ——
//   流式时正文最后一行下面孤零零挂着一个跳动的方块，看起来像坏掉了。
//   ChatGPT / Claude 的光标都内联在最后一行文字的尾巴上（业界惯例，
//   "blinking caret at the end of the streamed text"）。
//
// 做法：在渲染结果的尾部闭合标签串的**最内层**闭合标签前插入光标 span：
//   ...</li></ul>   ->  ...<caret></li></ul>   （光标贴着最后一个列表项）
//   ...</p>         ->  ...<caret></p>         （光标贴着最后一个段落）
// 找不到闭合标签（极罕见）就在末尾追加兜底。
//
// 光标是固定结构的空 span（无属性无内容），在 DOMPurify 之后注入，无注入风险。
//
// 何时移除：调用方只在流式进行中调用本函数（用 streaming/sending 状态驱动），
// 流结束 / 中断的那次收尾渲染不调用 —— 光标随**流状态**消失，
// 而不是随最后一个字消失（业界惯例：过早消失会让人以为它已经说完了）。

var TAIL = /<\/(?:p|li|h[1-6]|pre|blockquote|div|td|th|dt|dd|code)>(?:\s*<\/(?:ul|ol|table|tr|tbody|thead|blockquote|pre|div)>)*\s*$/i;

function appendStreamCaret(html) {
  var s = String(html || '');
  var m = TAIL.exec(s);
  var caret = '<span class="stream-caret" aria-hidden="true"></span>';
  if (!m) return s + caret;
  return s.slice(0, m.index) + caret + s.slice(m.index);
}

export { appendStreamCaret };
