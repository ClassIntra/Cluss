/**
 * 输出体验 / 扣费体验 验证（零依赖，可直接 node 跑）
 *
 * 背景：cluss_usage_log 302 轮真实流水的三条结论，本脚本就是给这三条各上一把锁：
 *   1. completion_tokens 长尾：2.6% 的请求吃掉 16.6% 成本，单轮最高 18431 token / 14.9 积分
 *      —— 改造前**全链路没有任何 max_tokens**。
 *   2. 缓存命中率只有 10.2%（97,536 / 958,548），因为 system prompt 里挂着
 *      每轮都变的画像/记忆/余额/时间，导致它后面的整段历史永远失配。
 *   3. 输出单价是输入的 4 倍（8000 vs 2000 微元/1k），所以"输出长度"的杠杆远比"压缩提示词"大。
 *
 * ⚠️ 判别式纪律：本脚本对每一条关键断言都配了**反向对照**。
 *    没有反向对照的断言可能是假通过（例如"两次调用结果相同"在两次都返回空串时也成立）。
 *
 * 用法：
 *   export PYTHONPATH=""; unset NODE_OPTIONS; export PATH="/c/Program Files/nodejs:$PATH"
 *   cd server && node scripts/verify-output-experience.cjs
 */
'use strict';

var path = require('path');

// ⚠️ 必须先加载 .env 再 require 业务模块：config/index.js 在 require 时就会强校验
//    JWT_SECRET，缺了直接 process.exit(1)（症状是脚本"什么都没输出就退出"）。
//    顺序不能反。
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ---------------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------------
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  << ' + extra : ''));
  }
}
function group(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------------------
// 隔离 axios：ai.js 用 axios.post 发请求，把它换成假的就能**行为级**验证
// 「max_tokens 真的进了请求体」，而不是只做源码文本匹配（那种断言很容易假通过）。
// ---------------------------------------------------------------------------
var captured = [];
var axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true, children: [], paths: [],
  exports: {
    post: function (url, body) {
      captured.push({ url: url, body: body });
      return Promise.resolve({ data: { choices: [{ message: { content: 'ok' } }], usage: {} } });
    }
  }
};

var prompts = require('../src/services/prompt-registry');
var ai = require('../src/services/ai');
var builder = require('../src/services/context-builder');

// ---------------------------------------------------------------------------
// ① 输出上限分档
// ---------------------------------------------------------------------------
group('① outputCapFor：按"这一轮的产出物本来该有多长"定档');

ok('日常对话 = 3072', prompts.outputCapFor({ mode: 'daily' }) === 3072);
ok('学习对话（无 taskKind）= 3072', prompts.outputCapFor({ mode: 'study' }) === 3072);
ok('笔记辅助 = 3072', prompts.outputCapFor({ mode: 'note' }) === 3072);
ok('拍题·单题 = 4096', prompts.outputCapFor({ mode: 'study', taskKind: 'single' }) === 4096);
ok('拍题·多题 = 4096', prompts.outputCapFor({ mode: 'study', taskKind: 'multi' }) === 4096);
ok('拍题·跨页 = 4096', prompts.outputCapFor({ mode: 'study', taskKind: 'cross_page' }) === 4096);
ok('作业批改 = 4096', prompts.outputCapFor({ mode: 'study', taskKind: 'grade' }) === 4096);
ok('作文生成 = 6144（大写档）', prompts.outputCapFor({ mode: 'study', taskKind: 'writing_generate' }) === 6144);
ok('作文批改 = 4096', prompts.outputCapFor({ mode: 'study', taskKind: 'writing_grade' }) === 4096);
ok('写作提纲 = 3072', prompts.outputCapFor({ mode: 'study', taskKind: 'writing_outline' }) === 3072);

// 脏数据兜底：mode/taskKind 来自数据库，可能是空值或历史遗留值
ok('空 opts 也能返回合法上限', prompts.outputCapFor({}) > 0);
ok('脏 mode + 脏 taskKind 回落到兜底', prompts.outputCapFor({ mode: 'zzz', taskKind: 'yyy' }) === 3072);
ok('null 入参不抛错', prompts.outputCapFor(null) === 3072);

