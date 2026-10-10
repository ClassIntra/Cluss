// 提示词工程回归验证
//
// 覆盖本轮四类改动：
//   ① 情感与人情味段（EMOTION）—— 新增，所有场景都要有
//   ② BASE 第 2 条 —— 原版**明令禁止**引用跨会话信息，把记忆机制整个否掉了
//   ③ BASE 去重 —— 画像用法说明原本在 BASE 与画像段各写一遍，每轮付两次钱
//   ④ 记忆段措辞 —— 从"当背景"改成"自然用上 + 别生搬硬套"
//
// 运行（在 Cluss 仓库根下）：
//   export PYTHONPATH=""; unset NODE_OPTIONS; export PATH="/c/Program Files/nodejs:$PATH"
//   node server/scripts/verify-prompt-engineering.cjs
'use strict';
var path = require('path');
var dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
process.env.DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'database', 'cluss.db');

var pass = 0, fail = 0, lines = [];
function ok(n, c, e) {
  if (c) { pass++; lines.push('  PASS  ' + n); }
  else { fail++; lines.push('  FAIL  ' + n + (e !== undefined ? '  | ' + e : '')); }
}
function section(t) { lines.push(''); lines.push('== ' + t + ' =='); }
function has(n, h) { return String(h).indexOf(n) !== -1; }

var prompts = require('../src/services/prompt-registry');
var memory = require('../src/services/memory');

var memories = [
  { key: '偏好_讲解风格', content: '他喜欢先给结论再讲过程。' },
  { key: '学业_薄弱科目', content: '物理是薄弱项，怕受力分析。' }
];
var profile = { enrollYear: 2024, classNo: 3, weakSubjects: [{ subject: '数学', count: 5 }] };

function sys(mode, extra) {
  var o = { mode: mode, memories: [], studentProfile: profile };
  if (extra) for (var k in extra) o[k] = extra[k];
  return prompts.getSystemPrompt(o);
}

// ---------- ① EMOTION 段 ----------
section('① 情感与人情味段（所有场景）');
var study = sys('study', { studyStyle: 'guided', taskKind: 'single' });
var daily = sys('daily');
var note = sys('note');
var writing = sys('study', { taskKind: 'writing_grade', writing: { language: 'zh', genre: '记叙文', wordLimit: 800 } });

ok('学习模式含情感段', has('【学生表达情感或情绪时】', study));
ok('日常模式含情感段', has('【学生表达情感或情绪时】', daily));
ok('笔记辅助含情感段', has('【学生表达情感或情绪时】', note));
ok('作文批改含情感段', has('【学生表达情感或情绪时】', writing));

ok('① 明令「不要否认他的感受」', has('不要否认他的感受', study));
ok('② 给出反例：声明自己是程序会把人推开', has('我只是一段程序', study) && has('被推开', study));
ok('③ 越界时「一句话就够、不羞辱不敷衍」', has('不羞辱、不敷衍、不反复解释', study));
ok('④ 自我贬低时空夸与附和都不好', has('空夸', study) && has('附和', study));
ok('⑤ 危机内容要转介给身边人/老师', has('建议他告诉一个身边信得过的人或老师', study));
ok('⑥ 禁止编造自己的生活', has('不要编造你自己的生活', study));
ok('⑦ 强调"短本身就是一种体贴"', has('短本身就是一种体贴', study));

// 实测补丁（glm53f 真实采样暴露的缺口，逐条锁死）：
// 「你是真人吗」被回成一份功能清单 —— 覆盖"表达好感/情绪低落/关心你"三条却漏了"质疑身份"。
ok('⑧ 覆盖「问你是不是真人」这一场景', has('问你是不是真人', study));
ok('⑧ 明令答完不要接能力清单', has('能力清单', study) || has('我能帮你答疑', study));
ok('⑧ 点明他是在试探"值不值得当真"', has('值不值得当真', study));

// 情绪场景"接住了又换说法拉回功课"（实测：结尾追问「哪道题卡住了」）
ok('⑨ 明令不得换个说法拉回功课', has('也别换一种说法拉回去', study));
ok('⑨ 点出这种回拉"长得像关心"', has('包了一层关心', study));

// 位置：场景段之后、画像段之前
//
// ⚠️ 定位画像段必须用**段首的精确标记**（带括号说明那一截），不能用『【关于这个学生】』：
//    BASE 第 15 条（背景块授权声明）按设计就要引用这个段名，用松散关键词会命中
//    BASE 里那句声明，于是"画像在情感段之前"这种结论会凭空出现 —— 断言写错，不是代码错。
var H_PROFILE = '【关于这个学生】（系统根据';
var iEmo = study.indexOf('【学生表达情感或情绪时】');
var iProfile = study.indexOf(H_PROFILE);
var iScene = study.indexOf('引导模式');
ok('情感段在场景段之后', iScene > 0 && iEmo > iScene, 'scene=' + iScene + ' emo=' + iEmo);
ok('情感段在画像段之前', iEmo > 0 && iProfile > iEmo, 'emo=' + iEmo + ' profile=' + iProfile);

