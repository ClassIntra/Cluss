// 用量统计：聚合查询、明细、CSV 导出
//
// 学生端与管理员端共用同一套查询，只是过滤条件不同（学生强制限定本人）。
// 抽出来的另一个理由：口径必须一致 —— 若两边各写一份 SQL，
// 迟早会出现「学生页显示 3.2 元、管理台显示 3.5 元」这种对不上的情况。

var db = require('../utils/db');
var time = require('../utils/time');
var config = require('../config');

// 时间窗解析：默认最近 7 天。
// created_at 存的是 UTC，用「最近 N 天」滚动窗口可绕开本地时区与日期解析的歧义
function resolveWindow(query) {
  var q = query || {};
  var days = parseInt(q.days, 10);
  if (!isFinite(days) || days <= 0) days = 7;
  if (days > 365) days = 365;

  var from = q.from ? String(q.from) : time.utcBeforeDays(days);
  var to = q.to ? String(q.to) : time.fmtUtc(new Date(Date.now() + 1000));

  return { days: days, from: from, to: to };
}

// 聚合列。注意必须带 l. 前缀：下面会 JOIN 别的表，
// 而 ai_models 也有 created_at，不加前缀会报 ambiguous column name
var AGG_COLS = [
  'COUNT(*) AS calls',
  'SUM(l.prompt_tokens) AS prompt_tokens',
  'SUM(l.completion_tokens) AS completion_tokens',
  'SUM(l.cache_hit_tokens) AS cache_hit_tokens',
  'SUM(l.total_tokens) AS total_tokens',
  'SUM(l.cost_micro) AS cost_micro',
  'SUM(l.image_count) AS image_count',
  'SUM(l.estimated) AS estimated_calls',
  'MAX(l.created_at) AS last_at'
].join(', ');

// 归类：把一条聚合行转成对外的形状（金额一律换算成元）
function shapeRow(r, keyName) {
  var out = {
    key: r.key,
    calls: r.calls || 0,
    prompt_tokens: r.prompt_tokens || 0,
    completion_tokens: r.completion_tokens || 0,
    cache_hit_tokens: r.cache_hit_tokens || 0,
    total_tokens: r.total_tokens || 0,
    cost_micro: r.cost_micro || 0,
    cost_yuan: config.microToYuan(r.cost_micro || 0).toFixed(2),
    image_count: r.image_count || 0,
    estimated_calls: r.estimated_calls || 0,
    last_at: time.toISO(r.last_at)
  };
  if (keyName) out.label = r.label || r.key || '未知';
  return out;
}

// 聚合查询
// opts: { userId?, classNo?, from, to, groupBy: 'day'|'model'|'source'|'user'|'instance' }
function summary(opts) {
  var o = opts || {};
  var groupBy = String(o.groupBy || 'day');

  var where = ['l.created_at >= ?', 'l.created_at < ?'];
  var params = [o.from, o.to];

  if (o.userId) { where.push('l.user_id = ?'); params.push(String(o.userId)); }
  if (o.source) { where.push('l.source = ?'); params.push(String(o.source)); }

  var sql = '';
  var keyName = true;

  if (groupBy === 'model') {
    sql = 'SELECT l.model_id AS key, MAX(m.label) AS label, ' + AGG_COLS +
      ' FROM cluss_usage_log l LEFT JOIN ai_models m ON m.id = l.model_id' +
      ' WHERE ' + where.join(' AND ') +
      ' GROUP BY l.model_id ORDER BY cost_micro DESC, total_tokens DESC LIMIT 100';

  } else if (groupBy === 'source') {
    sql = 'SELECT l.source AS key, ' + AGG_COLS +
      ' FROM cluss_usage_log l WHERE ' + where.join(' AND ') +
      ' GROUP BY l.source ORDER BY cost_micro DESC LIMIT 50';

  } else if (groupBy === 'instance') {
    sql = 'SELECT l.origin_instance AS key, ' + AGG_COLS +
      ' FROM cluss_usage_log l WHERE ' + where.join(' AND ') +
      ' GROUP BY l.origin_instance ORDER BY cost_micro DESC LIMIT 50';

  } else if (groupBy === 'user') {
    sql = 'SELECT l.user_id AS key, MAX(u.real_name) AS label, MAX(u.net_name) AS net_name,' +
      ' MAX(u.class_no) AS class_no, ' + AGG_COLS +
      ' FROM cluss_usage_log l LEFT JOIN users u ON u.user_id = l.user_id' +
      ' WHERE ' + where.join(' AND ') +
      ' GROUP BY l.user_id ORDER BY cost_micro DESC LIMIT 500';

  } else {
    // day：按 UTC 日期分组。substr(created_at,1,10) 比 date() 更稳——
    // created_at 已经是 UTC 字符串，date() 在某些 sqlite 版本上会做本地化转换
    keyName = false;
    sql = 'SELECT substr(l.created_at, 1, 10) AS key, ' + AGG_COLS +
      ' FROM cluss_usage_log l WHERE ' + where.join(' AND ') +
      ' GROUP BY key ORDER BY key ASC LIMIT 400';
  }

  var stmt = db.prepare(sql);
  var rows = stmt.all.apply(stmt, params);

  // 班级过滤（user 分组时用，学生列表已 JOIN 出 class_no）
  if (o.classNo && groupBy === 'user') {
    rows = rows.filter(function(r) { return (r.class_no || '') === String(o.classNo); });
  }

  var list = [];
  var totals = {
    calls: 0, prompt_tokens: 0, completion_tokens: 0,
    total_tokens: 0, cost_micro: 0, image_count: 0
  };

  for (var i = 0; i < rows.length; i++) {
    var shaped = shapeRow(rows[i], keyName);
    if (groupBy === 'user') {
      shaped.net_name = rows[i].net_name || '';
      shaped.class_no = rows[i].class_no || '';
    }
    list.push(shaped);
    totals.calls += shaped.calls;
    totals.prompt_tokens += shaped.prompt_tokens;
    totals.completion_tokens += shaped.completion_tokens;
    totals.total_tokens += shaped.total_tokens;
    totals.cost_micro += shaped.cost_micro;
    totals.image_count += shaped.image_count;
  }

  return {
    group_by: groupBy,
    window: { from: o.from, to: o.to, days: o.days },
    totals: {
      calls: totals.calls,
      prompt_tokens: totals.prompt_tokens,
      completion_tokens: totals.completion_tokens,
      total_tokens: totals.total_tokens,
      cost_micro: totals.cost_micro,
      cost_yuan: config.microToYuan(totals.cost_micro).toFixed(2),
      image_count: totals.image_count
    },
    items: list
  };
}

