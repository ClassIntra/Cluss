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

function noteKey(n) {
  return Number(n && n.id) || 0;
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
      return this.noteRefs.map(noteKey).filter(function(id) { return id > 0; });
    }
  },
  methods: {
    onNotesPicked: function(notes) {
      var self = this;
      // 去重：同 id 只留一个（选择器允许多次打开累计）
      var seen = {};
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
      void self;
    },

    removeNoteRef: function(id) {
      this.noteRefs = this.noteRefs.filter(function(n) { return noteKey(n) !== Number(id); });
    },

    clearNoteRefs: function() {
      this.noteRefs = [];
    }
  }
};
