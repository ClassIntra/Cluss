// 错题本路由
//
// 权限约束：全部操作限本人。
// user_id 一律取 req.user.user_id，**忽略客户端传入的任何 user_id**；
// 批量操作也逐条带 user_id 条件（见 wrong-book.batch 的注释）。

var express = require('express');
var router = express.Router();
var auth = require('../middleware/auth');
var wrongBook = require('../services/wrong-book');

// ============================================================
// GET /api/wrong-book —— 列表（含筛选与统计）
// ============================================================
router.get('/', auth.requireAuth, function(req, res) {
  var data = wrongBook.list({
    userId: req.user.user_id,
    mastered: String(req.query.mastered || ''),
    subject: String(req.query.subject || ''),
    page: req.query.page,
    limit: req.query.limit
  });
  res.json({ code: 200, message: 'ok', data: data });
});

// ============================================================
// GET /api/wrong-book/subjects —— 学科列表（筛选下拉）
// 注意：必须注册在 /:id 之前，否则 "subjects" 会被当成 id
// ============================================================
router.get('/subjects', auth.requireAuth, function(req, res) {
  res.json({
    code: 200,
    message: 'ok',
    data: { subjects: wrongBook.subjects(req.user.user_id) }
  });
});

// ============================================================
// GET /api/wrong-book/export.csv
// ============================================================
router.get('/export.csv', auth.requireAuth, function(req, res) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cluss-wrong-book.csv"');
  res.send(wrongBook.exportCsv(req.user.user_id));
});

// ============================================================
// POST /api/wrong-book —— 手动新增
// ============================================================
router.post('/', auth.requireAuth, function(req, res) {
  var result = wrongBook.create(req.user.user_id, req.body);
  if (!result.ok) return res.status(400).json({ code: 400, message: result.message });
  res.json({ code: 200, message: '已加入错题本', data: { item: result.item } });
});

// ============================================================
// POST /api/wrong-book/batch —— 批量标记 / 删除
// body: { ids: [], action: 'master' | 'unmaster' | 'delete' }
// 放在 /:id 之前注册，避免路由冲突
// ============================================================
router.post('/batch', auth.requireAuth, function(req, res) {
  var action = String(req.body.action || '');
  if (['master', 'unmaster', 'delete'].indexOf(action) < 0) {
    return res.status(400).json({ code: 400, message: '不支持的操作' });
  }

  var result = wrongBook.batch(req.user.user_id, req.body.ids, action);
  if (!result.ok) return res.status(400).json({ code: 400, message: result.message });

  var msg = action === 'delete' ? ('已删除 ' + result.affected + ' 条')
    : ('已更新 ' + result.affected + ' 条');
  res.json({ code: 200, message: msg, data: { affected: result.affected } });
});

// ============================================================
// GET /api/wrong-book/:id
// ============================================================
router.get('/:id', auth.requireAuth, function(req, res) {
  var item = wrongBook.getOne(req.params.id, req.user.user_id);
  if (!item) return res.status(404).json({ code: 404, message: '错题不存在' });
  res.json({ code: 200, message: 'ok', data: { item: item } });
});

// ============================================================
// PUT /api/wrong-book/:id —— 编辑（含标记已掌握）
// ============================================================
router.put('/:id', auth.requireAuth, function(req, res) {
  var result = wrongBook.update(req.params.id, req.user.user_id, req.body);
  if (!result.ok) {
    var status = result.notFound ? 404 : 400;
    return res.status(status).json({ code: status, message: result.message });
  }
  res.json({ code: 200, message: '已保存', data: { item: result.item } });
});

// ============================================================
// DELETE /api/wrong-book/:id
// ============================================================
router.delete('/:id', auth.requireAuth, function(req, res) {
  if (!wrongBook.remove(req.params.id, req.user.user_id)) {
    return res.status(404).json({ code: 404, message: '错题不存在' });
  }
  res.json({ code: 200, message: '已删除', data: null });
});

module.exports = router;