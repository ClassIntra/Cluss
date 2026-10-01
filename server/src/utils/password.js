// 密码工具：bcrypt 哈希与强度校验
//
// 强度策略与 ClassIntra 保持一致（≥8 位、含字母、含数字），
// 这样用户在两边的注册体验一致，也不会出现「CI 能设的密码 Cluss 不接受」。

var bcrypt = require('bcryptjs');

var SALT_ROUNDS = 10;

function hashPassword(password) {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  try {
    return bcrypt.compareSync(password, hash);
  } catch (e) {
    // 非法哈希（历史脏数据/同步异常）不能抛出去打断登录流程
    console.warn('[Password] 哈希比对异常:', e.message);
    return false;
  }
}

function checkPasswordStrength(password) {
  var pwd = String(password || '');
  if (pwd.length < 8) {
    return { valid: false, message: '密码长度至少8位' };
  }
  if (!/[a-zA-Z]/.test(pwd)) {
    return { valid: false, message: '密码必须包含字母' };
  }
  if (!/[0-9]/.test(pwd)) {
    return { valid: false, message: '密码必须包含数字' };
  }
  return { valid: true, message: '' };
}

module.exports = {
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  checkPasswordStrength: checkPasswordStrength
};