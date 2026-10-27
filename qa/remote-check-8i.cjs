// 远端（8 班机器）核对：中枢改的额度有没有真的落到本地账本
const fs = require('fs');
const path = require('path');
var ROOT = 'D:/NetWork/Cluss';
var SERVER = path.join(ROOT, 'server');
fs.readFileSync(path.join(SERVER, '.env'), 'utf8').split(/\r?\n/).forEach(function (line) {
  var m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
});
process.env.DB_PATH = path.join(SERVER, 'database', 'cluss.db');
var db = require(path.join(SERVER, 'src', 'utils', 'db'));

var ids = ['250800', '250850', '250801', '250802'];
var rows = db.prepare(
  'SELECT user_id, allocated_micro FROM cluss_credit WHERE user_id IN (?,?,?,?)'
).all(ids[0], ids[1], ids[2], ids[3]);
console.log('== 8 班本地 cluss_credit ==');
rows.forEach(function (r) {
  console.log('  ' + r.user_id + ' = ¥' + (Number(r.allocated_micro || 0) / 1e6).toFixed(2));
});

var meta = db.prepare("SELECT key, value FROM cluss_meta WHERE key IN ('assign_version','quota_lock','model_sync')").all();
console.log('== 本地 meta ==');
meta.forEach(function (m) { console.log('  ' + m.key + ' = ' + m.value); });
