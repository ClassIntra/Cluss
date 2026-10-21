// 隐藏密码：会话与笔记共用一份
//
// 定位：学生把某段对话"藏起来"的密码。**笔记私密（privateFiles）与会话隐藏
// 共用这一个密码** —— 曾经笔记密码存在 notes_data 里（学生本地），
// 会话没有密码，两份隐私两套入口，学生要么不知道、要么记两次。
//
// 存储：scrypt(password, salt) 的 hash + salt，**绝不存明文**。
//   Node 自带 crypto.scryptSync，不引第三方依赖。
//
// 解锁态：**进程级** Map<userId, 过期时间>，滑动 30 分钟。
//   为什么不放 jwt / 不下发 token：
//     ① 这是本地功能，不是跨服务鉴权，签发 token 是把简单问题做复杂；
//     ② 重启进程后解锁态失效、学生重输一次密码 —— 对"防翻一眼"的场景
//        完全可接受，反而是更稳的默认（关机即锁）。
//   代价：多节点部署下解锁态不共享（节点各锁各的），与 standalone 的实际
//   使用形态（一台机器一个进程）一致，可接受。
//
// 防爆破：verify 失败计数，同用户连续 5 次失败锁 10 分钟。
//   不依赖 IP（教室 NAT 后面一片学生共用一个出口 IP，按 IP 锁会误伤一片）。

var crypto = require('crypto');
var db = require('../utils/db');
var time = require('../utils/time');
var NL = String.fromCharCode(10);

var MIN_LEN = 4;
var MAX_LEN = 32;
var UNLOCK_TTL_MS = 30 * 60 * 1000;
var MAX_TRIES = 5;
var LOCKOUT_MS = 10 * 60 * 1000;

// userId → 过期时间戳（ms）
var unlocked = {};
// userId → { fails, until }
var throttling = {};

function now() { return Date.now(); }

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

// 返回 { ok, message }
function setup(userId, password) {
  var p = String(password == null ? '' : password);
  if (p.length < MIN_LEN || p.length > MAX_LEN) {
    return { ok: false, message: '密码长度 ' + MIN_LEN + '~' + MAX_LEN + ' 位' };
  }
  var uid = String(userId || '');
  if (!uid) return { ok: false, message: '未登录' };

  var salt = crypto.randomBytes(16).toString('hex');
  var nowText = time.nowUtc();
  var hash = hashPassword(p, salt);

  db.prepare([
    'INSERT INTO cluss_private_lock (user_id, password_hash, salt, created_at, updated_at)',
    'VALUES (?, ?, ?, ?, ?)',
    'ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash,',
    '  salt = excluded.salt, updated_at = excluded.updated_at'
  ].join(NL)).run(uid, hash, salt, nowText, nowText);

  unlocked[uid] = now() + UNLOCK_TTL_MS;
  throttling[uid] = null;
  return { ok: true, message: '已设置' };
}

// 修改密码：必须带对旧密码
function change(userId, oldPassword, newPassword) {
  var uid = String(userId || '');
  if (!uid) return { ok: false, message: '未登录' };
  if (!verifyLocked(uid, oldPassword)) return { ok: false, message: '原密码不正确' };
  return setup(uid, newPassword);
}

// 关掉密码会**保留**已隐藏的内容但不再有锁（内容转回普通可见？不 ——
// 隐藏标记还在，只是没有密码可校验了，会造成"看得见打不开"的死锁）。
// 所以 remove 只允许在"当前没有隐藏内容"时调用；有隐藏内容要先取消隐藏。
function remove(userId) {
  var uid = String(userId || '');
  var hidden = db.prepare('SELECT COUNT(*) AS n FROM ai_conversations WHERE user_id = ? AND hidden = 1').get(uid);
  if (hidden && hidden.n > 0) {
    return { ok: false, message: '还有 ' + hidden.n + ' 个隐藏会话，先取消它们的隐藏' };
  }
  db.prepare('DELETE FROM cluss_private_lock WHERE user_id = ?').run(uid);
  delete unlocked[uid];
  return { ok: true, message: '已移除隐藏密码' };
}

// 内部：纯校验（不带节流副作用）。规则：找不到用户行 = 无法校验。
function verifyLocked(uid, password) {
  var row = db.prepare('SELECT password_hash, salt FROM cluss_private_lock WHERE user_id = ?').get(String(uid || ''));
  if (!row) return false;
  var p = String(password == null ? '' : password);
  if (p.length < 1) return false;
  var a = Buffer.from(hashPassword(p, row.salt), 'hex');
  var b = Buffer.from(String(row.password_hash), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 带节流的校验：连续 5 次失败锁 10 分钟。
// 成功即开锁（滑动续期）。
function verify(userId, password) {
  var uid = String(userId || '');
  if (!uid) return { ok: false, message: '未登录' };

  var t = throttling[uid];
  if (t && t.until > now()) {
    var secs = Math.ceil((t.until - now()) / 1000);
    return { ok: false, message: '尝试太多次，请 ' + secs + ' 秒后再试' };
  }

  if (!db.prepare('SELECT user_id FROM cluss_private_lock WHERE user_id = ?').get(uid)) {
    return { ok: false, message: '还没有设置隐藏密码' };
  }
  if (!verifyLocked(uid, password)) {
    var fails = (t && t.fails || 0) + 1;
    if (fails >= MAX_TRIES) {
      // 第 MAX_TRIES 次失败就要**当场**告知已锁。
      // 曾经这里返回"还可试 0 次"——学生看到还以为是提示文案出错，
      // 实际已经进锁定期了，下一次才告诉他要等，中间像坏了一样。
      throttling[uid] = { fails: 0, until: now() + LOCKOUT_MS };
      var waitSecs = Math.ceil(LOCKOUT_MS / 1000);
      return { ok: false, message: '尝试太多次，请 ' + waitSecs + ' 秒后再试' };
    }
    throttling[uid] = { fails: fails, until: 0 };
    return { ok: false, message: '密码不正确（还可试 ' + (MAX_TRIES - fails) + ' 次）' };
  }

  unlocked[uid] = now() + UNLOCK_TTL_MS;
  delete throttling[uid];
  return { ok: true, message: '已解锁' };
}

// 手动上锁（清解锁态，内容立即重新隐藏）
function lock(userId) {
  delete unlocked[String(userId || '')];
  return { ok: true, message: '已上锁' };
}

// 该用户当前是否处于解锁态（滑动过期：每次访问都续期到 now + TTL）
function isUnlocked(userId) {
  var uid = String(userId || '');
  var exp = unlocked[uid];
  if (!exp) return false;
  if (exp <= now()) { delete unlocked[uid]; return false; }
  unlocked[uid] = now() + UNLOCK_TTL_MS;
  return true;
}

function status(userId) {
  var uid = String(userId || '');
  var row = db.prepare('SELECT updated_at FROM cluss_private_lock WHERE user_id = ?').get(uid);
  return {
    hasPassword: !!row,
    unlocked: isUnlocked(uid),
    updatedAt: row ? row.updated_at : ''
  };
}

module.exports = {
  MIN_LEN: MIN_LEN,
  MAX_LEN: MAX_LEN,
  setup: setup,
  change: change,
  remove: remove,
  verify: verify,
  lock: lock,
  isUnlocked: isUnlocked,
  status: status,
  _internal: { hashPassword: hashPassword }
};
