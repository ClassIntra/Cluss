// 重置演示数据：清空所有业务数据，保留管理员账号与模型配置
//
// 用途：把实例恢复到「刚部署完」的状态，便于验收或交付给他人使用。
// 用法：node scripts/reset-demo-data.js
//
// 注意：这是破坏性操作，执行前会打印将被删除的行数，需要手动确认环境。

require('dotenv').config();
var db = require('../src/utils/db');

var tables = [
  { name: 'cluss_usage_log', label: '用量明细' },
  { name: 'cluss_credit_log', label: '额度流水' },
  { name: 'cluss_credit', label: '额度分配' },
  { name: 'ai_messages', label: '对话消息' },
  { name: 'ai_conversations', label: '会话' }
];

console.log('将清空以下数据（保留管理员与模型配置）：');
tables.forEach(function(t) {
  var row = db.prepare('SELECT COUNT(*) AS c FROM ' + t.name).get();
  console.log('  - ' + t.label + ' (' + t.name + '): ' + row.c + ' 行');
});

var users = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 0').get();
console.log('  - 学生账号 (users): ' + users.c + ' 行');

var tx = db.transaction(function() {
  tables.forEach(function(t) {
    db.prepare('DELETE FROM ' + t.name).run();
  });
  db.prepare('DELETE FROM users WHERE is_admin = 0').run();
  // 分配版本归零，让班级节点下次同步时以空快照对齐
  db.prepare("UPDATE cluss_meta SET value = '0' WHERE key = 'assign_version'").run();
});
tx();

console.log('\n已重置。管理员账号与 AI 模型配置保留。');