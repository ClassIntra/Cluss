// JWT 工具：签发与校验
//
// 双密钥校验（重要）：
//   token 先用 Cluss 自己的密钥验；失败后再尝试 ClassIntra 的密钥（若已配置）。
//   这样在联动部署下，用户在 ClassIntra 登录后跳转过来也能直接通过，
//   而不需要先改配置或重新登录。

var jwt = require('jsonwebtoken');
var config = require('../config');

function generateToken(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

// 用指定密钥校验；失败返回 null
function verifyWith(token, secret) {
  if (!secret) return null;
  try {
    return jwt.verify(token, secret);
  } catch (e) {
    return null;
  }
}

// 依次尝试 Cluss 密钥、ClassIntra 密钥；返回 { data, source }
function verifyToken(token) {
  if (!token) return { valid: false, data: null, source: '' };

  var decoded = verifyWith(token, config.jwt.secret);
  if (decoded) return { valid: true, data: decoded, source: 'cluss' };

  if (config.ci.jwtSecret) {
    var ciDecoded = verifyWith(token, config.ci.jwtSecret);
    if (ciDecoded) return { valid: true, data: ciDecoded, source: 'classintra' };
  }

  return { valid: false, data: null, source: '' };
}

module.exports = {
  generateToken: generateToken,
  verifyToken: verifyToken
};