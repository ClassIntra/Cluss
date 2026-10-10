/**
 * highlight.js 按需装配
 *
 * 为什么不直接 `import hljs from 'highlight.js'`：
 *   全量包会带进**全部约 190 种语言**的语法定义，而本项目只用到三个 API
 *   （getLanguage / highlight / highlightAuto）。实测 Notes 单页因此多了
 *   300KB+ 原始体积 —— 而目标设备是低端安卓平板，这一次多传的资源
 *   比任何代码整洁性收益都实打实。
 *
 *   改成 core 版 + 显式注册：只带下面这十一种语言的定义，
 *   其余语言标注会走 highlightAuto 或按未注册处理（见 renderCode）。
 *
 * ⚠️ 增删语言时要同步两处：
 *   1) 这里的 LANGS 列表
 *   2) Notes.vue 里代码块的语言标注习惯（学生实际会写什么）
 *
 * 顺带说明：highlightAuto 在只注册少数语言时仍能工作，
 * 但它的自动判断准确率会随之下降 —— 对笔记里的示例代码来说够用，
 * 真正在意高亮准���的地方（如果有）应该显式指定语言。
 */
import hljs from 'highlight.js/lib/core';

// 覆盖学生笔记里真实会出现的语言。
// 按「教学场景出现频率」排的序，不是按字母 —— 这个顺序也决定了
// highlightAuto 在语言相近时的倾向。
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c++', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('go', go);
hljs.registerLanguage('golang', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('json', json);

// markdown / HTML / CSS 这三个在教学笔记里出现频率不低，一并带上。
// xml 覆盖 HTML 的高亮（highlight.js 内部按 html 处理）。
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);

export default hljs;