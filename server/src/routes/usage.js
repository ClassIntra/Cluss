// 学生用量路由：只能看自己的消耗
//
// 安全约束：user_id 一律取 req.user.user_id，**忽略客户端传入的任何 user_id**。
// 这是学生端与管理端最重要的区别 —— 学生能看到明细，但只能看到自己的。

var express = require('express');
var router = express.Router();
var auth = require('../middleware/auth');
var stats = require('../services/usage-stats');
var credit = require('../services/credit');
var config = require('../config');

// ============================================================
// GET /api/usage/summary?days=7&group_by=day|model|source
// ============================================================
router.get('/summary', auth.requireAuth, function(req, res) {
  var win = stats.resolveWindow(req.query);
  var groupBy = String(req.query.group_by || 'day');

  // 学生端只允许这三种分组；user / instance 是管理端语义
  if (['day', 'model', 'source'].indexOf(groupBy) < 0) groupBy = 'day';

  var data = stats.summary({
    userId: req.user.user_id,
    from: win.from,
    to: win.to,
    days: win.days,
    groupBy: groupBy
  });

  // 附带额度概况，前端一个请求就能渲染整页
  var state = credit.getState(req.user.user_id);
  data.wallet = {
    allocated_yuan: config.microToYuan(state.allocated_micro).toFixed(2),
    used_yuan: config.microToYuan(state.used_micro).toFixed(2),
    available_yuan: config.microToYuan(state.available_micro).toFixed(2),
    used_percent: state.used_percent,
    is_allocated: state.is_allocated,
    weekly_unlimited: state.weekly_unlimited,
    weekly_quota_yuan: config.microToYuan(state.weekly_quota_micro).toFixed(2),
    weekly_used_yuan: config.microToYuan(state.weekly_used_micro).toFixed(2),
    weekly_percent: state.weekly_percent
  };

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
  res.send(stats.recordsToCsv(data.items));
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