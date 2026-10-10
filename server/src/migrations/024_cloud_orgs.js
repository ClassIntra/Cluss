// 迁移 024：学校（组织）与多租户隔离 —— Cluss Cloud 公共服务的底座
//
// 定位（与设计文档 §4 一致，但刻意精简）：Cloud 不是一套独立管理台，
// 是**公共服务**——任何部署 Cluss 的人在网页上注册学校，拿到
// 「学校编号 + 管理员编号 + 接入密钥」，填到部署设备的 .env 里，
// 节点即接入；学校管理员在同一个公共服务网页上看自己班的用量与额度。
//
// 隔离红线（设计文档 §7.1）：A 校节点拿不到 B 校的任何数据。
//   - cluss_orgs.secret_hash：每校一把接入密钥（存 sha256，库里有界泄露也不
//     等于密钥泄露）；节点同步请求带 X-Cluss-Org + 密钥，替代全网单一
//     CLUSS_SHARED_SECRET。**自托管单校 relay 不受影响**：不带 X-Cluss-Org
//     的请求仍走全局共享密钥（向后兼容），此时 org 视为 ''（本机）。
//   - cluss_credit.org_id / cluss_usage_log.org_id：账目按校打标；
//   - cluss_nodes.org_id：节点归属学校；
//   - users.org_id + is_org_admin：学校管理员也是 users 行，但权限半径
//     限定在自己学校（requireOrgAdmin，见 routes/cloud.js）。
//
// 密钥与账目故意**不加密org_id**：学号/用量本来就是计量数据（§6.1 数据边界），
// 内容数据（对话、文件）从不进中继。
//
// 幂等：CREATE TABLE IF NOT EXISTS + ADD COLUMN 前查 PRAGMA（与 014 同款）。

function up(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS cluss_orgs (',
    // 学校编号：8 位以上 base32 随机，不可枚举（防「id + 弱凭证」遍历爆破）
    '  id TEXT PRIMARY KEY,',
    '  name TEXT NOT NULL,',
    // 省市，可选，仅做统计
    "  region TEXT NOT NULL DEFAULT '',",
    // active | disabled（停用后该校节点同步一律 403）
    "  status TEXT NOT NULL DEFAULT 'active',",
    // 接入密钥的 sha256（节点配置的 CLUSS_SHARED_SECRET）
    "  secret_hash TEXT NOT NULL DEFAULT '',",
    "  created_by TEXT NOT NULL DEFAULT '',",
    '  created_at TEXT NOT NULL DEFAULT \'\'',
    ')'
  ].join('\n'));

  var usersCols = {};
  var uc = db.prepare('PRAGMA table_info(users)').all();
  for (var i = 0; i < uc.length; i++) usersCols[uc[i].name] = true;
  if (!usersCols.org_id) {
    db.exec("ALTER TABLE users ADD COLUMN org_id TEXT NOT NULL DEFAULT ''");
  }
  if (!usersCols.is_org_admin) {
    db.exec('ALTER TABLE users ADD COLUMN is_org_admin INTEGER NOT NULL DEFAULT 0');
  }

  var creditCols = {};
  var cc = db.prepare('PRAGMA table_info(cluss_credit)').all();
  for (var j = 0; j < cc.length; j++) creditCols[cc[j].name] = true;
  if (!creditCols.org_id) {
    db.exec("ALTER TABLE cluss_credit ADD COLUMN org_id TEXT NOT NULL DEFAULT ''");
  }

  var usageCols = {};
  var gc = db.prepare('PRAGMA table_info(cluss_usage_log)').all();
  for (var k = 0; k < gc.length; k++) usageCols[gc[k].name] = true;
  if (!usageCols.org_id) {
    db.exec("ALTER TABLE cluss_usage_log ADD COLUMN org_id TEXT NOT NULL DEFAULT ''");
  }

  var nodeCols = {};
  var nc = db.prepare('PRAGMA table_info(cluss_nodes)').all();
  for (var m = 0; m < nc.length; m++) nodeCols[nc[m].name] = true;
  if (!nodeCols.org_id) {
    db.exec("ALTER TABLE cluss_nodes ADD COLUMN org_id TEXT NOT NULL DEFAULT ''");
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_org ON cluss_usage_log(org_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_credit_org ON cluss_credit(org_id)');
}

module.exports = { version: 24, name: 'cloud_orgs', up: up };
