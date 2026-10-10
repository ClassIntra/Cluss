/**
 * JWT 验证策略验证（utils/jwt.js）
 *
 * 覆盖两件事：
 *  1. RS256 公钥验签可用（CI 切非对称签名后联登不断）
 *  2. **alg 混淆被挡住** —— 拿公钥当 HS256 密钥重签的 token 必须验不过。
 *     这是加非对称验签时最容易漏的一环：不锁定 algorithms，
 *     公钥文本就成了任何人都能用的 HS256 密钥，防护等于没加。
 *
 * 跑法：node server/scripts/verify-jwt.js
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// —— 生成一对临时 RSA 密钥（不入库、不联网）——
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ ' + msg); failed++; }
}

// 先设好环境再 require：config 在加载时就固化了
process.env.JWT_SECRET = 'local-secret-for-jwt-verify';
process.env.CI_JWT_PUBLIC_KEY = publicKey.replace(/\n/g, '\\n'); // 模拟 .env 里的单行写法
delete process.env.CI_JWT_SECRET;

const jwtUtil = require('../src/utils/jwt');

console.log('\n[1] 基本验证');
const valid = jwtUtil.verifyToken(jwtUtil.generateToken({ user_id: 'u1' }));
ok(valid.valid === true, '自签 token 验签通过');
ok(valid.source === 'cluss', 'source 为 cluss，实际 ' + valid.source);

console.log('\n[2] RS256 公钥验签');
const ciToken = jwt.sign({ user_id: '251801', is_class_admin: true }, privateKey, {
  algorithm: 'RS256', expiresIn: '1h'
});
const r = jwtUtil.verifyToken(ciToken);
ok(r.valid === true, 'CI 的 RS256 token 验签通过');
ok(r.source === 'classintra', 'source 为 classintra，实际 ' + r.source);
ok(r.data && r.data.user_id === '251801', 'payload 正确解出');
ok(r.data && r.data.is_class_admin === true, 'is_class_admin 保留（班管标记可用）');

console.log('\n[3] alg 混淆防护（关键）');
// 攻击者拿**公钥文本**当 HS256 密钥，把 payload 重签成 HS256。
// 公钥是可以公开拿到的，所以这一步对攻击者零成本 ——
// 如果 verifyToken 照单全收，加公钥就等于没加防护。
const forged = jwt.sign({ user_id: '251801', is_admin: true }, publicKey, {
  algorithm: 'HS256', expiresIn: '1h'
});
const f = jwtUtil.verifyToken(forged);
ok(f.valid === false, 'HS256 公钥重签的伪造 token 被拒绝（alg 混淆被挡住）');

// alg=none：完全不签名
const noneTok = Buffer.from(JSON.stringify({
  alg: 'none', typ: 'JWT'
})).toString('base64') + '.' + Buffer.from(JSON.stringify({
  user_id: '251801', is_admin: true
})).toString('base64') + '.';
ok(jwtUtil.verifyToken(noneTok).valid === false, 'alg=none 的 token 被拒绝');

// 用**别的**私钥签的 RS256（CI 换密钥后旧 token 之外的伪造）
const other = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const otherTok = jwt.sign({ user_id: '251801', is_admin: true }, other.privateKey, {
  algorithm: 'RS256', expiresIn: '1h'
});
ok(jwtUtil.verifyToken(otherTok).valid === false, '非本公钥签发的 RS256 token 被拒绝');

console.log('\n[4] 共享密钥兜底（CI 分步切换期）');
// 场景：公钥已配，但 CI 还没切过来（仍在用 HS256 共享密钥签）。
// 这段时间联登不能断，所以两条路径都要通。
const cache = require('../src/config');
cache.ci.jwtSecret = 'legacy-shared-secret';
const legacy = jwt.sign({ user_id: '251802', is_class_admin: false }, 'legacy-shared-secret', {
  algorithm: 'HS256', expiresIn: '1h'
});
const lg = jwtUtil.verifyToken(legacy);
ok(lg.valid === true, '配了公钥后，旧的共享密钥 token 仍能验（切换期不断线）');
ok(lg.source === 'classintra', '兜底路径的 source 也是 classintra（管理身份同步不受影响）');
cache.ci.jwtSecret = '';

console.log('\n[5] 无效输入');
ok(jwtUtil.verifyToken('').valid === false, '空 token 被拒绝');
ok(jwtUtil.verifyToken(null).valid === false, 'null 被拒绝');
ok(jwtUtil.verifyToken('garbage').valid === false, '垃圾字符串被拒绝');
ok(jwtUtil.verifyToken('a.b.c').valid === false, '结构不对的 token 被拒绝');

const expired = jwt.sign({ user_id: 'u1' }, 'local-secret-for-jwt-verify', {
  expiresIn: '-1h'
});
ok(jwtUtil.verifyToken(expired).valid === false, '过期 token 被拒绝');

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);