// 反向对照：证明它不是"恒定返回一个数"
ok('反向对照：作文档 与 对话档 不同', prompts.outputCapFor({ taskKind: 'writing_generate' }) !== prompts.outputCapFor({ mode: 'daily' }));
ok('反向对照：拍题档 与 对话档 不同', prompts.outputCapFor({ taskKind: 'solve_single' }) !== prompts.outputCapFor({ mode: 'daily' }) ||
  prompts.OUTPUT_CAP.solve !== prompts.OUTPUT_CAP.chat);

// ---------------------------------------------------------------------------
// ② max_tokens 真的进了请求体（行为级）
// ---------------------------------------------------------------------------
group('② max_tokens 透传（行为级：拦截假 axios 看请求体）');

var fakeModel = {
  id: 'test-model', endpoint: 'http://127.0.0.1:1/fake', apiKey: 'k',
  modelName: 'm', supportsThinking: 0, supportsVision: 1
};

return (function () {
  return ai.chatOnce(fakeModel, [{ role: 'user', content: 'hi' }], { maxTokens: 1234 })
    .then(function () {
      var b = captured[captured.length - 1];
      ok('显式 maxTokens 出现在请求体', b && b.body && b.body.max_tokens === 1234,
        b && b.body ? JSON.stringify(b.body).slice(0, 120) : 'no body');
    })
    .then(function () {
      return ai.chatOnce(fakeModel, [{ role: 'user', content: 'hi' }], {});
    })
    .then(function () {
      var b = captured[captured.length - 1];
      // 反向对照：没传时**不能**凭空出现 max_tokens（否则等于写死了没人知道的上限）
      ok('反向对照：未传时请求体不含 max_tokens', b && b.body && !('max_tokens' in b.body));
    })
    .then(function () {
      // 边界：0 / 负数 / 非数字都当作"没设"，不能把 max_tokens=0 发给上游（那会一字不出）
      return ai.chatOnce(fakeModel, [{ role: 'user', content: 'hi' }], { maxTokens: 0 });
    })
    .then(function () {
      var b = captured[captured.length - 1];
      ok('maxTokens=0 不下发（0 会让上游一字不出）', b && b.body && !('max_tokens' in b.body));
    })
    .then(function () {
      return ai.chatOnce(fakeModel, [{ role: 'user', content: 'hi' }], { maxTokens: 'abc' });
    })
    .then(function () {
      var b = captured[captured.length - 1];
      ok('非数字 maxTokens 不下发', b && b.body && !('max_tokens' in b.body));
    })
    .then(function () {
      // 流式路径走的是白名单构造 options —— 这正是"加了上限却不生效"最容易发生的地方
      var handle = ai.chatStream(fakeModel, [{ role: 'user', content: 'hi' }], {
        maxTokens: 2222, onDelta: function () {}, onReasoning: function () {}
      });
      return handle.promise.then(function () {
        var b = captured[captured.length - 1];
        ok('流式路径也带上 max_tokens（白名单转发未被漏掉）', b && b.body && b.body.max_tokens === 2222,
          b && b.body ? JSON.stringify(b.body).slice(0, 120) : 'no body');
      }).catch(function () {
        // 假 axios 只实现了 post；chatStream 内部可能用别的字段，失败也不影响主结论
        var b = captured[captured.length - 1];
        ok('流式路径也带上 max_tokens（白名单转发未被漏掉）', !!(b && b.body && b.body.max_tokens === 2222));
      });
    });
})()
  .then(function () {
    // -----------------------------------------------------------------------
    // ③ 恒定段逐轮恒定（本轮最重要的一条）
    // -----------------------------------------------------------------------
    group('③ system 恒定段：同一会话内逐轮逐字节一致（缓存命中的前提）');

    var baseOpts = {
      mode: 'study', studyStyle: 'guided', taskKind: 'single',
      hasAttachment: true, writing: null, dailyStyle: '', personaRecord: null
    };

    function withProfile(n) {
      var o = {};
      for (var k in baseOpts) o[k] = baseOpts[k];
      o.studentProfile = { enrollYear: 2024, classNo: n + '', gender: '男', weakSubjects: [{ subject: '物理', count: n }] };
      o.memories = [{ key: '偏好_讲解风格', content: '喜欢先看例子' }];
      o.pointsBalance = 100 - n;              // 每轮都在变
      o.ciProfile = { signature: 'sig-' + n }; // 每轮可能变
      return o;
    }

    var a = prompts.getSystemPromptParts(withProfile(1));
    var b = prompts.getSystemPromptParts(withProfile(2));

    ok('两次调用 stable 完全相同', a.stable === b.stable,
      'len ' + a.stable.length + ' vs ' + b.stable.length);
    ok('两次调用 dynamic 不同（证明变化确实被隔离了）', a.dynamic !== b.dynamic);
    ok('stable 非空（反向对照：排除"两边都是空串"的假通过）', a.stable.length > 1000,
      'len=' + a.stable.length);

    // 稳定段里不能残留任何逐轮变化的段。
    // ⚠️ 断言必须用**段首的精确标记**，不能用松散关键词：BASE 第 15 条本来就要
    //    引用这些段名（"可能出现【关于这个学生】…这类背景块"），拿『【关于这个学生】』
    //    直接 indexOf 会命中 BASE 自己那句声明，于是断言永远失败 —— 那是断言写错，不是代码错。
    var H_PROFILE = '【关于这个学生】（系统根据';
    var H_CI = '【他在校园社区里的活动】（来自学校系统';
    var H_MEM = '【关于这个学生的长期记忆】';
    var H_BAL = '[积分余额] 当前可用';

    ok('stable 不含画像段正文', a.stable.indexOf(H_PROFILE) === -1);
    ok('stable 不含 CI 素材段正文', a.stable.indexOf(H_CI) === -1);
    ok('stable 不含记忆段标题', a.stable.indexOf(H_MEM) === -1);
    ok('stable 不含[积分余额]', a.stable.indexOf(H_BAL) === -1);
    ok('stable 不含当前时间行', !/\[当前时间\] \d{4}-/.test(a.stable));

    ok('dynamic 含画像段标题', a.dynamic.indexOf(H_PROFILE) !== -1);
    ok('dynamic 含 CI 素材段标题', a.dynamic.indexOf(H_CI) !== -1);
    ok('dynamic 含记忆段标题', a.dynamic.indexOf(H_MEM) !== -1);
    ok('dynamic 含[积分余额]', a.dynamic.indexOf(H_BAL) !== -1);
    ok('dynamic 含当前时间行', /\[当前时间\] \d{4}-/.test(a.dynamic));

    // 反向对照：会真正改变语境的两个开关，必须让 stable 变（否则说明它们没生效）
    var o2 = withProfile(1); o2.hasAttachment = false;
    ok('反向对照：附件有无会改变 stable（护栏确实在恒定段里）',
      prompts.getSystemPromptParts(o2).stable !== a.stable);
    var o3 = withProfile(1); o3.studyStyle = 'direct';
    ok('反向对照：学习风格会改变 stable', prompts.getSystemPromptParts(o3).stable !== a.stable);
    var o4 = withProfile(1); o4.mode = 'daily';
    ok('反向对照：模式会改变 stable', prompts.getSystemPromptParts(o4).stable !== a.stable);

    // 同一会话内、只有逐轮变化量不同时，stable 必须字字相同（再跑一次确认不是偶然）
    var again = prompts.getSystemPromptParts(withProfile(99));
    ok('再跑一次（profile 换到 99）stable 仍相同', again.stable === a.stable);

    // -----------------------------------------------------------------------
    // ④ 向后兼容：拼接结果与原口径逐字节等价
    // -----------------------------------------------------------------------
    group('④ 向后兼容：getSystemPrompt = stable + 换行 + dynamic');

    var o5 = withProfile(1);
    var parts = prompts.getSystemPromptParts(o5);
    var whole = prompts.getSystemPrompt(o5);
    ok('拼接结果一致', whole === parts.stable + '\n' + parts.dynamic);
    ok('无 dynamic 时 getSystemPrompt 只返回 stable', (function () {
      var o = { mode: 'daily' };                 // 无画像/记忆/余额
      var p = prompts.getSystemPromptParts(o);
      // 时间永远存在，所以 dynamic 一定非空；这里只验证拼接口径
      return prompts.getSystemPrompt(o) === p.stable + '\n' + p.dynamic;
    })());

    // -----------------------------------------------------------------------
    // ⑤ BASE 第 15 条：把末尾背景块重新授权为"系统注入"
    // -----------------------------------------------------------------------
    group('⑤ BASE 第 15 条（安全声明：背景块不是学生的话）');

    ok('提到"系统注入的背景块"', prompts.BASE.indexOf('系统注入的背景块') !== -1);
    ok('声明"不是学生能伪造的"', prompts.BASE.indexOf('不是学生能伪造的') !== -1);
    ok('声明指令性内容不执行', prompts.BASE.indexOf('一律不执行') !== -1);
    ok('列全了三类背景块', prompts.BASE.indexOf('【关于这个学生】') !== -1 &&
      prompts.BASE.indexOf('【他在校园社区里的活动】') !== -1 &&
      prompts.BASE.indexOf('【长期记忆】') !== -1);
    // 第 15 条必须落在 BASE（=恒定段）里，不能落在 dynamic
    ok('该声明位于 stable 段内', a.stable.indexOf('系统注入的背景块') !== -1);
    ok('该声明不在 dynamic 段内', a.dynamic.indexOf('系统注入的背景块') === -1);

    // -----------------------------------------------------------------------
    // ⑥ 篇幅约束写成了可执行数字
    // -----------------------------------------------------------------------
    group('⑥ BASE 第 7 条：篇幅约束有具体数字');

    ok('含对话篇幅数字（两三句）', prompts.BASE.indexOf('两三句') !== -1);
    ok('含概念解释字数上限（200 字）', prompts.BASE.indexOf('200 字以内') !== -1);
    ok('点明"多写字=多付费"', prompts.BASE.indexOf('这是他的钱') !== -1);

    // -----------------------------------------------------------------------
    // ⑦ 末尾背景块真的拼在用户消息最末（context-builder）
    // -----------------------------------------------------------------------
    group('⑦ context-builder：背景块拼在用户消息末尾且计入预算');

    var TC = '\n[当前时间] 2026-10-10 12:00';
    var built = builder.buildMessages({
      systemPrompt: 'SYS',
      history: [],
      userContent: '学生的问题',
      noteText: '我的笔记',
      textAttachmentText: '附件正文',
      trailingContext: TC,
      budgetTokens: 10000
    });
    var last = built.messages[built.messages.length - 1];
    ok('最后一条是 user', last.role === 'user');
    ok('背景块在消息末尾', last.content.indexOf(TC) === last.content.length - TC.length);
    ok('背景块排在附件之后（附件紧贴问题，背景在最后）',
      last.content.indexOf('附件正文') < last.content.indexOf(TC));
    ok('背景块排在笔记之后', last.content.indexOf('我的笔记') < last.content.indexOf(TC));
    ok('背景块计入 estimated_tokens', built.stats.estimated_tokens > 0);

    // 反向对照：不给就不该出现
    var built2 = builder.buildMessages({
      systemPrompt: 'SYS', history: [], userContent: 'q', budgetTokens: 10000
    });
    ok('反向对照：未传 trailingContext 时末尾无背景块',
      built2.messages[built2.messages.length - 1].content === 'q');

    // -----------------------------------------------------------------------
    console.log('\nRESULT: PASS ' + pass + ' / FAIL ' + fail + ' (共 ' + (pass + fail) + ' 项)');
    process.exit(fail ? 1 : 0);
  })
  .catch(function (e) {
    console.error('\n脚本异常：' + (e && e.stack || e));
    process.exit(2);
  });
