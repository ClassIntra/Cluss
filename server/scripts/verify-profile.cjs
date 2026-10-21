// 验证学生画像：学号解析、画像构建、提示词段落渲染
//
// 演示学生、错题与会话全部在**同一个事务**里播种 / 插入，结束抛错回滚，
// 不污染真实数据（演示学生本就存在的机器上则原样不动）。
// 用法：cd server && node scripts/verify-profile.cjs
require('dotenv').config();

var db = require('../src/utils/db');
var profile = require('../src/services/user-profile');
var prompts = require('../src/services/prompt-registry');

var pass = 0;
var fail = 0;

function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

console.log('\n[1] 学号解析');
ok(JSON.stringify(profile.parseStudentNo('250301')) === JSON.stringify({ enrollYear: 2025, classNo: 3, gradeIndex: 2 }),
  '250301 → 2025级 3班');
ok(profile.parseStudentNo('800001') === null, '保留段 800001 不反推年级');
ok(profile.parseStudentNo('abc') === null, '非数字学号返回 null');
ok(profile.parseStudentNo('') === null, '空学号返回 null');

console.log('\n[2] 演示学生 + 真实账号的画像（事务内播种，回滚不留痕）');
var rendered = '';
var insertedDemo = false;
try {
  db.transaction(function() {
    var now = require('../src/utils/time').nowUtc();
    // 自给自足：不依赖生产库里预置的演示学生 —— 演示数据被重置过的机器上，
    // 旧版这个脚本会从「演示学生有画像」开始全红。缺了就自己在事务里种一个，
    // 回滚时连人带数据一起消失（[5] 会验）。
    var demoExists = db.prepare('SELECT 1 AS x FROM users WHERE user_id = ?').get('250301');
    if (!demoExists) {
      db.prepare([
        'INSERT INTO users (user_id, net_name, real_name, password_hash, status, is_admin,',
        " info_json, source, class_no, created_at) VALUES ('250301', 'demo-student', '演示学生',",
        " 'x', 'active', 0, '{}', 'local', '', ?)"
      ].join('\n')).run(now);
      insertedDemo = true;
    }

    var adminProfile = profile.buildProfile('999999');
    ok(adminProfile === null, '管理员不生成画像');

    var demoProfile = profile.buildProfile('250301', { force: true });
    ok(!!demoProfile, '演示学生有画像');
    ok(demoProfile && demoProfile.enrollYear === 2025, '入学年份 = 2025');
    ok(demoProfile && demoProfile.classNo === 3, '班级 = 3');

    console.log('\n[3] 用假数据验证完整段落（同一事务内，随后回滚）');
    var ins = db.prepare([
      'INSERT INTO wrong_questions (user_id, conversation_id, image_hash, source, subject,',
      ' question, student_answer, correct_answer, reason, tag, mastered, note, created_at, updated_at)',
      'VALUES (?, \'\', \'\', \'ai\', ?, ?, ?, ?, ?, ?, 0, \'\', ?, ?)'
    ].join('\n'));

    ins.run('250301', '数学', '求二次函数最值', 'y=3', '顶点处取最值', '忘记把自变量范围代入，直接取了顶点', '✗', now, now);
    ins.run('250301', '数学', '二次函数与 x 轴交点', 'x=1', 'x=1 或 x=3', '忘记把自变量范围代入，直接取了顶点', '✗', now, now);
    ins.run('250301', '物理', '斜面受力分析', '漏了摩擦力', '需计入摩擦', '受力分析漏掉摩擦力', '✗', now, now);
    ins.run('250301', '英语', '时态填空', 'is', 'was', '时态判断错误', '✗', now, now);
    // 已掌握的不该进画像
    ins.run('250301', '化学', '方程式配平', '2H2+O2', '2H2+O2=2H2O', '没配平', '✗', now, now);
    db.prepare('UPDATE wrong_questions SET mastered = 1 WHERE subject = ? AND user_id = ?')
      .run('化学', '250301');

    db.prepare('INSERT INTO ai_conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('conv-test-1', '250301', '二次函数的应用题怎么找', now, now);

    profile.invalidate('250301');
    var p = profile.buildProfile('250301', { force: true });

    ok(!!p, '有错题数据时画像非空');
    ok(p.weakSubjects.length === 3, '薄弱学科 3 个（已掌握的化学不计入），实际 ' + p.weakSubjects.length);
    ok(p.weakSubjects[0].subject === '数学' && p.weakSubjects[0].count === 2,
      '数学排第一且为 2 道，实际 ' + JSON.stringify(p.weakSubjects[0]));
    ok(p.commonReasons.length > 0, '抽出常错类型');
    ok(p.recentTopics.length > 0, '抽出最近在问');

    rendered = prompts.buildProfileSection(p);

    // 抛错以回滚事务
    throw new Error('__ROLLBACK__');
  })();
} catch (e) {
  if (e.message !== '__ROLLBACK__') throw e;
}

console.log('\n[4] 渲染结果');
console.log(rendered || '(空)');

ok(rendered.indexOf('【关于这个学生】') > 0, '段落含标题');
ok(rendered.indexOf('2025级') > 0 && rendered.indexOf('3班') > 0, '段落含年级班级');
ok(rendered.indexOf('数学 2 道') > 0, '段落含学科计数');
ok(rendered.indexOf('化学') < 0, '已掌握的化学不出现');
ok(rendered.indexOf('不要复述') > 0, '段落含使用约束');
ok(rendered.length < 400, '画像段落控制在 400 字内，实际 ' + rendered.length);

console.log('\n[5] 回滚是否干净');
// 只数自己插的那五条：库里本来有真实错题（用过一阵的机器上都有一条），
// 旧版断言「整表为 0」是把环境当时的状态当成了不变量。
var left = db.prepare([
  "SELECT COUNT(*) c FROM wrong_questions WHERE user_id = '250301' AND question IN",
  " ('求二次函数最值','二次函数与 x 轴交点','斜面受力分析','时态填空','方程式配平')"
].join('\n')).get().c;
var leftConv = db.prepare("SELECT COUNT(*) c FROM ai_conversations WHERE id = 'conv-test-1'").get().c;
ok(left === 0, '播种的假错题已回滚，剩余 ' + left);
ok(leftConv === 0, '假会话已回滚');
if (insertedDemo) {
  var leftUser = db.prepare("SELECT COUNT(*) c FROM users WHERE user_id = '250301'").get().c;
  ok(leftUser === 0, '事务里播种的演示学生也回滚了，剩余 ' + leftUser);
} else {
  ok(true, '演示学生本就存在（未播种），原样不动');
}

console.log('\n[6] 上下文截断说明');
ok(prompts.buildContextNote({ history_available: 10, history_included: 4 }).indexOf('6 条') > 0,
  '被裁 6 条时给出说明');
ok(prompts.buildContextNote({ history_available: 4, history_included: 4 }) === '',
  '未裁剪时不加说明');
ok(prompts.buildContextNote(null) === '', '无 stats 时不加说明');

console.log('\n[7] 画像注入位置（必须在 BASE 之后，不能破坏缓存前缀）');
var full = prompts.getSystemPrompt({
  mode: 'study', studyStyle: 'guided',
  studentProfile: { enrollYear: 2025, classNo: 3, gender: '', weakSubjects: [{ subject: '数学', count: 2 }], commonReasons: [], recentTopics: [] }
});
var baseIdx = full.indexOf('通用规则');
var profIdx = full.indexOf('【关于这个学生】');
var timeIdx = full.lastIndexOf('[当前时间]');
ok(baseIdx >= 0 && profIdx > baseIdx, '画像在 BASE 之后');
ok(timeIdx >= profIdx, '时间在画像之后（都在末尾，不打断前缀）');
ok(full.slice(0, 400).indexOf('关于这个学生') < 0, '前 400 字仍是稳定的缓存前缀');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
