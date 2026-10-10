// 引用笔记：对话 / 解题 / 写作三页共用的状态与方法
//
// 为什么抽成 mixin：
//   三个页面都要「选笔记 → 展示已选 → 随请求发 note_ids」，各写一份必然漂移
//   （项目里"两处各写一份必然不一致"是反复踩过的坑，导航与附件都因此收过口）。
//
// 笔记引用与云盘附件是两条独立的通道：
//   附件是外部资料，笔记是学生自己写的。服务端注入上下文时措辞也不同
//   （"我引用的笔记" vs "附带的文件"），模型的用法因此不同。

var MAX_NOTES = 5;

// 笔记 id 自服务端迁移 018 起是客户端生成的字符串（如 'note_1791..._wk479'）。
// 曾经这里按数字取 id（Number(n.id)），字符串会变成 NaN → 被下面的 filter 全部丢掉，
// 结果是"选了笔记但什么都没发生"，而且发出去的 note_ids 是空数组。
// 这里统一按字符串口径，和服务端 notes.js 的 noteIdFromParam 一致。
function noteKey(n) {
  if (n === null || n === undefined) return '';
  // 传笔记对象时取它的 id；传裸 id（removeNoteRef 传 n.id）时直接用。
  // 对象缺 id 必须返回空串，不能落到 String(n) 变成 '[object Object]'。
  if (typeof n === 'object') return String(n.id === undefined || n.id === null ? '' : n.id).trim().slice(0, 64);
  return String(n).trim().slice(0, 64);
}

export default {
  data: function() {
    return {
      // 已选中的笔记：[{ id, title, tags }]
      noteRefs: [],
      notePickerOpen: false
    };
  },
  computed: {
    noteIds: function() {
      return this.noteRefs.map(noteKey).filter(function(id) { return !!id; });
    }
  },
  methods: {
    onNotesPicked: function(notes) {
      // 去重：同 id 只留一个（选择器允许多次打开累计）
      // 用 Object.create(null) 而不是 {}：笔记 id 来自服务端，当成对象键时
      // 'constructor'/'__proto__' 这类键会落到原型上，导致去重与判断失真。
      var seen = Object.create(null);
      this.noteRefs = (notes || []).filter(function(n) {
        var id = noteKey(n);
        if (!id || seen[id]) return false;
        seen[id] = true;
        return true;
      }).slice(0, MAX_NOTES).map(function(n) {
        return {
          id: noteKey(n),
          title: n.title || '未命名笔记',
          tags: (n.tags || []).slice()
        };
      });
      // 超出上限时给个明确反馈，而不是静默截断让用户以为没选上
      if ((notes || []).length > MAX_NOTES) {
        this.$store.dispatch('toast', { message: '最多引用 ' + MAX_NOTES + ' 篇笔记', type: 'error' });
      }
    },

    removeNoteRef: function(id) {
      var target = noteKey(id);
      this.noteRefs = this.noteRefs.filter(function(n) { return noteKey(n) !== target; });
    },

    clearNoteRefs: function() {
      this.noteRefs = [];
    }
  }
};
