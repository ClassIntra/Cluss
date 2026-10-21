// 本地笔记（notes_data）的跨页读写
//
// 为什么需要这个文件：「对话页的『存进笔记』」以前写的是**云笔记**
// （POST /notes/notes → 云盘 tab），而学生打开笔记页默认看到的是本地列表，
// 云 tab 在侧栏另一个分组里 —— 点完"已存入笔记"，去笔记页翻遍列表都找不到，
// 功能等于不存在（用户原话："加入笔记功能好像没有用啊"）。
//
// 规矩：
//   ① 对话页沉淀的内容进**本地** notes_data —— 那是笔记页的默认视图；
//   ② 云笔记仍在 Notes.vue 的"云"tab，作为可选备份，由学生自己决定同步；
//   ③ 写入结构必须与 Notes.vue createDrawFile / createNoteFile 的对象形状
//      逐字段一致（canvasData/annotations/createdAt/updatedAt/pinned/privacyId……），
//      否则笔记页读到会是 undefined 字段（Vue 2 不追踪后加属性，直接静默）。
//   ④ 只追加不覆盖：同 id 存在时不重复插入。

var NOTES_STORAGE_KEY = 'notes_data';

function readAll() {
  try {
    var raw = localStorage.getItem(NOTES_STORAGE_KEY);
    if (!raw) return { files: [], privateFiles: [] };
    var data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { files: [], privateFiles: [] };
    data.files = Array.isArray(data.files) ? data.files : [];
    data.privateFiles = Array.isArray(data.privateFiles) ? data.privateFiles : [];
    return data;
  } catch (e) {
    // 读不出来（隐私模式 / 配额满）不抛：调用方按"写不进去"处理
    return null;
  }
}

function writeAll(data) {
  try {
    localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 追加一篇本地笔记。返回 { ok, file, reason }
 *   ok=false + reason='unavailable'  → localStorage 不可用（隐私模式）
 *   ok=false + reason='quota'        → 写入超配额
 *   ok=false + reason='duplicate'    → 同 id 已存在（不重复插）
 */
export function appendLocalNote(fields) {
  var f = fields || {};
  var data = readAll();
  if (!data) return { ok: false, reason: 'unavailable' };

  var id = String(f.id || '');
  if (!id) return { ok: false, reason: 'no-id' };
  for (var i = 0; i < data.files.length; i++) {
    if (data.files[i] && data.files[i].id === id) return { ok: false, reason: 'duplicate' };
  }

  var now = new Date().toISOString();
  var file = {
    id: id,
    title: String(f.title || '未命名笔记').slice(0, 60),
    content: String(f.content || ''),
    type: 'note',
    tags: Array.isArray(f.tags) ? f.tags.slice(0, 8) : [],
    folder: String(f.folder || '默认').slice(0, 30) || '默认',
    canvasData: null,
    annotations: null,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    privacyId: null
  };

  // 试写一次：超配额时 writeAll 返回 false，不要把半截状态留在内存里
  data.files.unshift(file);
  if (!writeAll(data)) {
    data.files.shift();
    return { ok: false, reason: 'quota' };
  }
  return { ok: true, file: file };
}

export { NOTES_STORAGE_KEY };
