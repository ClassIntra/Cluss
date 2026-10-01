// 迁移 001：Cluss 初始表结构
//
// 设计说明（决定了后续所有功能能否成立）：
//
// 1. users —— 账号表，列名与 ClassIntra 保持一致（net_name / real_name / user_id /
//    password_hash / status / is_admin ...）。保持一致是为了联动部署时能直接落库
//    ClassIntra 桥返回的用户记录，不需要字段映射。
//
// 2. cluss_credit —— 权威额度分配（「老师给这个账号分配了多少」）。
//    注意它**不是余额**：真实可用余额 = allocated_micro - 本地扣减 + 同步容错。
//    之所以不存「余额」字段：余额能由分配与消耗推导出来，存它必然漂移。
//
// 3. cluss_credit_log —— 额度变动流水，只增不改。
//    idem_key 唯一约束是跨实例重复下发的兜底（同一笔充值重放不会重复入账）。
//
// 4. cluss_usage_log —— 用量明细。synced=0 表示还没上报给中继，
//    节点断网期间照常记账，恢复后批量补报。
//
// 5. ai_models —— 模型注册表。价格单位「微元/千 token」（与 ClassIntra 口径一致）：
//    1 元/百万 token = 1000 微元/千 token。全整数运算不丢精度。
//
// 幂等性说明：全部 IF NOT EXISTS。

function up(db) {
  // ---- 账号表 ----
  db.exec([
    'CREATE TABLE IF NOT EXISTS users (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL UNIQUE,',
    '  net_name TEXT NOT NULL UNIQUE,',
    '  real_name TEXT NOT NULL UNIQUE,',
    '  gender TEXT DEFAULT \'\',',
    '  password_hash TEXT NOT NULL,',
    '  status TEXT DEFAULT \'active\',',
    '  is_admin INTEGER DEFAULT 0,',
    '  info_json TEXT DEFAULT \'{}\',',
    '  created_at TEXT DEFAULT (datetime(\'now\')),',
    '  last_login TEXT DEFAULT NULL,',
    // 账号来源：local（Cluss 开放注册）| classintra（联动时从 CI 桥引入）
    '  source TEXT DEFAULT \'local\',',
    '  class_no TEXT DEFAULT \'\'',
    ')'
  ].join('\n'));

  // ---- 额度分配（权威账本，由 relay 下发到各节点）----
  db.exec([
    'CREATE TABLE IF NOT EXISTS cluss_credit (',
    '  user_id TEXT PRIMARY KEY,',
    // 分配的总额度（微元）。0 = 未分配（不可用），不是「不限额」
    '  allocated_micro INTEGER NOT NULL DEFAULT 0,',
    // 周限额（微元）。0 = 不限
    '  weekly_quota_micro INTEGER NOT NULL DEFAULT 0,',
    '  updated_at TEXT DEFAULT (datetime(\'now\')),',
    '  assigned_by TEXT DEFAULT \'\'',
    ')'
  ].join('\n'));

  // ---- 额度流水（充值 / 调整，只增不改）----
  db.exec([
    'CREATE TABLE IF NOT EXISTS cluss_credit_log (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL,',
    // 正数 = 增加额度，负数 = 扣减额度
    '  amount_micro INTEGER NOT NULL,',
    // topup（充值）| adjust（管理员调整）| revoke（撤销/退款）
    '  kind TEXT NOT NULL,',
    '  reason TEXT DEFAULT \'\',',
    '  operator_id TEXT DEFAULT \'\',',
    // 变动发生在哪个实例（relay / class-01 ...）
    '  origin_instance TEXT DEFAULT \'\',',
    // 幂等键：同一笔变动跨实例重复下发只入账一次
    '  idem_key TEXT DEFAULT NULL,',
    '  created_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_log_idem ON cluss_credit_log(idem_key) WHERE idem_key IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_credit_log_user ON cluss_credit_log(user_id, created_at DESC)');

  // ---- 用量明细 ----
  db.exec([
    'CREATE TABLE IF NOT EXISTS cluss_usage_log (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  user_id TEXT NOT NULL,',
    '  conversation_id TEXT DEFAULT \'\',',
    '  model_id TEXT DEFAULT \'\',',
    '  prompt_tokens INTEGER DEFAULT 0,',
    '  completion_tokens INTEGER DEFAULT 0,',
    '  cache_hit_tokens INTEGER DEFAULT 0,',
    '  cache_miss_tokens INTEGER DEFAULT 0,',
    '  total_tokens INTEGER DEFAULT 0,',
    '  cost_micro INTEGER DEFAULT 0,',
    // 1 = 上游未回 usage，按字符数估算
    '  estimated INTEGER DEFAULT 0,',
    '  origin_instance TEXT DEFAULT \'\',',
    // 0 = 尚未上报给中继
    '  synced INTEGER DEFAULT 0,',
    '  created_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_user ON cluss_usage_log(user_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_synced ON cluss_usage_log(synced, id)');

  // ---- 模型注册表 ----
  db.exec([
    'CREATE TABLE IF NOT EXISTS ai_models (',
    '  id TEXT PRIMARY KEY,',
    '  label TEXT NOT NULL,',
    '  api_url TEXT DEFAULT \'\',',
    '  api_key TEXT DEFAULT \'\',',
    '  model_name TEXT DEFAULT \'\',',
    // openai | deepseek
    '  api_style TEXT DEFAULT \'openai\',',
    '  supports_thinking INTEGER DEFAULT 0,',
    '  supports_stream INTEGER DEFAULT 1,',
    // 微元/千 token
    '  price_in INTEGER DEFAULT 0,',
    '  price_out INTEGER DEFAULT 0,',
    '  price_cache_hit INTEGER DEFAULT 0,',
    // 1 = 免费模型（不计费，也不受余额闸门限制）
    '  is_free INTEGER DEFAULT 0,',
    '  enabled INTEGER DEFAULT 1,',
    '  is_default INTEGER DEFAULT 0,',
    '  sort_order INTEGER DEFAULT 0,',
    '  created_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  // ---- 会话与消息 ----
  db.exec([
    'CREATE TABLE IF NOT EXISTS ai_conversations (',
    '  id TEXT PRIMARY KEY,',
    '  user_id TEXT NOT NULL,',
    '  title TEXT DEFAULT \'新对话\',',
    '  model_id TEXT DEFAULT \'\',',
    '  created_at TEXT DEFAULT (datetime(\'now\')),',
    '  updated_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  db.exec('CREATE INDEX IF NOT EXISTS idx_conv_user ON ai_conversations(user_id, updated_at DESC)');

  db.exec([
    'CREATE TABLE IF NOT EXISTS ai_messages (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  conversation_id TEXT NOT NULL,',
    // user | assistant | system
    '  role TEXT NOT NULL,',
    '  content TEXT NOT NULL DEFAULT \'\',',
    '  model_id TEXT DEFAULT \'\',',
    '  created_at TEXT DEFAULT (datetime(\'now\'))',
    ')'
  ].join('\n'));

  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_conv ON ai_messages(conversation_id, id)');

  // ---- 实例元信息与同步水位 ----
  db.exec([
    'CREATE TABLE IF NOT EXISTS cluss_meta (',
    '  key TEXT PRIMARY KEY,',
    '  value TEXT DEFAULT \'\'',
    ')'
  ].join('\n'));
}

module.exports = { version: 1, name: 'init_schema', up: up };