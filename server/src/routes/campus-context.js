// 校园情境路由：学生查看 / 管理"AI 知道的、来自校园的信息"
//
// 这个路由存在的意义不是传数据，而是**把控制权交还给学生**。
// 详见 services/campus-context.js 顶部的说明。
//
// 权限：全部限本人。user_id 一律取 req.user.user_id，忽略客户端传入的任何值。

var express = require('express');
var router = express.Router();
var auth = require('../middleware/auth');
var campus = require('../services/campus-context');
var ciBridge = require('../services/ci-bridge');

// ============================================================
// GET /api/campus-context —— 查看
//
// 独立性：CI 未联动 → 返回 { linked: false }，前端整块不渲染。
//
// ---- 为什么在 GET 里"顺手"触发一次后台刷新 ----
// 缓存为空时（首次进入 / 服务重启后），只回读缓存会让学生在设置里
// 看到一片空白，而且**没有任何途径自己补救** —— 缓存要等下一次对话
// 才会被 turn-runner 填上。实测就是这个结果：available=false、0 项。
// 所以这里在"缓存没有"时发射后不管地触发一次刷新：
//   · 不 await —— 页面永远不等 CI（CI 挂了也照常秒回）；
//   · refreshStudentProfile 自带软 TTL 与并发去重，不会重复打；
//   · 前端拿到 available=false 时会自己再问一次，那时通常已经取到了。
// 缓存已有时一个字节都不多发。
// ============================================================
router.get('/', auth.requireAuth, function(req, res) {
  if (ciBridge.isEnabled() && !ciBridge.getCachedStudentProfile(req.user.user_id)) {
    ciBridge.refreshStudentProfile(req.user.user_id); // 发射后不管
  }
  res.json({ code: 200, message: 'ok', data: campus.build(req.user.user_id) });
});

// ============================================================
// PUT /api/campus-context/enabled —— 总开关
// body: { enabled: Boolean }
// ============================================================
router.put('/enabled', auth.requireAuth, function(req, res) {
  var on = req.body && (req.body.enabled === true || req.body.enabled === 'true' || req.body.enabled === 1);
  var opt = campus.setEnabled(req.user.user_id, on);
  res.json({
    code: 200,
    message: on ? '已开启，AI 会参考你的校园信息' : '已关闭，AI 不再使用你的校园信息',
    data: { enabled: opt.enabled, disabled: opt.disabled }
  });
});

// ============================================================
// PUT /api/campus-context/items/:key —— 逐项开关
// body: { on: Boolean }
// ============================================================
router.put('/items/:key', auth.requireAuth, function(req, res) {
  var key = String(req.params.key || '');
  var on = req.body && (req.body.on === true || req.body.on === 'true' || req.body.on === 1);
  var opt = campus.setItem(req.user.user_id, key, on);

  if (!opt) {
    return res.status(400).json({ code: 400, message: '没有这一项' });
  }

  var def = campus.ITEM_DEFS.filter(function(d) { return d.key === key; })[0];
  res.json({
    code: 200,
    message: on ? ('已让 AI 参考「' + (def ? def.label : key) + '」')
                : ('已不让 AI 参考「' + (def ? def.label : key) + '」'),
    data: { enabled: opt.enabled, disabled: opt.disabled }
  });
});

// ============================================================
// POST /api/campus-context/refresh —— 立刻去 CI 取一次最新素材
//
// 平时不需要它（对话一轮就会自动刷新）。但学生刚在设置里打开开关、
// 想马上看到内容时，等"下一次对话"太久了 —— 这条就是给他一个即时反馈。
//
// 刻意做成「失败也不报错」：CI 暂时连不上是学生控制不了的事，
// 让它弹出红色错误只会制造无力感。取不到就还是显示"暂时没取到"。
// ============================================================
router.post('/refresh', auth.requireAuth, function(req, res) {
  if (!ciBridge.isEnabled()) {
    return res.json({ code: 200, message: 'ok', data: campus.build(req.user.user_id) });
  }

  return ciBridge.refreshStudentProfile(req.user.user_id).then(function() {
    res.json({ code: 200, message: 'ok', data: campus.build(req.user.user_id) });
  }).catch(function() {
    // refreshStudentProfile 本身不抛，这里只是兜底
    res.json({ code: 200, message: 'ok', data: campus.build(req.user.user_id) });
  });
});

module.exports = router;
