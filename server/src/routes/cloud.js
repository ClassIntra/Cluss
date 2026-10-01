// 云盘路由：上传、列表、读取、删除
//
// 只服务两个目的：给拍题/批改提供图片来源，以及让对话能附带文本资料。
// 不做通用网盘，因此刻意不做文件夹、分享、跨节点同步（每实例独立）。

var express = require('express');
var router = express.Router();
var fs = require('fs');
var path = require('path');
var auth = require('../middleware/auth');
var cloudStore = require('../services/cloud-store');
var rateLimit = require('../middleware/rate-limit').createRateLimiter;

// multer 用于 multipart 解析
var multer = require('multer');

// 上传限流：防止脚本刷爆磁盘（每用户每分钟 30 次）
var uploadLimiter = rateLimit({ max: 30, windowMs: 60000, message: '上传过于频繁，请稍后再试' });

// 内存存储：文件先落内存再交给 cloud-store 决定物理落点
// 配合 limits 控制峰值内存占用（单文件 10MB）
var upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: cloudStore.MAX_FILE_BYTES,
    files: 1
  },
  // 文件名含中文时，不做这个设置会变成 Latin-1 乱码
  defParamCharset: 'utf8'
});

// 缩略图磁盘缓存目录
function thumbPathFor(hash, maxEdge) {
  return path.join(cloudStore.thumbRoot(), hash.slice(0, 2), hash + '_w' + maxEdge + '.jpg');
}

// 懒生成缩略图并写盘；sharp 不可用或失败时返回 null（调用方回退原图）
function ensureThumb(hash, absPath, maxEdge) {
  var sharp = null;
  try { sharp = require('sharp'); } catch (e) { return Promise.resolve(null); }

  var target = thumbPathFor(hash, maxEdge);
  if (fs.existsSync(target)) return Promise.resolve(target);

  return sharp(absPath, { limitInputPixels: 40 * 1000 * 1000, failOn: 'none' })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer()
    .then(function(buf) {
      var dir = path.dirname(target);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, buf);
      return target;
    })
    .catch(function(err) {
      console.warn('[Cloud] 缩略图生成失败:', err.message);
      return null;
    });
}

// ============================================================
// POST /api/cloud/upload
// ============================================================
router.post('/upload', auth.requireAuth, uploadLimiter, function(req, res) {
  upload.single('file')(req, res, function(err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          code: 413,
          message: '单个文件最大 ' + Math.round(cloudStore.MAX_FILE_BYTES / 1024 / 1024) + 'MB'
        });
      }
      console.error('[Cloud] 上传解析失败:', err.message);
      return res.status(400).json({ code: 400, message: '上传失败：' + err.message });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ code: 400, message: '没有收到文件' });
    }

    var result = cloudStore.saveFile(req.user.user_id, {
      name: req.file.originalname || 'file',
      mime: req.file.mimetype || '',
      buffer: req.file.buffer
    });

    if (!result.ok) {
      var status = result.quota_exceeded ? 413 : 400;
      return res.status(status).json({ code: status, message: result.message });
    }

    var f = result.file;
    console.log('[Cloud] 上传成功: %s (%s, %d bytes) by %s',
      f.hash.slice(0, 12), f.name, f.size, req.user.user_id);

    res.json({
      code: 200,
      message: result.duplicated ? '该文件已在云盘中' : '上传成功',
      data: {
        hash: f.hash,
        name: f.name,
        size: f.size,
        mime: f.mime,
        kind: f.kind,
        width: f.width,
        height: f.height,
        url: '/api/cloud/files/' + f.hash,
        thumb_url: f.kind === 'image' ? '/api/cloud/files/' + f.hash + '?thumb=1' : '',
        duplicated: !!result.duplicated
      }
    });
  });
});

// ============================================================
// GET /api/cloud/files —— 列表
// ============================================================
router.get('/files', auth.requireAuth, function(req, res) {
  var kind = String(req.query.kind || '').trim();
  if (kind && kind !== 'image' && kind !== 'text') kind = '';

  var files = cloudStore.listFiles(req.user.user_id, { kind: kind, limit: req.query.limit });
  // 补上访问 URL，前端不必自己拼
  for (var i = 0; i < files.length; i++) {
    files[i].url = '/api/cloud/files/' + files[i].hash;
    files[i].thumb_url = files[i].is_image ? '/api/cloud/files/' + files[i].hash + '?thumb=1' : '';
  }

  res.json({ code: 200, message: 'ok', data: { files: files } });
});

// ============================================================
// GET /api/cloud/quota —— 空间使用情况
// ============================================================
router.get('/quota', auth.requireAuth, function(req, res) {
  res.json({ code: 200, message: 'ok', data: cloudStore.getQuotaInfo(req.user.user_id) });
});

// ============================================================
// GET /api/cloud/files/:hash —— 读取文件
//   ?thumb=1     缩略图（图片专用，磁盘缓存）
//   ?w=800       指定宽度缩放
//   ?download=1  强制下载（文本文件默认就是下载）
// ============================================================
router.get('/files/:hash', auth.requireAuth, function(req, res) {
  // 支持 hash 或 hash.ext 两种写法
  var raw = String(req.params.hash || '').split('.')[0];
  var resolved = cloudStore.resolveAbsolutePath(raw, req.user.user_id);
  if (resolved.error) {
    return res.status(404).json({ code: 404, message: resolved.error });
  }

  var info = resolved.info;
  var forceDownload = String(req.query.download || '') === '1';
  // 文本文件一律走下载语义：直接 inline 渲染可能触发同源 XSS
  var disposition = (forceDownload || info.kind === 'text') ? 'attachment' : 'inline';

  // 文本文件直接把内容读完返回（体积已在配额内，且有 10MB 上限）
  if (info.kind === 'text') {
    return res.sendFile(resolved.path, {
      headers: {
        'Content-Type': info.mime + '; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + encodeURIComponent(info.name) + '"',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  var wantThumb = String(req.query.thumb || '') === '1';
  var customW = parseInt(req.query.w, 10);
  var maxEdge = wantThumb ? 320 : (isFinite(customW) && customW > 0 ? Math.min(customW, 2000) : 0);

  // 不需要缩放：直接流式下发原图
  if (!maxEdge) {
    res.setHeader('Content-Type', info.mime);
    if (disposition === 'attachment') {
      res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(info.name) + '"');
    }
    return res.sendFile(resolved.path);
  }

  // 需要缩放：走 sharp，结果按 (hash, 宽度) 缓存到磁盘
  ensureThumb(raw, resolved.path, maxEdge).then(function(thumbPath) {
    if (!thumbPath) {
      // 缩图不可用：回退原图，不让请求失败
      res.setHeader('Content-Type', info.mime);
      return res.sendFile(resolved.path);
    }
    res.setHeader('Content-Type', 'image/jpeg');
    if (disposition === 'attachment') {
      res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(info.name) + '"');
    }
    res.sendFile(thumbPath);
  }).catch(function() {
    res.setHeader('Content-Type', info.mime);
    res.sendFile(resolved.path);
  });
});

// ============================================================
// DELETE /api/cloud/files/:hash
// ============================================================
router.delete('/files/:hash', auth.requireAuth, function(req, res) {
  var hash = String(req.params.hash || '').split('.')[0];
  var result = cloudStore.deleteFile(hash, req.user.user_id);
  if (!result.ok) return res.status(404).json({ code: 404, message: result.message });

  console.log('[Cloud] 删除: %s by %s', hash.slice(0, 12), req.user.user_id);
  res.json({ code: 200, message: '已删除', data: null });
});

module.exports = router;