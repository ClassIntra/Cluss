// 认证中间件
//
// 与 ClassIntra 的差异（有意为之）：
//   - 支持双密钥校验（Cluss 密钥 + 可选的 ClassIntra 密钥），实现联动免登
//   - Cluss 没有「班干」体系，管理员只有 is_admin 一个来源；
//     但班管（class_admin）通过 CI token 的 is_class_admin 标记映射进来 ——
//     联动部署下班管才是实际管理者，开发账号只是开发用
//   - token 来自 ClassIntra 时，若本地无该用户则就地落库（联邦引入），
//     否则后续任何按 user_id 的查询都会落空

var jwtUtil = require('../utils/jwt');
var db = require('../utils/db');
var constants = require('../utils/constants');
var classRoster = require('../services/class-roster');

// 认证 cookie 的**唯一来源**：名字与属性必须只此一处定义。
// 设置与清除要用**完全相同**的属性，否则浏览器按 name+domain+path 匹配删除时会删不掉，
// 留下一个"幽灵 cookie"持续干扰（清除时少一个 Path 就是典型）。
// cookie 名用 cluss_token 而非 token：cookie 不按端口隔离，Cluss 与 ClassIntra
// 同机不同端口部署时，同名 cookie 会互相覆盖，一边登录就会把另一边踢回登录页。
var AUTH_COOKIE = 'cluss_token';
var AUTH_COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/' };

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, Object.assign(
    { maxAge: 7 * 24 * 60 * 60 * 1000 },
    AUTH_COOKIE_OPTS
  ));
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, AUTH_COOKIE_OPTS);
}

// 从 Authorization 头 / cookie / query 中提取 token。
//
// ⚠️ **顺序是「头 → cookie → query」，头必须优先** —— 这是踩过的真实故障：
//   现象：同一账号在两处登录后，其中一处明明刚登录却提示「登录已过期」。
//   原因：前端 api.js 每次请求都从 store（localStorage）取**最新** token 放进
//     Authorization 头；而 cluss_token 这个 cookie **不分端口、不分实例**
//     （同 host 全端口共享，且 httpOnly，JS 碰不到），是浏览器里的"环境态"。
//     学生在平板上既走 CI 壳免登（`?token=`，只写 localStorage）又直连 Cluss 登录
//     （写 cookie）时，两条路径各写各的 —— localStorage 是新的，cookie 还是上一次
//     登录（甚至另一个 Cluss 实例签发）的旧的。老实现 cookie 优先，于是拿陈旧
//     cookie 去验签 → 401；请求里那个**完全有效的头被静默丢弃**。
//   口径：头是"本次请求显式携带的凭据"，cookie 只是兜底（浏览器直接打开 API
//     地址、无法设置请求头的场景）。
function extractToken(req) {
  var token = '';
  if (req.headers && req.headers.authorization) {
    token = req.headers.authorization.replace(/^Bearer\s+/i, '');
  }
  if (!token && req.cookies) token = req.cookies[AUTH_COOKIE];
  if (!token && req.query && req.query.token) token = req.query.token;
  return token || '';
}

// ClassIntra token 里的管理身份 → Cluss 的 is_admin。
// 班管（is_class_admin）是实际管理者；CI 系统管理员同样视为管理员。
function ciAdminFlag(decoded) {
  return !!(decoded && (decoded.is_class_admin === true || decoded.is_admin === true)) ? 1 : 0;
}

// 确保 token 中的用户在本地存在（联邦引入时补齐）
// 仅做「补建」，绝不覆盖已有账号的密码；管理身份随 CI 的班管标记走（见 syncCiAdminFlag）
function ensureLocalUser(decoded, source) {
  if (!decoded || !decoded.user_id) return null;
  var row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(decoded.user_id));
  if (row) return row;

  if (source !== 'classintra') return null;

  // 从 ClassIntra 引进的账号：密码未知，存空串（该用户只能在 CI 侧改密码，
  // 或通过桥的委托认证登录），状态默认 active；班管/CI管理员 → is_admin=1
  try {
    var nowUtc = require('../utils/time').nowUtc();
    var uid = String(decoded.user_id);
    // CI 的 user_id 编码 YYCCNN：能解出班级与入学年份，落库时一并带上
    var ciClassNo = /^\d{6}$/.test(uid) ? uid.slice(2, 4) : '';
    var ciYear = /^\d{6}$/.test(uid) ? '20' + uid.slice(0, 2) : '';
    db.prepare([
      'INSERT INTO users (user_id, net_name, real_name, gender, password_hash, status, is_admin, info_json, source,',
      '  enrollment_year, class_no, created_at)',
      'VALUES (?, ?, ?, ?, \'\', \'active\', ?, \'{}\', \'classintra\', ?, ?, ?)'
    ].join('\n')).run(
      uid,
      String(decoded.net_name || decoded.real_name || decoded.user_id),
      String(decoded.real_name || decoded.net_name || decoded.user_id),
      String(decoded.gender || ''),
      ciAdminFlag(decoded),
      ciYear, ciClassNo,
      nowUtc
    );
    console.log('[Auth] 已从 ClassIntra 引入账号:', decoded.user_id);
    return db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(decoded.user_id));
  } catch (e) {
    // 唯一约束冲突（同名/同网名被占用）：说明本地已有等价账号，交给调用方处理
    console.warn('[Auth] 引入 ClassIntra 账号失败:', e.message);
    return null;
  }
}

