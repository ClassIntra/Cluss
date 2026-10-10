// JWT 工具：签发与校验
//
// ---- Cluss 自己签的 token ----
// 单密钥 HS256，与 JWT_SECRET 一致。
//
// ---- ClassIntra 签的 token（双密钥校验）----
// token 先用 Cluss 自己的密钥验；失败后再尝试 ClassIntra 的密钥（若已配置）。
// 这样在联动部署下，用户在 ClassIntra 登录后跳转过来也能直接通过，
// 而不需要先改配置或重新登录。
//
// ---- 为什么加非对称验签 ----
// jwtSecret 是**对称共享密钥**：任何持有它的一方都能用 jsonwebtoken 签出
// 任意 payload。在联动场景下这等于「CI 侧任何一处泄露 = Cluss 管理员权限泄露」，
// 因为 Cluss 会照着 token 里的 is_admin 去改写本地账号的管理标志
// （见 middleware/auth.js 的 syncCiAdminFlag）。
//
// 配 CI_JWT_PUBLIC_KEY（RS256 公钥）后，Cluss 只拿公钥：
// 能验真，造不出假。两者可以并存，让 CI 分步切换而联登不中断。

var jwt = require('jsonwebtoken');
var config = require('../config');

// ⚠️ 非对称验签必须**锁定算法**，不能只给公钥。
//   否则攻击者可以把一个 RS256 的 token 原样改用 HS256 重签 ——
//   因为 HS256 的「密钥」就是那段公钥文本，谁都能拿到。
//   这是 alg=none / alg 混淆类漏洞的经典形态，必须显式 allowlist。
var CI_ASYMMETRIC_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'];

function generateToken(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

// 用指定密钥校验；失败返回 null
// opts.algorithms：非对称验签时必须传，否则见上面的 alg 混淆说明
function verifyWith(token, secret, opts) {
  if (!secret) return null;
  try {
    return jwt.verify(token, secret, opts);
  } catch (e) {
    return null;
  }
}

// 依次尝试 Cluss 密钥、ClassIntra 公钥、ClassIntra 共享密钥；
// 返回 { data, source }
//
// source 会被 middleware/auth.js 用来判断「这个 token 是谁签的」，
// 从而决定要不要同步 ClassIntra 的管理身份 —— 错判会让伪造 token
// 获得提权能力，所以这里的返回值必须与实际验证路径严格对应。
function verifyToken(token) {
  if (!token) return { valid: false, data: null, source: '' };

  var decoded = verifyWith(token, config.jwt.secret);
  if (decoded) return { valid: true, data: decoded, source: 'cluss' };

  // ClassIntra 公钥（RS256 等非对称）—— 优先于共享密钥
  if (config.ci.jwtPublicKey) {
    var pubDecoded = verifyWith(token, config.ci.jwtPublicKey, {
      algorithms: CI_ASYMMETRIC_ALGS
    });
    if (pubDecoded) return { valid: true, data: pubDecoded, source: 'classintra' };
  }

  // 共享密钥兜底：CI 切换签名方式期间联登不会中断
  //
  // ⚠️ 这里必须留日志，原因有两个：
  //   1. 公钥配错时验签会**静默**落到这一支（公钥解析失败也在这被吞掉），
  //      联登照常工作、无一条报错，运维会一直以为自己已经切到非对称了。
  //   2. 它是「过渡期能否收尾」的另一半判据：ClassIntra 侧同样会打
  //      「命中 HS256 兜底」的日志，两边对照就能看出旧 token 是否已清空。
  if (config.ci.jwtSecret) {
    var ciDecoded = verifyWith(token, config.ci.jwtSecret);
    if (ciDecoded) {
      console.warn('[jwt] 命中 CI 共享密钥兜底（过渡期路径）user_id=%s',
        ciDecoded.user_id || '(未知)');
      return { valid: true, data: ciDecoded, source: 'classintra' };
    }
  }

  return { valid: false, data: null, source: '' };
}

module.exports = {
  generateToken: generateToken,
  verifyToken: verifyToken
};