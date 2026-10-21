// 记忆路由：列表 / 写入（增量更新）/ 检索 / 删除
//
// 为什么把记忆直接暴露给学生：
//   记忆是用来影响模型输出的，而"模型觉得我是什么样的人"这件事不该是个黑盒。
//   学生能看到、能改、能删，才谈得上"偏好"——否则就是系统在替他贴标签。
//   这与画像的取舍一致（user-profile 刻意只做统计不做评价）。

var express = require('express');
var router = express.Router();
var auth = require('../middleware/auth');
var memory = require('../services/memory');
var memoryExtractor = require('../services/memory-extractor');

// ============================================================
// GET /api/memories —— 全部记忆
// ============================================================
router.get('/', auth.requireAuth, function(req, res) {
  try {
    var items = memory.listMemories(req.user.user_id, { limit: req.query.limit });
    // nextExtractIn：距下次后台整理还差几轮。
    // 学生看得到节奏，才不会觉得"这东西是不是根本没在工作"。
    var left = 0;
    try { left = memoryExtractor.nextExtractIn(req.user.user_id); } catch (e) { /* 不影响列表 */ }
    res.json({ code: 200, message: 'ok', data: { items: items, nextExtractIn: left } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '获取记忆失败' });
  }
});

// ============================================================
// GET /api/memories/search?q=关键词 —— 检索
// ============================================================
router.get('/search', auth.requireAuth, function(req, res) {
  var q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ code: 400, message: '请输入搜索关键词' });

  try {
    var items = memory.searchMemories(req.user.user_id, q, { limit: req.query.limit });
    res.json({ code: 200, message: 'ok', data: { items: items, query: q } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '检索失败' });
  }
});

// ============================================================
// POST /api/memories —— 写入（同 key 覆盖 = 增量更新）
// body: { key, content, source?, tags? }
// ============================================================
router.post('/', auth.requireAuth, function(req, res) {
  var b = req.body || {};
  var result = memory.upsert(req.user.user_id, {
    key: b.key,
    content: b.content,
    source: b.source,
    tags: b.tags
  });

  if (!result.ok) {
    return res.status(400).json({ code: 400, message: result.message });
  }

  res.json({
    code: 200,
    message: result.updated ? '已更新这条记忆' : '已记住',
    data: { id: result.id, key: result.key, updated: !!result.updated }
  });
});

// ============================================================
// DELETE /api/memories/:key
// ============================================================
router.delete('/:key', auth.requireAuth, function(req, res) {
  var result = memory.remove(req.user.user_id, req.params.key);
  if (!result.ok) return res.status(404).json({ code: 404, message: '没有这条记忆' });
  res.json({ code: 200, message: '已忘记', data: null });
});

module.exports = router;