// 班管身份同步：CI 侧班管变动（交接/卸任）后，Cluss 侧下次带 token 请求即跟上。
//
// ⚠️ 判据是「token 由谁签发」，不是「账号当初怎么来的」——这是踩过的一次真实事故：
//   Cluss 的学号体系与 ClassIntra 同构（YY+班+序号，见 services/user-id.js），
//   本地注册的账号完全可能抢占 CI 班管的**同一个 user_id**（实测 251800：
//   CI 侧是 25 届 18 班班管，Cluss 侧是个 source='local' 的普通账号）。
//   原先的守卫 `row.source !== 'classintra'` 直接跳过同步，于是 CI token 里明明带着
//   is_class_admin=true，也永远落不到库里 —— 班管进来看不到管理台、/api/admin/* 一律 403。
//   一句话：本地占号不该对 CI 的权威声明有否决权。
//
// 右边界也要留：Cluss 自己签发的 token 不动 is_admin（本地账号的管理权归本地管理台管，
// 否则管理员在管理台提权的人会被他自己的登录请求打回去）。
function syncCiAdminFlag(row, decoded, tokenSource) {
  if (!row) return row;
  if (tokenSource !== 'classintra') return row;

  var want = ciAdminFlag(decoded);
  if ((row.is_admin === 1 ? 1 : 0) === want) return row;
  try {
    db.prepare('UPDATE users SET is_admin = ? WHERE user_id = ?').run(want, row.user_id);
    row.is_admin = want;
    // 撞号（本地账号被 CI 认领）单独点出来：这条日志是以后排「管理台怎么又不见了」的第一手证据
    var tag = row.source === 'classintra' ? '' : '（本地账号与 CI 同号，已按 CI 声明认领）';
    console.log('[Auth] 已同步 ClassIntra 班管身份:', row.user_id, 'is_admin=' + want + tag);
  } catch (e) {
    console.warn('[Auth] 同步班管身份失败:', e.message);
  }
  return row;
}

// CI 身份资料同步：ClassIntra 是权威身份源——学生在 CI 侧改名/换班后，
// Cluss 不该一直显示旧名字。只在确实有差异时才写库（绝大多数请求零开销）。
//
// 刻意**不动 net_name**：它是本地登录凭据之一，CI 侧改名不该让学生
// 「用自己记得的用户名登不进来」。展示名走 real_name（前端 `real_name || net_name`）。
// ⚠️ users.real_name 有 UNIQUE 约束：新名字被别人占用时保留旧值并告警，
// 绝不因此让整个请求失败——名字是展示信息，不值得把登录打断。
function syncCiProfile(row, decoded, tokenSource) {
  if (!row || tokenSource !== 'classintra' || !decoded) return row;

  var patch = {};
  if (decoded.real_name && String(decoded.real_name) !== row.real_name) {
    patch.real_name = String(decoded.real_name);
  }
  if (decoded.gender && String(decoded.gender) !== row.gender) {
    patch.gender = String(decoded.gender);
  }
  // CI 的 user_id 编码 YYCCNN，班级与入学年份能直接解出来（同 ensureLocalUser 的口径）
  var uid = String(row.user_id);
  if (/^\d{6}$/.test(uid)) {
    var ciClassNo = uid.slice(2, 4);
    var ciYear = '20' + uid.slice(0, 2);
    if (ciClassNo !== (row.class_no || '')) patch.class_no = ciClassNo;
    if (ciYear !== (row.enrollment_year || '')) patch.enrollment_year = ciYear;
  }

  var keys = Object.keys(patch);
  if (!keys.length) return row;
  try {
    var stmt = db.prepare(
      'UPDATE users SET ' + keys.map(function(k) { return k + ' = ?'; }).join(', ') + ' WHERE user_id = ?'
    );
    stmt.run.apply(stmt, keys.map(function(k) { return patch[k]; }).concat([row.user_id]));
    for (var i = 0; i < keys.length; i++) row[keys[i]] = patch[keys[i]];
    console.log('[Auth] 已同步 ClassIntra 身份资料:', row.user_id, JSON.stringify(patch));
  } catch (e) {
    console.warn('[Auth] 同步身份资料失败（保留本地值）:', row.user_id, e.message);
  }
  return row;
}

