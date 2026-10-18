// 学生偏好的读写 —— 「设置」写、对话/学习页读
//
// 为什么单独成一个模块：这几个值被三处用到（设置弹窗写、对话页读、学习页读），
// 三处各自 try/catch + 各自校验白名单，改了档位忘了改读取端就会"设了不生效"。
// 放一处，读写同一份口径。
//
// 存储不可用（隐私模式 / 受限 WebView）时一律静默回落到默认值：
// 偏好是增强项，读不到不该影响提问（本项目踩过这类坑，见 project 约定）。

// 档位的单一真源在项目根 shared/student-prefs.json —— 服务端 prompt-registry
// require 的是同一份文件。从前这里与服务端各存一份白名单、靠注释约定
// "改一处记得改另一处"，是漂移的温床；现在两端都从这一份派生。
import prefsMeta from '@shared/student-prefs.json';

export var STUDENT_PREFS_KEY = 'cluss_student_prefs';

// 常学科目（多选）。值就是中文科目名，直接进提示词。
export var PREF_SUBJECTS = prefsMeta.subjects;

// 回复风格（三选一）。'balanced' 的 prompt 为空 —— 服务端对它不输出任何指令
//（也就是"和现在一样"）。这里只取渲染用的 value/label/desc，prompt 归服务端。
export var PREF_REPLY_STYLES = prefsMeta.replyStyles;

// 默认档取自 shared JSON 的 defaultStyle（与服务端同源）= 不输出任何指令
export function defaultStudentPrefs() {
  return { replyStyle: prefsMeta.defaultStyle, subjects: [], useRecords: true };
}

// 读取并归一化：范围外的值一律丢弃（回落到默认档），避免把非法值发给服务端。
export function readStudentPrefs() {
  var out = defaultStudentPrefs();
  var raw;
  try {
    raw = localStorage.getItem(STUDENT_PREFS_KEY);
  } catch (e) {
    return out; // 存储不可用：用默认值，不报错
  }
  if (!raw) return out;

  var obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return out; // 存档损坏：当作没设过
  }
  if (!obj || typeof obj !== 'object') return out;

  var styleOk = false;
  for (var i = 0; i < PREF_REPLY_STYLES.length; i++) {
    if (PREF_REPLY_STYLES[i].value === obj.replyStyle) { styleOk = true; break; }
  }
  if (styleOk) out.replyStyle = obj.replyStyle;

  if (Array.isArray(obj.subjects)) {
    for (var j = 0; j < obj.subjects.length; j++) {
      if (PREF_SUBJECTS.indexOf(obj.subjects[j]) !== -1 && out.subjects.indexOf(obj.subjects[j]) === -1) {
        out.subjects.push(obj.subjects[j]);
      }
    }
  }

  // 默认开启：只有明确存了 false 才算关掉
  out.useRecords = obj.useRecords !== false;
  return out;
}

export function writeStudentPrefs(prefs) {
  try {
    localStorage.setItem(STUDENT_PREFS_KEY, JSON.stringify(prefs));
  } catch (e) { /* 隐私模式 / 配额满：静默失败，顶多这次没记住 */ }
}
