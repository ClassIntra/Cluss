// 本班名册同步（ClassIntra 联动）
//
// Cluss 是「一班一节点」的应用：**名册就是它的世界边界**。
//   · 联动时把**本班**账号全量纳入 —— 班管才能提前批量给额度、在管理台看到完整班级
//   · **非本班的一律不收**；库里已有的历史残留也要能清掉
//
// 两条硬边界（都是有代价换来的）：
//   1. 「本班」从**学号本身**解出（YYCCNN → YY + CC），不读别处的配置或参数：
//      同一个数据源既管身份又管归属，不会出现「名册说 18 班、学号说 19 班」的分裂。
//   2. **纳入是幂等的自动动作，清理只能显式触发**（还要 confirm）。
//      自动删账号是不可逆事故的标准剧本 —— 这条路故意不给。
//
// 为什么非本班的必须清掉（不只是「不加」）：Cluss 学号体系与 CI 同构，
// 一个他班账号会**抢占**本班同号学生的位置，把 CI 对那个人声明的身份挡在外面
// （见 middleware/auth.js 的撞号说明，2026-10-08 真实踩过）。

var axios = require('axios');
var db = require('../utils/db');
var config = require('../config');
var time = require('../utils/time');
var cloudStore = require('./cloud-store');
var ciBridge = require('./ci-bridge');

var TIMEOUT_MS = 8000;

// 官方建议一次同步间隔（自动同步的节流）：班管来回切页面不该反复拉名册
var AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// ---- 归属判定 ----

// 6 位学号 → 班级归属；不是 6 位数字（开发账号、字母账号）算「无班」
function classOf(userId) {
  var uid = String(userId || '');
  if (!/^\d{6}$/.test(uid)) return null;
  return { yy: uid.slice(0, 2), classNo: uid.slice(2, 4), enrollmentYear: '20' + uid.slice(0, 2) };
}

// 豁免名单：本机的开发/管理账号不属于任何班，任何情况下都不参与清理
function protectedIds() {
  var ids = {};
  var dev = String((config.admin && config.admin.userId) || '999999');
  ids[dev] = true;
  return ids;
}

function isForeign(userId, yy, classNo) {
  var c = classOf(userId);
  if (!c) return false; // 无班账号不参与清理
  return c.yy !== yy || c.classNo !== classNo;
}

// ---- 拉名册（只读桥，绝不读 CI 的库）----

function fetchRoster(year, classNo) {
  if (!ciBridge.isEnabled()) {
    return Promise.reject(new Error('未配置 ClassIntra 联动（CI_BRIDGE_URL / CI_BRIDGE_SECRET）'));
  }
  return axios.get(config.ci.bridgeUrl + '/api/cluss-bridge/class-roster', {
    params: { year: year, classNo: classNo },
    timeout: TIMEOUT_MS,
    headers: { 'X-Bridge-Secret': config.ci.secret }
  }).then(function(resp) {
    var body = resp.data || {};
    if (body.code !== 200 || !body.data) {
      throw new Error(body.message || 'ClassIntra 名册获取失败');
    }
    return body.data;
  });
}

// ---- 纳入（幂等，只增不删）----

