// 校园情境：把 ClassIntra 的联动素材，变成学生**看得见、管得住**的东西
//
// 这个文件回答的是一个产品问题，不是技术问题：
//
//   Cluss 已经能通过只读桥拿到学生在校园社区的活动素材（签名 / 音乐 / 发帖 /
//   棋类 / 学业倒计时），并把它们塞进提示词让 AI "更懂这个人"。
//   但学生**完全不知道这件事** —— 提示词里还写着「绝对不要主动提起」，
//   因为一旦被说出来，学生的感受是"被监视"而不是"被理解"。
//
// 于是就出现了一个尴尬的局面：联动做了等于没做。
//   学生用起来，接入 CI 的 Cluss 与独立部署的 Cluss 体验没有任何区别；
//   而那批素材因为不能被提起，连"更懂我"都只是 quietly 影响语气而已。
//
// 这个文件把这件事翻过来：
//   **与其偷偷用，不如明着告诉你，并把开关交给你。**
//   · 设置里能看到"AI 现在知道的、来自校园的信息"；
//   · 可以整体关掉，也可以只关掉某一项（比如不想让 AI 知道自己的音乐口味）；
//   · 关掉的东西**立刻不再进提示词** —— 开关不是装饰，是真的切断链路。
//
// 这同时消解了"被监视感"：被监视的本质是**不可知且不可控**。
// 当学生能看见、能删、能关，同样的素材就从"系统在背后贴标签"
// 变成了"我自己决定让 AI 知道什么"。
//
// ---- 独立性保证（与 ci-bridge 同源的口径）----
// CI 未配置 / 取不到素材时，本模块一律返回 { linked: false }，
// 前端据此**整块不渲染**，Cluss 的界面与独立部署完全一致。
// 素材永远不落库（只存在 ci-bridge 的内存缓存里），关掉开关后更是连读都不读。

var db = require('../utils/db');
var time = require('../utils/time');
var ciBridge = require('./ci-bridge');

// ============================================================
// 素材项定义
//
// key 与 CI 侧 student-profile 的字段段对应。**顺序即展示顺序**：
// 学业倒计时排第一，因为它是唯一带"时间"的一维 —— 也是唯一能真正改变
// Cluss 行为的（临考科目错题优先复习，见 urgentSubjects）。
// ============================================================
var ITEM_DEFS = [
  { key: 'exams', label: '学业倒计时' },
  { key: 'signature', label: '个性签名' },
  { key: 'music', label: '音乐口味' },
  { key: 'community', label: '校园社区' },
  { key: 'games', label: '棋类' },
  { key: 'level', label: '社区等级' }
];

// 临考判定：多少天内算「快考了」
// 14 天是复习周期的量级 —— 比这更早提"要考试了"只会制造噪音，
// 比这更晚则来不及把错题过一遍。
var URGENT_DAYS = 14;

// ---- 第二道脱敏闸门 ----
//
// CI 侧的 cleanProfileText 已经过滤过一遍，这里**刻意再写一套**：
// 两道闸门共用一份常量，一次误改就会同时失效（项目红线，见记忆第 15 条）。
// 这里是"出村前最后一道"：任何要展示给学生、或回流进提示词的自由文本，
// 命中就整条丢弃，而不是打码 —— 打码会留下"这里原本有什么"的暗示。
var SENSITIVE_RES = [
  /1[3-9]\d{9}/,                                            // 手机号
  /0\d{2,3}-?\d{7,8}/,                                      // 固话
  /[\w.+-]+@[\w-]+\.[\w.-]+/,                               // 邮箱
  /\d{17}[\dXx]/,                                           // 身份证
  /(微信号?|qq号?|wechat|weixin|vx)\s*[:：]?\s*[a-z0-9_-]{5,}/i
];

// 上游把空集合 JSON 化成字符串传过来时（实测 post_tags = ["[]"]），
// 不过滤就会在界面上出现「常写：[]」这种一眼假的内容 —— 学生看到只会觉得
// 系统在糊弄他。这类占位值在任何字段里都没有信息量，统一在入口挡掉。
var PLACEHOLDER_RE = /^(\[\]|\{\}|null|undefined|none|n\/a|-+|—+|\?+|无|空)$/i;

