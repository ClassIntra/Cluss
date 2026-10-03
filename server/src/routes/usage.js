// 学生用量路由：只能看自己的消耗
//
// 安全约束：user_id 一律取 req.user.user_id，**忽略客户端传入的任何 user_id**。
// 这是学生端与管理端最重要的区别 —— 学生能看到明细，但只能看到自己的。

var express = require('express');
var router = express.Router();
var auth = require('../middleware/auth');
var stats = require('../services/usage-stats');
var credit = require('../services/credit');

// ============================================================
// GET /api/usage/summary?days=7&group_by=day|source
// ============================================================
router.get('/summary', auth.requireAuth, function(req, res) {
  var win = stats.resolveWindow(req.query);
  var groupBy = String(req.query.group_by || 'day');

  // 学生端只允许这两种分组。
  // user / instance 是管理端语义自不必说；「按模型」对学生也没有任何决策价值 ——
  // 他不能选模型价格、也分不清 deepseek-chat 和别的有什么区别，
  // 摆出这一栏只是让人觉得自己在看运维面板。
  if (['day', 'source'].indexOf(groupBy) < 0) groupBy = 'day';

  var data = stats.summary({
    userId: req.user.user_id,
    from: win.from,
    to: win.to,
    days: win.days,
    groupBy: groupBy
  });

  // 学生视图：服务端裁剪 + 积分换算（见 usage-stats 的 student* 系列说明）
  data.totals = stats.studentTotals(data.totals);
  data.items = data.items.map(stats.studentGroupRow);
  data.wallet = credit.toPointsView(credit.getState(req.user.user_id));

  res.json({ code: 200, message: 'ok', data: data });
});

// ============================================================
// GET /api/usage/records?days=7&model_id=&source=&page=1&limit=50
// ============================================================
router.get('/records', auth.requireAuth, function(req, res) {
  var win = stats.resolveWindow(req.query);

  var data = stats.records({
    userId: req.user.user_id,   // 强制本人，忽略客户端传参
    from: win.from,
    to: win.to,
    modelId: String(req.query.model_id || ''),
    source: String(req.query.source || ''),
    page: req.query.page,
    limit: req.query.limit
  });

  data.window = { from: win.from, to: win.to, days: win.days };
  data.items = data.items.map(stats.studentRecordRow);
  res.json({ code: 200, message: 'ok', data: data });
});

// ============================================================
// GET /api/usage/export.csv
// ============================================================
router.get('/export.csv', auth.requireAuth, function(req, res) {
  var win = stats.resolveWindow(req.query);

  var data = stats.records({
    userId: req.user.user_id,
    from: win.from,
    to: win.to,
    modelId: String(req.query.model_id || ''),
    source: String(req.query.source || ''),
    page: 1,
    limit: 200
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cluss-usage.csv"');
  // 学生导出的表也用积分，与页面口径一致（管理台导出走 admin 路由，那边是元）。
  // 必须先过 studentRecordRow：CSV 里要的是 title / source_label / cost_points，
  // 原始行只有 conversation_title 与 cost_micro —— 直接传会导出一张"内容和积分都空着"的表。
  res.send(stats.recordsToCsv(data.items.map(stats.studentRecordRow), { unit: 'points' }));
});

// ============================================================
// GET /api/usage/sources —— 来源选项（前端筛选下拉用）
// ============================================================
router.get('/sources', auth.requireAuth, function(req, res) {
  var labels = stats.SOURCE_LABELS;
  var list = [];
  var keys = Object.keys(labels);
  for (var i = 0; i < keys.length; i++) {
    list.push({ id: keys[i], label: labels[keys[i]] });
  }
  res.json({ code: 200, message: 'ok', data: { sources: list } });
});

module.exports = router;