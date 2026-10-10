// 迁移清单（显式索引）
//
// 为什么不用 fs.readdirSync 扫目录 + 动态 require：
//   1) 动态加载"目录里任何 .js"是一个可被利用的落地点 ——
//      只要有人往 migrations/ 放进一个文件，启动时就会被执行；
//   2) 目录扫描在打包/裁剪过的部署里不可靠（文件可能不在预期位置）；
//   3) 显式清单让"有哪些迁移、顺序如何"一眼可查，review 时不必去数文件名。
// 新增迁移时：在此追加一行 require，并保持 version 递增。
//
// 每个迁移模块导出 { version: Number, name: String, up(db) }，必须幂等。

module.exports = [
  require('./001_init_schema'),
  require('./002_register_profile'),
  require('./003_ai_models_vision'),
  require('./004_conversations_mode'),
  require('./005_messages_attachments'),
  require('./006_usage_source'),
  require('./007_cloud_files'),
  require('./008_vision_settings'),
  require('./009_wrong_questions'),
  require('./010_writing_pieces'),
  require('./011_conversations_persona'),
  require('./012_cloud_notes'),
  require('./013_memories'),
  require('./014_credit_pricing'),
  require('./016_model_health'),
  require('./017_wrong_book_review'),
  require('./018_note_folders_canvas'),
  require('./019_messages_streaming'),
  require('./020_drop_classintra_disabled_sync'),
  require('./021_daily_style_and_personas'),
  require('./022_model_sources_offpeak'),
  require('./023_cluss_nodes'),
  require('./024_cloud_orgs')
];