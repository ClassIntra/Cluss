// 隐藏密码路由：状态 / 设置 / 修改 / 校验解锁 / 上锁
//
// 这个密码同时锁着两样东西：
//   ① 隐藏的会话（hidden = 1，列表默认不带出）
//   ② 笔记的私密笔记（Notes.vue 的 privateFiles）
// 一份密码管两处 —— 学生只需要记一个。

var express = require('express');
var router = express.Router();
var auth = require('../middleware/auth');
var lock = require('../services/private-lock');

// GET /api/private/status —— 有没有设过密码、现在是否解锁中
router.get('/status', auth.requireAuth, function(req, res) {
  try {
    res.json({ code: 200, message: 'ok', data: lock.status(req.user.user_id) });
  } catch (e) {
    res.json({ code: 200, message: 'ok', data: { hasPassword: false, unlocked: false } });
  }
});

// POST /api/private/setup —— 首次设置（已有密码会被拒，要走 change）
// body: { password }
router.post('/setup', auth.requireAuth, function(req, res) {
  try {
    var st = lock.status(req.user.user_id);
    if (st.hasPassword) {
      return res.status(400).json({ code: 400, message: '已经设过密码，修改请走"修改密码"' });
    }
    var r = lock.setup(req.user.user_id, (req.body || {}).password);
    if (!r.ok) return res.status(400).json({ code: 400, message: r.message });
    res.json({ code: 200, message: r.message, data: lock.status(req.user.user_id) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '设置失败' });
  }
});

// POST /api/private/change —— 修改密码
// body: { oldPassword, newPassword }
router.post('/change', auth.requireAuth, function(req, res) {
  try {
    var b = req.body || {};
    var r = lock.change(req.user.user_id, b.oldPassword, b.newPassword);
    if (!r.ok) return res.status(400).json({ code: 400, message: r.message });
    res.json({ code: 200, message: r.message, data: lock.status(req.user.user_id) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '修改失败' });
  }
});

// POST /api/private/verify —— 解锁（成功即开锁 30 分钟，滑动续期）
// body: { password }
router.post('/verify', auth.requireAuth, function(req, res) {
  try {
    var r = lock.verify(req.user.user_id, (req.body || {}).password);
    var code = r.ok ? 200 : 400;
    res.status(code).json({ code: code, message: r.message, data: { ok: r.ok, unlocked: lock.isUnlocked(req.user.user_id) } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '校验失败' });
  }
});

// POST /api/private/lock —— 立即上锁
router.post('/lock', auth.requireAuth, function(req, res) {
  try {
    res.json({ code: 200, message: lock.lock(req.user.user_id).message, data: { unlocked: false } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '操作失败' });
  }
});

// POST /api/private/remove —— 移除密码（还有隐藏会话时拒绝）
router.post('/remove', auth.requireAuth, function(req, res) {
  try {
    var r = lock.remove(req.user.user_id);
    if (!r.ok) return res.status(400).json({ code: 400, message: r.message });
    res.json({ code: 200, message: r.message });
  } catch (e) {
    res.status(500).json({ code: 500, message: '操作失败' });
  }
});

module.exports = router;