// 「CI 声明 → 本地账号」的一次性对齐：管理身份 + 身份资料。
// ⚠️ 只此一个出口。以前 routes/auth.js 的桥登录路径自己写了一份 is_admin 的 SQL，
// 两边口径一改就漂（同号本地账号该不该认领，就是一个真实踩到的例子）。
function syncFromClassIntra(row, decoded) {
  return syncCiProfile(syncCiAdminFlag(row, decoded, 'classintra'), decoded, 'classintra');
}

function requireAuth(req, res, next) {
  var token = extractToken(req);
  if (!token) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }

  var result = jwtUtil.verifyToken(token);
  if (!result.valid) {
    // 验签失败说明这个 token 已经没用了。若它是**陈旧 cookie**带上来的，
    // 不清掉就会一直遮挡后续请求（每次都被它覆盖，前端永远好不了；
    // cookie 是 httpOnly，只有服务端能清）。
    clearAuthCookie(res);
    return res.status(401).json({ code: 401, message: '登录已过期' });
  }

  var decoded = result.data;

  // 头里的凭据已经胜出。此时 cookie 必须**同步成这个胜出的 token**，不能简单删掉。
  //
  // ⚠️ 为什么是"同步"而不是"清除"（2026-10-09 第二个坑，实测坐实）：
  //   浏览器里有一大类请求**根本带不了 Authorization 头** —— `<img src>`、`<video src>`、
  //   点开下载链接、在内嵌 PDF 里翻页。它们只能靠 cookie 认证
  //   （见 routes/cloud.js 的 `GET /files/:hash`，云盘缩略图就是它）。
  //   而免登路径（CI 应用壳 `?token=`）只用**头**校验一次、从不写 cookie，
  //   所以内嵌态下这些请求必然 401 → 前端弹「登录已过期，图片加载失败，请重新登录」。
  //   更糟的是"清掉不一致的 cookie"会连**本来有一个能用 cookie** 的用户一起打掉 ——
  //   表现就是「同一个设备上、一处能正常用、另一处说登录过期」。
  //   结论：cookie 是"替带不了头的请求兜底"的凭据，它必须始终镜像当前胜出的那个 token。
  //   （cookie 名/属性仍只在 AUTH_COOKIE / AUTH_COOKIE_OPTS 一处定义，见上）
  var cookieToken = (req.cookies && req.cookies[AUTH_COOKIE]) || '';
  if (cookieToken !== token) setAuthCookie(res, token);

  var row = ensureLocalUser(decoded, result.source);
  if (!row) {
    return res.status(401).json({ code: 401, message: '账号不存在，请重新登录' });
  }
  // 用 token 的签发方（result.source）判断，而不是 row.source —— 见 syncCiAdminFlag 的说明
  row = syncCiAdminFlag(row, decoded, result.source);
  row = syncCiProfile(row, decoded, result.source);

  // 班管带 CI token 进来时，按节流把**本班名册**同步进来（只增不删，失败静默）。
  // 名册即世界边界：本班不全，班管就没法提前给全班开额度；
  // 他班残留则会抢占同号学生的位置（见 services/class-roster.js 的说明）。
  if (ciAdminFlag(decoded) === 1) {
    classRoster.maybeAutoSync(row.user_id, result.source);
  }

  if (row.status === 'disabled') {
    return res.status(403).json({ code: 403, message: '该账号已被禁用' });
  }

  req.user = {
    user_id: row.user_id,
    net_name: row.net_name,
    real_name: row.real_name,
    is_admin: row.is_admin === 1 ? 1 : 0,
    source: row.source || 'local'
  };
  req.tokenSource = result.source;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }
  if (req.user.is_admin === 1) return next();
  return res.status(403).json({ code: 403, message: '无权限访问' });
}

module.exports = {
  requireAuth: requireAuth,
  requireAdmin: requireAdmin,
  extractToken: extractToken,
  setAuthCookie: setAuthCookie,
  clearAuthCookie: clearAuthCookie,
  syncFromClassIntra: syncFromClassIntra
};