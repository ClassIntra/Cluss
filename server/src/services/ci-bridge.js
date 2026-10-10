// ClassIntra 联动桥（客户端方向）
//
// 作用：联动部署时，让 ClassIntra 的账号能在 Cluss 登录，并为学生画像补充
// ClassIntra 侧的活动素材。
// 关键设计——**Cluss 绝不读 ClassIntra 的数据库**，只调用它的只读接口：
//   POST /api/cluss-bridge/verify           校验账号口令
//   GET  /api/cluss-bridge/student-profile  取该学生的画像素材（CI 侧已脱敏）
// 校验通过后把用户落库到 Cluss 本地（source='classintra'），此后可离线登录。
//
// 独立性保证：CI_BRIDGE_URL 未配置时，本模块所有函数立即返回「不可用」，
// Cluss 完全走本地账号体系，不受任何影响。画像素材同理 —— 取不到就当作没有这一维。

var axios = require('axios');
var config = require('../config');

var TIMEOUT_MS = 5000;

function isEnabled() {
  return !!(config.ci.bridgeUrl && config.ci.secret);
}

// 调用 ClassIntra 的委托认证接口
//
// 返回 { ok: true, user, ciDisabled? }
//     | { ok: false, reason: 'badpassword'|'notfound'|'bridgeconfig'|'network', message }
//
// ⚠️ 判定依赖 ClassIntra 侧 routes/cluss-bridge.js 的返回约定，**两边必须同步改**：
//   200 + data.user     → 口令正确（data.disabled 只是提示，**不代表要拒绝**）
//   401                 → 口令不对
//   404                 → 账号不存在
//   403（不带 data.user）→ **只剩「桥密钥不对」一种含义**，属配置问题
//
// 403 这一条是 2026-10-09 才拆开的。此前 CI 对「禁用账号」也回 403，与
// requireBridgeSecret 的「密钥校验失败」撞码且都不带 data，Cluss 收到 403
// 无法区分二者，只能一律拒绝 —— 于是「Cluss 不跟随 CI 的禁用」这条需求
// 在认证侧根本落不了地（名册同步那边已经删干净了，登录这边卡住）。
// 反过来「403 一律当成功放行」是认证绕过：密钥配错时任何密码都能登录，
// 绝不能那么做。所以只能由 CI 侧先拆码，这里才有得判。
function verifyWithClassIntra(account, password) {
  if (!isEnabled()) {
    return Promise.resolve({ ok: false, reason: 'network', message: '未配置 ClassIntra 联动' });
  }

  return axios.post(
    config.ci.bridgeUrl + '/api/cluss-bridge/verify',
    { account: account, password: password },
    {
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Secret': config.ci.secret
      }
    }
  ).then(function(resp) {
    var body = resp.data || {};
    if (body.code === 200 && body.data && body.data.user) {
      // 口令正确即放行。data.disabled 只记日志：Cluss 的启用/禁用是 Cluss 自己的事，
      // 已在 services/class-roster.js 里把 CI 状态的同步整条删掉。
      if (body.data.disabled) {
        console.warn('[CI-Bridge] 该账号在 ClassIntra 侧已禁用，按口令正确放行（Cluss 不跟随 CI 的禁用）');
      }
      return { ok: true, user: body.data.user, ciDisabled: !!body.data.disabled };
    }
    if (body.code === 401) {
      return { ok: false, reason: 'badpassword', message: body.message || '账号或密码错误' };
    }
    if (body.code === 404) {
      return { ok: false, reason: 'notfound', message: body.message || '账号不存在' };
    }
    return { ok: false, reason: 'network', message: body.message || '联动校验失败' };
  }).catch(function(err) {
    var status = err.response && err.response.status;
    if (status === 401) return { ok: false, reason: 'badpassword', message: '账号或密码错误' };
    if (status === 404) return { ok: false, reason: 'notfound', message: '账号不存在' };
    // CI 侧已不再对禁用账号回 403，所以这里**只可能**是桥密钥不匹配。
    // 单列一个 reason 而不是并进 badpassword：这两件事学生看到的提示、以及
    // 管理员该往哪儿查，方向完全不同（一个重置密码，一个改配置）。
    if (status === 403) {
      console.error('[CI-Bridge] 桥密钥校验失败：Cluss 的 CI_BRIDGE_SECRET 与 ClassIntra 的 RELAY_SECRET 不一致');
      return { ok: false, reason: 'bridgeconfig', message: 'ClassIntra 联动配置有误（桥密钥不匹配），请联系管理员' };
    }
    console.warn('[CI-Bridge] 校验请求失败:', err.message);
    return { ok: false, reason: 'network', message: 'ClassIntra 联动暂不可用' };
  });
}

// 探测联动可用性（管理台展示用）
function probe() {
  if (!isEnabled()) {
    return Promise.resolve({ enabled: false, reachable: false });
  }
  return axios.get(config.ci.bridgeUrl + '/api/cluss-bridge/ping', {
    timeout: TIMEOUT_MS,
    headers: { 'X-Bridge-Secret': config.ci.secret }
  }).then(function(resp) {
    return { enabled: true, reachable: !!(resp.data && resp.data.code === 200) };
  }).catch(function() {
    return { enabled: true, reachable: false };
  });
}

