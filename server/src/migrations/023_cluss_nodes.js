// 迁移 023：班级节点注册表（多班管理的底座）
//
// 背景：多班部署后，中继需要回答三个此前无法回答的问题——
//   1. 「网上到底接了几个班？」—— 旧 /admin/nodes 只按 usage_log 的
//      origin_instance 聚合，从没用过 AI 的班级根本不会出现；
//   2. 「这个班还活着吗？」—— 没有心跳，失联只能靠猜；
//   3. 「这台教室电脑淘汰了，怎么踢出去？」—— 没有吊销，旧节点凭证永久有效。
//
// 表的定位：**运行时注册表**，不是账本。用量、额度照旧走各自的三表，
// 这里只存「节点是谁、最近什么动静、状态如何」。中继自己不进这张表
// （管理台单独标注本机）。
//
// 心跳的实现方式（刻意不建独立接口）：节点每次带凭证同步时，在请求头里
// 顺路报告自己的 instance_id 与已应用版本号，中继在鉴权中间件里更新
// last_seen_at。同步本来每 60s 一次，心跳零额外流量；老版本节点不发这些
// 头，中继照旧服务（字段留空即可），不做强制升级。
//
// 吊销语义：status='revoked' 的节点，所有同步接口一律 403 ——
// 教室电脑淘汰/被盗后，凭证即刻失效（node 本地数据不动，学生内容不出本机）。
//
// 幂等：CREATE TABLE IF NOT EXISTS。

function up(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS cluss_nodes (',
    '  instance_id TEXT PRIMARY KEY,',
    // 管理员备注名（如「高一3班」），仅展示用
    "  label TEXT NOT NULL DEFAULT '',",
    // active | revoked
    "  status TEXT NOT NULL DEFAULT 'active',",
    "  first_seen_at TEXT NOT NULL DEFAULT '',",
    // 心跳：任意一次凭证校验通过的同步请求（version 轮询 / 拉分配 / 上报）
    "  last_seen_at TEXT NOT NULL DEFAULT '',",
    // 最后一次用量上报时间（与 last_seen 分开：只轮询不上报 ≠ 正常在用）
    "  last_report_at TEXT NOT NULL DEFAULT '',",
    // 节点报告的「已应用版本号」，支撑看板的配置到达情况视图
    '  last_assign_version INTEGER NOT NULL DEFAULT 0,',
    '  last_model_version INTEGER NOT NULL DEFAULT 0,',
    // 节点软件版本（package.json version），排查「老版本节点行为不一致」用
    "  node_version TEXT NOT NULL DEFAULT '',",
    "  revoked_at TEXT NOT NULL DEFAULT ''",
    ')'
  ].join('\n'));

  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON cluss_nodes(last_seen_at DESC)');
}

module.exports = { version: 23, name: 'cluss_nodes', up: up };