function adoptRoster(roster) {
  var students = (roster && roster.students) || [];
  var summary = { total: students.length, added: 0, updated: 0, unchanged: 0, failed: [] };
  var nowUtc = time.nowUtc();

  students.forEach(function(s) {
    var uid = String(s.user_id || '');
    if (!uid) return;
    var c = classOf(uid);
    // 管理身份：名册是 CI 的权威声明，口径与 middleware/auth.js 的 syncCiAdminFlag 一致
    var wantAdmin = (s.is_class_admin === true || s.is_admin === true) ? 1 : 0;

    try {
      var row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);

      if (!row) {
        db.prepare([
          'INSERT INTO users (user_id, net_name, real_name, gender, password_hash, status, is_admin, info_json, source,',
          '  enrollment_year, class_no, created_at)',
          'VALUES (?, ?, ?, ?, \'\', ?, ?, \'{}\', \'classintra\', ?, ?, ?)'
        ].join('\n')).run(
          uid,
          String(s.net_name || s.real_name || uid),
          String(s.real_name || s.net_name || uid),
          String(s.gender || ''),
          // 固定 active：Cluss **不跟随** ClassIntra 的禁用状态（见下方说明）
          'active',
          wantAdmin,
          c ? c.enrollmentYear : '',
          c ? c.classNo : '',
          nowUtc
        );
        summary.added++;
        return;
      }

      // 已有账号：对齐资料。**刻意不动 net_name** —— 它是本地登录凭据，
      // CI 侧改名不该让学生「用自己记得的用户名登不进来」（同 middleware/auth.js 的口径）
      var patch = {};
      if (s.real_name && String(s.real_name) !== row.real_name) patch.real_name = String(s.real_name);
      if (s.gender && String(s.gender) !== row.gender) patch.gender = String(s.gender);
      if (c && c.classNo !== (row.class_no || '')) patch.class_no = c.classNo;
      if (c && c.enrollmentYear !== (row.enrollment_year || '')) patch.enrollment_year = c.enrollmentYear;
      if ((row.is_admin === 1 ? 1 : 0) !== wantAdmin) patch.is_admin = wantAdmin;
      // ⚠️ 这里**曾经**把 CI 的 status 同步进 Cluss（先单向锁存、后又改成双向跟随），
      //   两次都出过真实故障：
      //     · 单向锁存 → 全仓没有任何「解禁」入口，一旦禁用就永远回不来；
      //     · 双向跟随 → CI 那边误操作一禁，班里的 Cluss 立刻跟着锁死，
      //       而两边是两个系统，撤销动作往往只做一边。
      //   现在按决定**整条删掉**：名册同步不再碰 status，Cluss 的启用/禁用
      //   是 Cluss 自己的事，不再被 ClassIntra 的状态牵着走。
      //   代价与前提：CI 侧禁用不再自动挡住 Cluss —— 若将来需要，
      //   要做成 Cluss 侧的显式操作（并标明来源），而不是 piggybone 在同步里。

      var keys = Object.keys(patch);
      if (!keys.length) { summary.unchanged++; return; }

      var stmt = db.prepare(
        'UPDATE users SET ' + keys.map(function(k) { return k + ' = ?'; }).join(', ') + ' WHERE user_id = ?'
      );
      stmt.run.apply(stmt, keys.map(function(k) { return patch[k]; }).concat([uid]));
      summary.updated++;
    } catch (e) {
      // net_name / real_name 有 UNIQUE 约束：撞名不能让整批同步挂掉，记下来交给班管看
      summary.failed.push({ user_id: uid, real_name: String(s.real_name || ''), reason: e.message });
    }
  });

  return summary;
}

// ---- 清理（破坏性，必须显式触发）----

// 非本班账号清单：预览与实际删除**共用这一个函数** —— 两处各写一份，
// 迟早出现「预览说 32 个、实际删了 33 个」
function listForeign(yy, classNo) {
  var guard = protectedIds();
  return db.prepare(
    'SELECT user_id, net_name, real_name, source, is_admin, status, class_no FROM users'
  ).all().filter(function(r) {
    return !guard[String(r.user_id)] && isForeign(r.user_id, yy, classNo);
  });
}

// 运行时发现「哪些表挂了 user_id」——将来新增迁移加了新表也自动覆盖，不会漏清。
// 这是刻意不做硬编码清单：漏一张表就是一批孤儿数据，而且不会有任何症状。
function userLinkedTables() {
  var tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(function(r) { return r.name; });

  return tables.filter(function(t) {
    if (t === 'users') return false;
    return db.prepare('PRAGMA table_info(' + t + ')').all()
      .some(function(c) { return c.name === 'user_id'; });
  });
}

