// 迁移 022：模型源（共享连接信息）+ 模型级峰谷
//
// 背景（两个被旧模型管理结构挡住的需求）：
//
// ① 一个模型源提供多个模型
//    现实中一个上游（如某个 OpenAI 兼容聚合端点）常常一次提供好几个模型：
//    地址与 Key 完全相同，只是 model_name 不同。旧结构把 api_url / api_key
//    直接放在 ai_models 上，于是每接一个模型就要把同一个地址同一个 Key
//    再抄一遍 —— 改一次上游域名要挨个改 N 行，漏改一行就是「这个模型莫名不可用」。
//    新增 ai_sources：地址 / 密钥 / 风格沉到源上，模型只记 source_id。
//    **源是可选**：不挂源的模型继续用自己的 api_url / api_key，存量零迁移、
//    行为不变（source_id 默认 ''，解析时回退到模型自身字段）。
//
// ② 不是所有模型都有峰谷计费
//    旧的峰谷是全局开关（cluss_meta.offpeak_enabled）：一开，**所有**非免费
//    模型都按峰谷打折。但上游的峰谷政策是逐模型不同的 —— 有的模型根本没有
//    谷时便宜这回事，给它打折等于凭空少收积分（按倍率锚定的账就漂了）。
//    新增三个模型级字段，让"参不参与峰谷、峰窗是什么、打几折"逐模型声明：
//      has_offpeak             0 = 不参与峰谷；1 = 参与
//      offpeak_peak_windows    该模型自己的峰时段 JSON（'' = 回退全局默认）
//      offpeak_discount_bp     该模型自己的谷时折扣万分比（0 = 回退全局默认）
//    全局那份配置**保留**，降级为「新模型的默认值 / 未声明时的兜底」。
//
// 兼容性回填（关键，不做会静默改动线上账单）：
//    迁移前若全局峰谷是开启的，那么所有模型此刻都在享受折扣。若只加列不管，
//    新列默认 has_offpeak = 0 → 迁移瞬间所有模型都失去峰谷折扣，账单静默变贵。
//    因此：全局开启时，把存量模型的 has_offpeak 一律置 1（峰窗/折扣留空 →
//    回退全局值），使迁移前后**逐模型账单完全一致**；之后管理员再逐模型收窄。
//
// 幂等：ADD COLUMN 前查 PRAGMA；建表/索引一律 IF NOT EXISTS；回填只在
//        「本次刚加上 has_offpeak 列」时执行一次（用列存在性当闸门）。

function up(db) {
  // ---- ① ai_sources ----
  db.exec([
    'CREATE TABLE IF NOT EXISTS ai_sources (',
    '  id TEXT PRIMARY KEY,',
    "  label TEXT NOT NULL DEFAULT '',",
    "  api_url TEXT NOT NULL DEFAULT '',",
    "  api_key TEXT NOT NULL DEFAULT '',",
    "  api_style TEXT NOT NULL DEFAULT 'openai',",
    '  enabled INTEGER NOT NULL DEFAULT 1,',
    '  sort_order INTEGER NOT NULL DEFAULT 0,',
    "  created_at TEXT NOT NULL DEFAULT ''",
    ')'
  ].join('\n'));

  // ---- ② ai_models 新列 ----
  var cols = db.prepare('PRAGMA table_info(ai_models)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  // 是否本次刚新增 has_offpeak（决定要不要执行一次性回填）
  var justAddedOffpeak = !names.has_offpeak;

  if (!names.source_id) {
    // '' = 不挂源，用模型自身的 api_url / api_key（存量模型即此状态）
    db.exec("ALTER TABLE ai_models ADD COLUMN source_id TEXT NOT NULL DEFAULT ''");
  }
  if (justAddedOffpeak) {
    db.exec('ALTER TABLE ai_models ADD COLUMN has_offpeak INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.offpeak_peak_windows) {
    db.exec("ALTER TABLE ai_models ADD COLUMN offpeak_peak_windows TEXT NOT NULL DEFAULT ''");
  }
  if (!names.offpeak_discount_bp) {
    db.exec('ALTER TABLE ai_models ADD COLUMN offpeak_discount_bp INTEGER NOT NULL DEFAULT 0');
  }

  // ---- ③ 一次性回填：保住迁移前的峰谷行为 ----
  if (justAddedOffpeak) {
    var enabled = '0';
    try {
      var row = db.prepare("SELECT value FROM cluss_meta WHERE key = 'offpeak_enabled'").get();
      enabled = row && row.value != null ? String(row.value) : '0';
    } catch (e) { enabled = '0'; }

    if (enabled === '1') {
      // 峰窗与折扣留空：解析时回退全局配置，账单与迁移前逐模型一致
      db.prepare('UPDATE ai_models SET has_offpeak = 1').run();
    }
  }
}

module.exports = { version: 22, name: 'model_sources_offpeak', up: up };