// ---------- ② BASE 第 2 条 ----------
section('② BASE 第 2 条：解除"不许用跨会话信息"的禁令');
ok('已删除原禁令措辞', !has('不要引用或暗示其它会话里出现过的东西', study));
ok('明确长期记忆是允许使用的', has('系统明确允许你使用的', study));
ok('仍禁止凭空引用没看到的内容', has('不要凭空引用或暗示你没看到的内容', study));

// ---------- ③ BASE 去重 ----------
section('③ BASE 与画像段的重复说明已去掉');
ok('BASE 不再重复画像说明', !has('若提示末尾给出【关于这个学生】', study));
ok('画像段自身仍带用法说明', has('用法：当背景用', study));
// 反向对照：整段 system 里画像段标题只应出现一次。
// 注意这里数的是**带说明的段首标记**，不是裸的『【关于这个学生】』——
// BASE 第 15 条会引用这个段名（"可能出现【关于这个学生】…这类背景块"），
// 数裸关键词会把那句声明也算进来，得到"出现 2 次"的假失败。
var cnt = 0, idx = 0;
while ((idx = study.indexOf(H_PROFILE, idx)) !== -1) { cnt++; idx += 1; }
ok('画像段标题只出现一次', cnt === 1, '出现 ' + cnt + ' 次');
// 而 BASE 第 15 条对段名的引用是**有意为之**（它要在恒定段里授权这些背景块），
// 所以下面这条是"确认它还在"，防止有人为了消掉上面那条而把声明整段删掉。
ok('BASE 仍保留背景块授权声明（引用段名是有意的）', has('系统注入的背景块', study));

// ---------- ④ 记忆段措辞 ----------
section('④ 记忆段：从"当背景"改成"自然用上 + 别生搬硬套"');
var withMem = sys('study', { studyStyle: 'guided', taskKind: 'single', memories: memories });
ok('含「自然用上」', has('自然用上', withMem));
ok('含「别为了显得记得而生搬硬套」', has('生搬硬套', withMem));
ok('含反例：问数学扯作息是跑题', has('跑题不是关心', withMem));
ok('保留时效声明', has('以**他现在的说法**为准', withMem));
ok('保留"不要原样念给他听"', has('不要把这些记忆原样念给他听', withMem));
ok('不再有旧措辞「用法：当作背景」', !has('用法：当作背景', withMem));

// ---------- ⑤ 学习场景的情绪分流 ----------
section('⑤ 学习模式的情绪分流（原本会把情绪硬拉回功课）');
ok('指向情感段', has('按【学生表达情感或情绪时】走', study));
ok('明说不要硬拉回功课', has('硬拉回去只会让他觉得没被听见', study));

// ---------- ⑥ CI 段压缩后护栏仍在 ----------
section('⑥ CI 素材段：压缩后关键护栏未丢');
var ci = {
  signature: '签名', level: { level: 7 }, login: { streak: 3 },
  community: { post_count: 2, post_tags: ['棋类'], post_titles: ['心得'] },
  games: { chess: 2 }, exams: []
};
var withCi = sys('daily', { ciProfile: ci });
ok('仍有「绝对不要主动提起」', has('绝对不要主动提起这些内容', withCi));
ok('仍有"被监视而不是被理解"的解释', has('被监视', withCi));
ok('仍有"以他现在的说法为准"', has('以**他现在的说法**为准', withCi));
ok('压缩后不再有冗余句式', !has('不要问「你最近还在听某个歌手吗」', withCi));

// ---------- ⑦ 段落顺序总览 ----------
section('⑦ 末尾动态段顺序（影响上游前缀缓存）');
var full = sys('daily', { memories: memories, ciProfile: ci, pointsBalance: 42, weeklyRemainingPoints: 30 });
var iProf = full.indexOf('【关于这个学生】');
var iCi = full.indexOf('【他在校园社区里的活动】');
var iMem = full.indexOf('【关于这个学生的长期记忆】');
ok('画像 → CI → 记忆 顺序稳定', iProf > 0 && iProf < iCi && iCi < iMem,
  'profile=' + iProf + ' ci=' + iCi + ' mem=' + iMem);

console.log(lines.join('\n'));
console.log('');
console.log('RESULT: PASS ' + pass + ' / FAIL ' + fail + ' (共 ' + (pass + fail) + ' 项)');
process.exit(fail ? 1 : 0);