// 彻底移除一批账号，连同从属数据。
//
// ⚠️ users 表**没有外键保护**（其他表只是普通列引用），所以「只删 users 那一行」
// 会留下一堆孤儿数据（额度、积分流水、会话、云盘引用）。这里按运行时发现的表清单清。
// ⚠️ 云盘必须走 cloudStore.deleteFile：**先删引用、引用归零才软删文件**。
// 直接 DELETE cloud_user_files 会漏掉 cloud_files 的软删标记 —— 那是项目红线。
function purgeUsers(userIds) {
  var guard = protectedIds();
  var ids = userIds.map(String).filter(function(id) { return !guard[id]; });
  var removed = { count: ids.length, files: 0 };

  // 1) 云盘：每份文件走既有原语（自带「引用归零才软删」的小事务）
  ids.forEach(function(uid) {
    var files = db.prepare('SELECT file_hash FROM cloud_user_files WHERE user_id = ?').all(uid);
    files.forEach(function(f) {
      try {
        cloudStore.deleteFile(f.file_hash, uid);
        removed.files++;
      } catch (e) {
        console.warn('[ClassRoster] 云盘清理失败:', uid, f.file_hash, e.message);
      }
    });
  });

  // 2) 从属数据 + users 行，同一个事务：要么全干净，要么一行没动
  var tables = userLinkedTables();
  var tx = db.transaction(function() {
    ids.forEach(function(uid) {
      // 会话正文没有 user_id，挂在 conversation_id 上，单独处理
      var convs = db.prepare('SELECT id FROM ai_conversations WHERE user_id = ?').all(uid);
      convs.forEach(function(c) {
        db.prepare('DELETE FROM ai_messages WHERE conversation_id = ?').run(c.id);
      });
      tables.forEach(function(t) {
        db.prepare('DELETE FROM ' + t + ' WHERE user_id = ?').run(uid);
      });
      db.prepare('DELETE FROM users WHERE user_id = ?').run(uid);
    });
  });
  tx();

  return removed;
}

// ---- 对外主入口 ----

// 当前名册状态（管理台展示用）
function status(yy, classNo) {
  var rows = db.prepare('SELECT user_id, source FROM users').all();
  var inClass = 0;
  var foreign = listForeign(yy, classNo);
  var noClass = 0;
  rows.forEach(function(r) {
    var c = classOf(r.user_id);
    if (!c) { noClass++; return; }
    if (c.yy === yy && c.classNo === classNo) inClass++;
  });
  return {
    yy: yy,
    class_no: classNo,
    enrollment_year: '20' + yy,
    in_class: inClass,
    foreign_count: foreign.length,
    foreign: foreign.map(function(r) {
      return { user_id: r.user_id, net_name: r.net_name, real_name: r.real_name, source: r.source, is_admin: r.is_admin };
    }),
    no_class: noClass,
    bridge_enabled: ciBridge.isEnabled(),
    last_sync_at: lastSync.at
  };
}

// 本机用户里出现最多的「届」（学号前两位）。库里还没有学生时返回 null。
// 用途：实例号只带班号（class-08），不带届别，届别得从数据里看出来。
function dominantYear() {
  var row = db.prepare(
    "SELECT substr(user_id, 1, 2) AS yy, COUNT(*) AS n FROM users " +
    "WHERE length(user_id) = 6 AND user_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]' " +
    "GROUP BY yy ORDER BY n DESC LIMIT 1"
  ).get();
  return (row && row.yy) ? String(row.yy) : null;
}