function clean(v, max) {
  var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (PLACEHOLDER_RE.test(s)) return '';
  for (var i = 0; i < SENSITIVE_RES.length; i++) {
    if (SENSITIVE_RES[i].test(s)) return '';
  }
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ============================================================
// 开关读写
// ============================================================

// 读开关。没有记录 = 全开（默认享用，不要求先来勾一遍）
function getOpt(userId) {
  var uid = String(userId || '');
  if (!uid) return { enabled: true, disabled: [] };
  try {
    var row = db.prepare('SELECT * FROM campus_context_opt WHERE user_id = ?').get(uid);
    if (!row) return { enabled: true, disabled: [] };
    var disabled = [];
    try {
      var parsed = JSON.parse(row.disabled_json || '[]');
      if (Object.prototype.toString.call(parsed) === '[object Array]') {
        disabled = parsed.map(String);
      }
    } catch (e) { disabled = []; }
    return { enabled: row.enabled !== 0, disabled: disabled };
  } catch (e) {
    // 表还没建（迁移未跑）时不能让整个功能炸掉 —— 按"全开"走，
    // 与没有记录时的行为一致，语义上也是安全的（素材本身已脱敏）
    return { enabled: true, disabled: [] };
  }
}

function writeOpt(userId, enabled, disabled) {
  var uid = String(userId || '');
  if (!uid) return false;
  db.prepare([
    'INSERT INTO campus_context_opt (user_id, enabled, disabled_json, updated_at)',
    'VALUES (?, ?, ?, ?)',
    'ON CONFLICT(user_id) DO UPDATE SET',
    '  enabled = excluded.enabled,',
    '  disabled_json = excluded.disabled_json,',
    '  updated_at = excluded.updated_at'
  ].join('\n')).run(uid, enabled ? 1 : 0, JSON.stringify(disabled || []), time.nowUtc());
  return true;
}

function setEnabled(userId, enabled) {
  var opt = getOpt(userId);
  writeOpt(userId, !!enabled, opt.disabled);
  return getOpt(userId);
}

// 逐项开关。总开关关闭时仍记录逐项状态 —— 学生可能先关了音乐、
// 后来又整体关掉再整体打开，此时他原来"不想给音乐"的意愿应当还在。
function setItem(userId, key, on) {
  var opt = getOpt(userId);
  var known = ITEM_DEFS.some(function(d) { return d.key === key; });
  if (!known) return null;

  var next = opt.disabled.filter(function(k) { return k !== key; });
  if (!on) next.push(key);
  writeOpt(userId, opt.enabled, next);
  return getOpt(userId);
}

// ============================================================
// 把 CI 素材整理成「可展示」的一组条目
//
// 返回 null 表示"这一段没内容"（该素材种类为空），调用方跳过即可。
// 每一条都已是纯展示文本 —— 前端不需要再拼，避免前后端各写一套文案。
// ============================================================

function buildExams(ci) {
  var list = (ci && ci.exams) || [];
  if (!list.length) return null;
  var today = time.localDay();
  var out = [];

  for (var i = 0; i < list.length; i++) {
    var e = list[i] || {};
    var title = clean(e.title, 32);
    if (!title) continue;
    var date = String(e.target_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    var days = time.localDayDiff(today, date);
    // 已过期的倒计时不再展示：学生看到"距离…还有 -3 天"只会困惑
    if (days < 0) continue;

    out.push({
      title: title,
      target_date: date,
      days_left: days,
      urgent: days <= URGENT_DAYS
    });
  }

  if (!out.length) return null;
  out.sort(function(a, b) { return a.days_left - b.days_left; });
  return out.slice(0, 5);
}

function buildSignature(ci) {
  var s = clean(ci && ci.signature, 80);
  return s ? s : null;
}

function buildMusic(ci) {
  var m = (ci && ci.music) || {};
  var bits = [];

  var artists = m.top_artists || [];
  if (artists.length) {
    var names = [];
    for (var i = 0; i < artists.length && i < 6; i++) {
      var a = clean(artists[i] && artists[i].name, 24);
      if (a) names.push(a);
    }
    if (names.length) bits.push('常听 ' + names.join('、'));
  }
  var pls = [];
  var playlists = m.playlists || [];
  for (var p = 0; p < playlists.length && p < 3; p++) {
    var n = clean(playlists[p], 24);
    if (n) pls.push(n);
  }
  if (pls.length) bits.push('歌单 ' + pls.join('、'));
  if (Number(m.liked_count) > 0) bits.push('收藏 ' + Number(m.liked_count) + ' 首');

  return bits.length ? bits.join('；') : null;
}

function buildCommunity(ci) {
  var c = (ci && ci.community) || {};
  var bits = [];
  if (Number(c.post_count) > 0) bits.push('发帖 ' + Number(c.post_count) + ' 篇');
  if (Number(c.likes_received) > 0) bits.push('收到赞 ' + Number(c.likes_received));

  var tags = [];
  var list = c.post_tags || [];
  for (var i = 0; i < list.length && i < 8; i++) {
    var t = clean(list[i], 12);
    if (t) tags.push(t);
  }
  if (tags.length) bits.push('常写：' + tags.join('、'));

  return bits.length ? bits.join('；') : null;
}

function buildGames(ci) {
  var g = (ci && ci.games) || {};
  var bits = [];
  if (Number(g.chess) > 0) bits.push('象棋 ' + Number(g.chess) + ' 局');
  if (Number(g.gomoku) > 0) bits.push('五子棋 ' + Number(g.gomoku) + ' 局');
  return bits.length ? bits.join('、') : null;
}

function buildLevel(ci) {
  var lv = (ci && ci.level) || {};
  var lg = (ci && ci.login) || {};
  var bits = [];
  if (Number(lv.level) > 0) bits.push('等级 ' + Number(lv.level));
  if (Number(lg.streak) > 0) bits.push('连续登录 ' + Number(lg.streak) + ' 天');
  return bits.length ? bits.join(' · ') : null;
}

var BUILDERS = {
  exams: buildExams,
  signature: buildSignature,
  music: buildMusic,
  community: buildCommunity,
  games: buildGames,
  level: buildLevel
};

// ============================================================
// 对外主入口：构造完整的校园情境
//
// 返回：
//   {
//     linked:     Boolean  是否接入了 CI（false → 前端整块不渲染）
//     available:  Boolean  本次是否拿到了素材（CI 临时不可达时为 false）
//     enabled:    Boolean  学生是否允许使用（总开关）
//     items:      [{ key, label, text, on, exams? }]  可展示项（已按开关标注）
//     urgent:     { count, nearest: {title, days_left} } | null  临考提示
//   }
// ============================================================
function build(userId, opts) {
  var o = opts || {};
  var uid = String(userId || '');

  // ---- 独立性闸门：CI 未配置就是独立部署，这里直接收工 ----
  if (!ciBridge.isEnabled()) {
    return { linked: false, available: false, enabled: false, items: [], urgent: null };
  }

  var opt = o.opt || getOpt(uid);
  // 素材只从缓存读（同步、零延迟），绝不在这里 await 一次 CI 请求 ——
  // 这个接口可能被设置页、也可能被页面加载路径调用，绑上 CI 的可用性
  // 就会把"打开设置"变成一次网络冒险。下一轮对话时 turn-runner 自会刷新。
  var ci = o.ciProfile !== undefined ? o.ciProfile : ciBridge.getCachedStudentProfile(uid);

  if (!ci) {
    // 联动配了但这份素材还没取到（首次进入 / CI 临时不可达 / 该账号在 CI 不存在）
    return { linked: true, available: false, enabled: opt.enabled, items: [], urgent: null };
  }

  var items = [];
  for (var i = 0; i < ITEM_DEFS.length; i++) {
    var def = ITEM_DEFS[i];
    var value = BUILDERS[def.key](ci);
    if (!value) continue; // 这一段没内容 → 不展示空壳

    items.push({
      key: def.key,
      label: def.label,
      // exams 是数组，其余是字符串。前端按 key 分支渲染。
      text: typeof value === 'string' ? value : '',
      exams: def.key === 'exams' ? value : null,
      on: opt.disabled.indexOf(def.key) < 0
    });
  }

  // 临考提示：取最近的一场（只看 ≤ URGENT_DAYS 的）
  var urgent = null;
  var exams = items.filter(function(x) { return x.key === 'exams'; })[0];
  if (exams && exams.exams && exams.exams.length) {
    var near = exams.exams.filter(function(e) { return e.urgent && e.on !== false; });
    if (near.length) {
      urgent = { count: near.length, nearest: near[0] };
    }
  }

  return {
    linked: true,
    available: true,
    enabled: opt.enabled,
    items: items,
    urgent: urgent,
    updated_at: String(ci.generated_at || '')
  };
}

// ============================================================
// 临考科目 —— 给错题复习排序用（这是两个系统真正的"化学反应"）
//
// CI 有"学生自己标的考试倒计时"，Cluss 有"带科目的错题 + 复习排期"。
// 以前这两份数据各睡各的：明天考数学，复习队列却按排期日期机械推进，
// 一堆英语错题排在数学前面。
//
// 匹配方式刻意**不用硬编码科目表**：
//   从学生自己的错题表里取 distinct subject，再到考试标题里做子串匹配。
//   好处是自适应 —— 学校开什么科目、学生怎么简称（"数学""数子""高数"），
//   只要他错题里出现过这个名字，就能对上；反过来硬编码一份全国科目表，
//   遇到"信息与通用技术"这种立刻哑火。
//
// ---- 关键：标题里**没有科目名**时怎么办 ----
// 实测真实数据打脸：学生标的考试叫「10月月考」「期末考试」「高考」——
// 一个科目名都没有。只做子串匹配的话，这条链路在真实场景下基本不触发，
// 看起来"实现了"却等于没做。
//
// 但语义其实很清楚：**叫不出科目的考试，考的就是所有科目**。
// 「期末考试」不会只考数学。所以这类考试对全部科目同等成立 ——
// 于是复习队列按科目分组排列（同科目连着复习，不用来回切思维），
// 这恰好也是备考时真正想要的节奏。
//
// 命中具体科目时仍以**那一场**的天数为准："数学期中"只提前数学。
//
// 返回 [{ subject, days_left, exam_title }]，按剩余天数升序。
// CI 不可用 / 没有考试 → 空数组（调用方保持原有排序）。
// ============================================================
function urgentSubjects(userId, opts) {
  var o = opts || {};
  var uid = String(userId || '');
  if (!uid) return [];

  // 总开关关掉时，学业倒计时也不参与复习排序 ——
  // 学生表达的是"不要用我的校园信息"，这当然包括用它来重排我的错题
  var opt = o.opt || getOpt(uid);
  if (!opt.enabled || opt.disabled.indexOf('exams') >= 0) return [];

  var ci = o.ciProfile !== undefined ? o.ciProfile : ciBridge.getCachedStudentProfile(uid);
  if (!ci) return [];

  var exams = buildExams(ci);
  if (!exams) return [];

  var urgentExams = exams.filter(function(e) { return e.urgent; });
  if (!urgentExams.length) return [];

  // 学生自己错题里出现过的科目（空科目不参与）
  var subjects = [];
  try {
    subjects = db.prepare(
      "SELECT DISTINCT subject FROM wrong_questions WHERE user_id = ? AND subject <> '' AND mastered = 0"
    ).all(uid).map(function(r) { return String(r.subject); });
  } catch (e) {
    return []; // 错题表不可用时不做这件事，不能影响调用方
  }
  if (!subjects.length) return [];

  var out = [];

  function note(subject, days, title) {
    var hit = null;
    for (var i = 0; i < out.length; i++) {
      if (out[i].subject === subject) { hit = out[i]; break; }
    }
    if (!hit) {
      out.push({ subject: subject, days_left: days, exam_title: title });
      return;
    }
    // 同一科目被多场考试命中 → 留最近那场
    if (days < hit.days_left) {
      hit.days_left = days;
      hit.exam_title = title;
    }
  }

  urgentExams.forEach(function(e) {
    var title = String(e.title || '');
    var matched = subjects.filter(function(s) { return title.indexOf(s) >= 0; });
    // 没写出科目 → 这场考试对所有科目成立（"期末考试"考的就是全部）
    var targets = matched.length ? matched : subjects;
    targets.forEach(function(s) { note(s, e.days_left, title); });
  });

  out.sort(function(a, b) { return a.days_left - b.days_left; });
  return out;
}

// ============================================================
// 给提示词用：按开关过滤素材
//
// 学生关掉某一项，那一项就必须**真的不再进提示词** ——
// 否则开关只是个安慰按钮。这里在素材层做掉，buildCiSection 拿到的
// 就已经是过滤后的数据，无需它自己理解开关。
// ============================================================
function applyOpt(ci, opt) {
  if (!ci) return null;
  if (!opt) return ci;
  if (!opt.enabled) return null;

  var off = opt.disabled || [];
  if (!off.length) return ci;

  var out = {};
  Object.keys(ci).forEach(function(k) {
    if (off.indexOf(k) >= 0) return;
    out[k] = ci[k];
  });
  return out;
}

module.exports = {
  ITEM_DEFS: ITEM_DEFS,
  URGENT_DAYS: URGENT_DAYS,
  clean: clean,
  getOpt: getOpt,
  setEnabled: setEnabled,
  setItem: setItem,
  build: build,
  urgentSubjects: urgentSubjects,
  applyOpt: applyOpt
};
