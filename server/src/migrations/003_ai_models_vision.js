// 迁移 003：模型视觉能力字段
//
// 背景：拍题解答与作业批改需要模型能看图。不同模型的视觉能力差异很大，
// 且「声称支持」的模型未必真的支持（发图会被上游 400），所以必须逐模型标记。
//
// vision_max_images = 0 表示跟随全局默认（cluss_meta 的 vision_max_images，默认 4）。
// 之所以允许逐模型覆盖：不同厂商对单次请求的图片数量限制不同（有的仅 1 张）。
//
// 幂等性说明：ADD COLUMN 前用 PRAGMA table_info 检查。

function up(db) {
  var cols = db.prepare('PRAGMA table_info(ai_models)').all();
  var names = {};
  for (var i = 0; i < cols.length; i++) names[cols[i].name] = true;

  if (!names.supports_vision) {
    db.exec('ALTER TABLE ai_models ADD COLUMN supports_vision INTEGER DEFAULT 0');
  }
  if (!names.vision_max_images) {
    db.exec('ALTER TABLE ai_models ADD COLUMN vision_max_images INTEGER DEFAULT 0');
  }
}

module.exports = { version: 3, name: 'ai_models_vision', up: up };