// 从「班管自己的学号」推出本班 —— 这是**破坏性操作（清理非本班账号）与自动收名册
// 的唯一基准**，所以判据和 classOf 不一样：
//
//   1. **班号以本机实例号为准**（instance_id = class-08 → 就是 08 班）。
//      为什么不信"登录者的学号"：2026-10-22 真实事故 —— 18 班管理员登进 8 班，
//      8 班按他自己的学号 2518xx 认成了 18 班，把 18 班整份名册（50 人）收进本机
//      users。"谁登录了"是变化量，"这台机器是哪个班"是常量，归属必须取常量。
//
//   2. **届别取本机用户里最多的那一届**；库里还没有学生（全新部署）时退回账号自己
//      的届别 —— 否则首次同步会因为"算不出届别"而被拒，永远拉不到第一名册。
//
//   3. 单机部署（instance_id 不是 class-NN，如 cluss-local）没有实例班号可比，
//      退回只看学号，保持老行为。
//
//   4. 开发账号（999999）在 class-NN 实例上会被解析成「本机这个班」—— 这是刻意的：
//      实例号是配置、不可被访客影响，所以不会误判；而 99 届 99 班那种胡来会被
//      下面的班号范围检查拦掉（旧代码正是拿 999999 解出 99/99，一点"清理非本班"
//      就把全校学生判成外班删掉）。
function classOfAdmin(userId) {
  var uid = String(userId || '');
  var adminClass = classOf(uid);

  var m = /^class-(\d{2})$/.exec(String(config.instanceId || ''));
  var classNo = m ? m[1] : (adminClass ? adminClass.classNo : null);
  if (!classNo) return null;

  var n = parseInt(classNo, 10);
  if (!(n >= 1 && n <= 30)) return null;

  var yy = dominantYear() || (adminClass ? adminClass.yy : null);
  if (!yy) return null;

  return { yy: yy, classNo: classNo };
}

// 同步本班：拉名册 → 纳入；opts.prune=true 时顺带清理非本班
function syncClass(yy, classNo, opts) {
  var o = opts || {};
  return fetchRoster('20' + yy, classNo).then(function(roster) {
    var adopted = adoptRoster(roster);
    var result = {
      class_no: classNo,
      enrollment_year: '20' + yy,
      roster_total: roster.total || adopted.total,
      adopted: adopted
    };
    lastSync.at = new Date().toISOString();

    if (o.prune) {
      var doomed = listForeign(yy, classNo);
      result.prune_preview = doomed.map(function(r) { return r.user_id; });
      if (o.execute) {
        result.pruned = purgeUsers(doomed.map(function(r) { return r.user_id; }));
      }
    }
    return result;
  });
}

// 自动同步：班管带 CI token 请求时按节流触发（**只增不删**）。
// 失败一律静默——名册同步是锦上添花，绝不能因为它把班管的正常请求搞挂。
var lastSync = { at: '', inFlight: false };

function maybeAutoSync(adminUserId, tokenSource) {
  if (tokenSource !== 'classintra') return;
  var c = classOfAdmin(adminUserId);
  if (!c) return;

  var now = Date.now();
  if (lastSync.inFlight) return;
  if (lastSync.ms && now - lastSync.ms < AUTO_SYNC_INTERVAL_MS) return;

  lastSync.inFlight = true;
  lastSync.ms = now;
  syncClass(c.yy, c.classNo, { prune: false }).then(function(r) {
    if (r.adopted.added || r.adopted.updated) {
      console.log('[ClassRoster] 自动同步本班名册: %s届%s班 新增 %d / 更新 %d / 失败 %d',
        c.yy, c.classNo, r.adopted.added, r.adopted.updated, r.adopted.failed.length);
    }
  }).catch(function(e) {
    // 悄悄退避：CI 没起来时不要每 5 分钟刷一条错误日志
    console.warn('[ClassRoster] 自动同步失败（不影响请求）:', e.message);
  }).then(function() {
    lastSync.inFlight = false;
  });
}

module.exports = {
  classOf: classOf,
  classOfAdmin: classOfAdmin,
  isForeign: isForeign,
  fetchRoster: fetchRoster,
  adoptRoster: adoptRoster,
  listForeign: listForeign,
  purgeUsers: purgeUsers,
  status: status,
  syncClass: syncClass,
  maybeAutoSync: maybeAutoSync
};
