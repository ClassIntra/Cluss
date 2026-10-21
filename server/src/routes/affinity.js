// 好感度路由
//
// 只读 + 一个「标记探索过某功能」的写入。
// 加分全部由服务端规则触发（对话回合、记忆写入），
// 前端**不能**直接加分 —— 否则规则就成了摆设。

var express = require('express');
var router = express.Router();
var auth = require('../middleware/auth');
var affinity = require('../services/affinity');

// ============================================================
// GET /api/affinity —— 我的默契度
// ============================================================
router.get('/', auth.requireAuth, function(req, res) {
  try {
    var st = affinity.getState(req.user.user_id);
    res.json({
      code: 200,
      message: 'ok',
      data: {
        points: st.points,
        level: st.level,
        title: st.title,
        levelPoints: st.levelPoints,
        nextPoints: st.nextPoints,
        nextTitle: st.nextTitle,
        progress: st.progress,
        streakDays: st.streakDays,
        explored: st.explored,
        dailyCap: st.dailyCap
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: '获取默契度失败' });
  }
});

// ============================================================
// POST /api/affinity/explore —— 我到过一个新功能（幂等）
// body: { feature }
// ============================================================
router.post('/explore', auth.requireAuth, function(req, res) {
  var f = String((req.body || {}).feature || '');
  try {
    var r = affinity.featureExplored(req.user.user_id, f);
    res.json({ code: 200, message: 'ok', data: r });
  } catch (e) {
    // 探索加分失败不影响页面使用：静默成功
    res.json({ code: 200, message: 'ok', data: { explored: false, points: 0 } });
  }
});

module.exports = router;