// 明细查询（分页）
function records(opts) {
  var o = opts || {};
  var page = Math.max(1, parseInt(o.page, 10) || 1);
  var limit = Math.min(Math.max(1, parseInt(o.limit, 10) || 50), 200);
  var offset = (page - 1) * limit;

  var where = ['l.created_at >= ?', 'l.created_at < ?'];
  var params = [o.from, o.to];

  if (o.userId) { where.push('l.user_id = ?'); params.push(String(o.userId)); }
  if (o.modelId) { where.push('l.model_id = ?'); params.push(String(o.modelId)); }
  if (o.source) { where.push('l.source = ?'); params.push(String(o.source)); }
  if (o.conversationId) { where.push('l.conversation_id = ?'); params.push(String(o.conversationId)); }

  var whereSql = where.join(' AND ');

  var countStmt = db.prepare('SELECT COUNT(*) AS c FROM cluss_usage_log l WHERE ' + whereSql);
  var total = (countStmt.get.apply(countStmt, params) || {}).c || 0;

  var sql = [
    'SELECT l.id, l.user_id, l.conversation_id, l.model_id, l.source, l.trace_id,',
    '       l.prompt_tokens, l.completion_tokens, l.cache_hit_tokens, l.cache_miss_tokens,',
    '       l.total_tokens, l.cost_micro, l.estimated, l.image_count, l.origin_instance, l.created_at,',
    '       u.real_name, u.net_name, c.title AS conversation_title, m.label AS model_label',
    'FROM cluss_usage_log l',
    'LEFT JOIN users u ON u.user_id = l.user_id',
    'LEFT JOIN ai_conversations c ON c.id = l.conversation_id',
    'LEFT JOIN ai_models m ON m.id = l.model_id',
    'WHERE ' + whereSql,
    'ORDER BY l.id DESC LIMIT ? OFFSET ?'
  ].join('\n');

  var listParams = params.concat([limit, offset]);
  var stmt = db.prepare(sql);
  var rows = stmt.all.apply(stmt, listParams);

  return {
    page: page,
    limit: limit,
    total: total,
    total_pages: Math.ceil(total / limit),
    items: rows.map(function(r) {
      return {
        id: r.id,
        user_id: r.user_id,
        user_name: r.real_name || r.net_name || r.user_id,
        conversation_id: r.conversation_id,
        conversation_title: r.conversation_title || '',
        model_id: r.model_id,
        model_label: r.model_label || r.model_id,
        source: r.source || 'chat',
        trace_id: r.trace_id || '',
        prompt_tokens: r.prompt_tokens || 0,
        completion_tokens: r.completion_tokens || 0,
        cache_hit_tokens: r.cache_hit_tokens || 0,
        total_tokens: r.total_tokens || 0,
        cost_micro: r.cost_micro || 0,
        cost_yuan: config.microToYuan(r.cost_micro || 0).toFixed(4),
        estimated: r.estimated ? 1 : 0,
        image_count: r.image_count || 0,
        origin_instance: r.origin_instance || '',
        created_at: time.toISO(r.created_at)
      };
    })
  };
}

// 来源的中文名（CSV 与界面共用，避免两处各写一份映射）
var SOURCE_LABELS = {
  chat: '对话',
  study: '学习',
  solve: '拍题',
  grade: '批改',
  vision_relay: '图片识别'
};

function sourceLabel(s) {
  return SOURCE_LABELS[s] || s || '对话';
}

// 明细导出为 CSV（带 BOM，Excel 打开不乱码）
function recordsToCsv(items) {
  var lines = ['时间,用户,学号,类型,模型,输入Token,输出Token,缓存命中,总Token,图片数,费用(元),是否估算'];
  for (var i = 0; i < items.length; i++) {
    var r = items[i];
    lines.push([
      String(r.created_at || '').replace('T', ' ').slice(0, 19),
      String(r.user_name || '').replace(/,/g, '，'),
      r.user_id,
      sourceLabel(r.source),
      String(r.model_label || '').replace(/,/g, '，'),
      r.prompt_tokens,
      r.completion_tokens,
      r.cache_hit_tokens,
      r.total_tokens,
      r.image_count,
      r.cost_yuan,
      r.estimated ? '是' : '否'
    ].join(','));
  }
  return '\ufeff' + lines.join('\n');
}

module.exports = {
  resolveWindow: resolveWindow,
  summary: summary,
  records: records,
  recordsToCsv: recordsToCsv,
  sourceLabel: sourceLabel,
  SOURCE_LABELS: SOURCE_LABELS
};