// ============================================================
// 学生画像素材（GET /api/cluss-bridge/student-profile）
//
// 用途：给「更懂这个学生」补上 Cluss 自己没有的那一维 —— 校园社区活动痕迹
// （签名、音乐口味、发帖标签、棋类、等级、连续登录）。CI 侧已做脱敏白名单，
// 这里拿到的就是可以直接进提示词的素材。
//
// ---- 为什么是「缓存 + 后台刷新」而不是一次 await ----
// 这段素材是**增强项**：有没有它，对话都该照常进行。若在每轮对话里同步 await
// 一次 CI 请求，CI 慢 2 秒学生的首字就慢 2 秒，CI 挂掉还要吃满超时 ——
// 为了一个"锦上添花"把主链路绑上别人的可用性，是不划算的。
// 所以：
//   · turn-runner 只读**已缓存**的那份（同步，零延迟）；
//   · 顺手触发一次后台刷新，下次对话就能用上最新值。
// 代价是"新数据晚一轮生效"，这对画像完全可接受。
// ============================================================

// SOFT：超过它就认为该刷新了（后台进行，不影响本次对话）
var PROFILE_SOFT_TTL_MS = 10 * 60 * 1000;
// HARD：超过它就认为数据太旧、宁可不给（也防止内存里留着陈旧画像）
var PROFILE_HARD_TTL_MS = 30 * 60 * 1000;
// 缓存条目上限：一个班几十人，200 足够；超出时按时间清掉最旧的几条。
// 不设上限的话，换班/换年级长期运行会一直堆积（虽然是内存，但没必要）。
var PROFILE_CACHE_MAX = 200;

var profileCache = {};    // userId → { at, data }（data 为 null 表示"CI 说没有这个人"）
var profileFetching = {}; // userId → true（防并发重复请求）

function cacheSize() {
  return Object.keys(profileCache).length;
}

// 超出上限时按时间清最旧的
function trimCache() {
  var keys = Object.keys(profileCache);
  if (keys.length <= PROFILE_CACHE_MAX) return;
  keys.sort(function(a, b) { return profileCache[a].at - profileCache[b].at; });
  var drop = keys.length - PROFILE_CACHE_MAX;
  for (var i = 0; i < drop; i++) delete profileCache[keys[i]];
}

// 同步读取已缓存的素材。没有 / 太旧 → null（调用方按"没有这一维"处理）
function getCachedStudentProfile(userId) {
  var key = String(userId || '');
  if (!key) return null;
  var hit = profileCache[key];
  if (!hit) return null;
  if (Date.now() - hit.at > PROFILE_HARD_TTL_MS) {
    delete profileCache[key];
    return null;
  }
  return hit.data;
}

// 拉一次素材并写进缓存。**永不抛**，也永不返回 reject —— 调用方是"发射后不管"。
//
// 返回 Promise（仅便于测试/排障），业务代码不需要等它。
function refreshStudentProfile(userId) {
  var key = String(userId || '');
  if (!key) return Promise.resolve(null);
  if (!isEnabled()) return Promise.resolve(null);
  if (profileFetching[key]) return Promise.resolve(null);

  var hit = profileCache[key];
  if (hit && Date.now() - hit.at < PROFILE_SOFT_TTL_MS) {
    // 还新鲜（含"CI 说没这个人"的负缓存）→ 不必再打一次
    return Promise.resolve(hit.data);
  }

  profileFetching[key] = true;

  return axios.get(config.ci.bridgeUrl + '/api/cluss-bridge/student-profile', {
    // 画像素材比登录校验更"可有可无"，超时给短一点：宁可这轮没有，也别占着连接
    timeout: TIMEOUT_MS,
    params: { userId: key },
    headers: { 'X-Bridge-Secret': config.ci.secret }
  }).then(function(resp) {
    var body = resp.data || {};
    var data = (body.code === 200 && body.data) ? body.data : null;
    profileCache[key] = { at: Date.now(), data: data };
    trimCache();
    return data;
  }).catch(function(err) {
    var status = err.response && err.response.status;
    if (status === 404) {
      // 账号在 CI 不存在（比如纯 Cluss 本地账号）：负缓存，避免每轮都白打一次
      profileCache[key] = { at: Date.now(), data: null };
      trimCache();
      return null;
    }
    if (status === 403) {
      // 与 verify 同因：桥密钥不匹配。这是配置问题，说一次就够，不必每轮刷屏
      console.warn('[CI-Bridge] 画像素材请求被拒（403）：CI_BRIDGE_SECRET 与 ClassIntra 的 RELAY_SECRET 不一致');
      return null;
    }
    // 网络抖动 / CI 没上线：静默降级。这是增强项，不该在日志里制造噪音。
    return null;
  }).then(function(out) {
    delete profileFetching[key];
    return out;
  });
}

module.exports = {
  isEnabled: isEnabled,
  verifyWithClassIntra: verifyWithClassIntra,
  probe: probe,
  getCachedStudentProfile: getCachedStudentProfile,
  refreshStudentProfile: refreshStudentProfile,
  // 仅供测试：清空缓存
  _clearProfileCache: function() {
    profileCache = {};
    profileFetching = {};
  },
  _profileCacheSize: cacheSize
};