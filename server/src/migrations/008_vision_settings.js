// 迁移 008：视觉与云盘的默认配置
//
// 复用现有的 cluss_meta 键值表，不新建配置表 —— 这张表本来就是为「运行时可变配置」
// 准备的，再建一张只会让读取路径分叉。
//
// INSERT OR IGNORE 保证幂等：已存在的键不会被覆盖，
// 所以升级不会把管理员改过的配置重置回默认值。

function up(db) {
  var defaults = [
    // 视觉总开关。0 = 关闭看图（拍题/批改入口全部失效）
    ['vision_enabled', '1'],
    // 「转述模型」ID：当对话模型不支持视觉时，用它把图片转成文字。
    // 留空表示不做转述回退（此时只有支持视觉的模型能用拍题）
    ['vision_relay_model_id', ''],
    // 单次最多几张图（可被模型行的 vision_max_images 覆盖）
    ['vision_max_images', '4'],
    // 服务端缩图的长边上限。1568 是多数视觉模型的有效输入尺寸上限，
    // 再大也只是被上游丢弃，白白多传几 MB
    ['image_max_edge', '1568'],
    ['image_quality', '80'],
    // 缩图总开关（低端设备上可关掉以省 CPU）
    ['image_shrink_enabled', '1'],
    // 每用户云盘配额（字节），默认 200MB
    ['cloud_quota_bytes', '209715200']
  ];

  var stmt = db.prepare('INSERT OR IGNORE INTO cluss_meta (key, value) VALUES (?, ?)');
  for (var i = 0; i < defaults.length; i++) {
    stmt.run(defaults[i][0], defaults[i][1]);
  }
}

module.exports = { version: 8, name: 'vision_settings', up: up };