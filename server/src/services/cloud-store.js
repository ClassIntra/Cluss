// 云盘存储层：内容寻址 + 用户归属引用
//
// 存储模型（参考 ClassIntra 已验证的做法）：
//   物理文件按内容 hash 存放：<resourcesDir>/cloud/shared/<hash前2位>/<hash><ext>
//   两张表：cloud_files（物理文件，全局唯一）+ cloud_user_files（谁拥有这个文件）
//
// 为什么内容寻址：同一张题图被多个学生上传时只存一份，天然去重；
// 文件名不含任何用户输入（杜绝路径穿越），也不需要处理重名。
//
// ⚠️ 本项目 foreign_keys=ON，与 ClassIntra 不同：
//    - 插 cloud_user_files 前 cloud_files 行必须已存在
//    - 删除顺序必须是「先删引用 → 再软删文件」
//    - 永不 DELETE FROM cloud_files（保留物理文件，避免别的引用失效）

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var db = require('../utils/db');
var time = require('../utils/time');
var config = require('../config');

// ---- 类型白名单 ----
// 只接收图片与纯文本：这个云盘是为「拍题 + 传资料」服务的，不做通用网盘
var IMAGE_MIMES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/heic': '.heic'
};

var TEXT_MIMES = {
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json'
};

// 明确拒绝的扩展名（即使 mime 伪装也要拦）
// .html/.svg/.js 在浏览器里能执行脚本，同源下打开会变成 XSS 通道
var BLOCKED_EXT = ['.html', '.htm', '.svg', '.js', '.mjs', '.xhtml'];

var MAX_FILE_BYTES = 10 * 1024 * 1024;   // 单文件 10MB
var DEFAULT_QUOTA_BYTES = 200 * 1024 * 1024;  // 每用户 200MB

function cloudRoot() {
  return path.join(config.resourcesDir, 'cloud');
}

function sharedRoot() {
  return path.join(cloudRoot(), 'shared');
}

function thumbRoot() {
  return path.join(cloudRoot(), 'thumbs');
}

function ensureDirs() {
  var dirs = [cloudRoot(), sharedRoot(), thumbRoot()];
  for (var i = 0; i < dirs.length; i++) {
    if (!fs.existsSync(dirs[i])) fs.mkdirSync(dirs[i], { recursive: true });
  }
}

// ---- 类型判定 ----
function isImageMime(mime) {
  return !!IMAGE_MIMES[String(mime || '').toLowerCase()];
}

function isTextMime(mime) {
  return !!TEXT_MIMES[String(mime || '').toLowerCase()];
}

function isAllowedMime(mime) {
  var m = String(mime || '').toLowerCase();
  return isImageMime(m) || isTextMime(m);
}

function extForMime(mime) {
  var m = String(mime || '').toLowerCase();
  return IMAGE_MIMES[m] || TEXT_MIMES[m] || '.bin';
}

function kindForMime(mime) {
  if (isImageMime(mime)) return 'image';
  if (isTextMime(mime)) return 'text';
  return 'other';
}

// 依据文件头魔数判断真实类型
// 为什么不能只信浏览器给的 mime：客户端可以随便伪造 Content-Type，
// 而我们要靠它决定「是否交给 AI 看图」「用什么 Content-Type 返回」。
// 返回 null 表示认不出来（此时拒绝，不做兜底猜测）
function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  var b = buffer;

  // JPEG: FF D8 FF
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  // GIF: 47 49 46 38
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  // BMP: 42 4D
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  // WEBP: RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  // HEIC/HEIF: ....ftypheic / ftypmif1
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    var brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (brand === 'heic' || brand === 'heix' || brand === 'heif' || brand === 'mif1') return 'image/heic';
  }

  // 文本类：没有可靠魔数，靠「是否全是可打印字符」判断（含中文等 UTF-8 多字节）
  if (isProbablyText(b)) return 'text/plain';

  return null;
}

// 粗略文本判定：允许 UTF-8 多字节、常见控制字符（换行/制表），不允许 NUL
function isProbablyText(buffer) {
  var sample = buffer.slice(0, Math.min(buffer.length, 4096));
  if (sample.indexOf(0x00) !== -1) return false;

  var suspicious = 0;
  for (var i = 0; i < sample.length; i++) {
    var c = sample[i];
    // 允许：可见 ASCII、\n \r \t，以及 UTF-8 高位字节（中文等）
    var ok = (c >= 0x20 && c <= 0x7E) || c === 0x0A || c === 0x0D || c === 0x09 || c >= 0x80;
    if (!ok) suspicious++;
  }
  return suspicious / sample.length < 0.05;
}

// ---- hash ----
function computeHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// 存储相对路径：ab/ab12...ef.png
function storagePathFor(hash, ext) {
  return hash.slice(0, 2) + '/' + hash + (ext || '');
}

function absolutePathFor(storagePath) {
  return path.join(sharedRoot(), storagePath);
}

// ---- 配额 ----
function getQuotaBytes() {
  try {
    var row = db.prepare('SELECT value FROM cluss_meta WHERE key = ?').get('cloud_quota_bytes');
    var n = row ? parseInt(row.value, 10) : NaN;
    return isFinite(n) && n > 0 ? n : DEFAULT_QUOTA_BYTES;
  } catch (e) {
    return DEFAULT_QUOTA_BYTES;
  }
}

function getUserUsedBytes(userId) {
  var row = db.prepare([
    'SELECT IFNULL(SUM(f.size), 0) AS used',
    'FROM cloud_user_files r JOIN cloud_files f ON f.hash = r.file_hash',
    'WHERE r.user_id = ? AND f.deleted = 0'
  ].join('\n')).get(String(userId));
  return (row && row.used) || 0;
}

function getQuotaInfo(userId) {
  var quota = getQuotaBytes();
  var used = getUserUsedBytes(userId);
  return {
    quota_bytes: quota,
    used_bytes: used,
    remaining_bytes: Math.max(0, quota - used),
    quota_mb: Math.round(quota / 1024 / 1024),
    used_mb: Math.round(used / 1024 / 1024 * 10) / 10,
    percent: quota > 0 ? Math.min(100, Math.round(used / quota * 100)) : 0
  };
}

// ---- 写入 ----
// 返回 { ok:true, file:{...} } 或 { ok:false, message }
function saveFile(userId, opts) {
  var o = opts || {};
  var uid = String(userId);
  var originalName = String(o.name || 'file').slice(0, 200);
  var buffer = o.buffer;
  var declaredMime = String(o.mime || '').toLowerCase();

  if (!buffer || !buffer.length) return { ok: false, message: '文件内容为空' };
  if (buffer.length > MAX_FILE_BYTES) {
    return { ok: false, message: '单个文件最大 ' + Math.round(MAX_FILE_BYTES / 1024 / 1024) + 'MB' };
  }

  // 扩展名黑名单：即使 mime 声称是图片也要拦
  var lowerName = originalName.toLowerCase();
  for (var i = 0; i < BLOCKED_EXT.length; i++) {
    if (lowerName.endsWith(BLOCKED_EXT[i])) {
      return { ok: false, message: '不支持该文件类型（' + BLOCKED_EXT[i] + '）' };
    }
  }

  // 以魔数为准，浏览器给的 mime 只作参考
  var sniffed = sniffMime(buffer);

  // 声明与实际不符时拒绝：
  // 客户端说这是图片、魔数却说是文本，几乎只有两种情况——
  // 用户搞错了文件（后续拍题必然失败），或者有人想把脚本伪装成图片混进来。
  // 两者都不该放行。注意：声明 text 而实际是图片是常见误操作，
  // 但那种情况我们按魔数当图片收下更符合直觉，所以只拦「声明图片 → 实际非图片」这个方向。
  if (isImageMime(declaredMime) && sniffed && !isImageMime(sniffed)) {
    return { ok: false, message: '文件内容与图片格式不符（实际是文本文件），请重新选择' };
  }

  var mime = sniffed || (isAllowedMime(declaredMime) ? declaredMime : null);
  if (!mime || !isAllowedMime(mime)) {
    return { ok: false, message: '只支持图片（jpg/png/webp/gif）与文本文件（txt/md/json/csv）' };
  }

  // 配额检查（去重命中时不占新增空间，所以先算 hash 再看是否已存在）
  var hash = computeHash(buffer);
  var existing = db.prepare('SELECT * FROM cloud_files WHERE hash = ?').get(hash);
  var alreadyOwned = db.prepare(
    'SELECT id FROM cloud_user_files WHERE user_id = ? AND file_hash = ?'
  ).get(uid, hash);

  if (existing && alreadyOwned) {
    return {
      ok: true,
      duplicated: true,
      file: {
        hash: hash, name: originalName, size: existing.size,
        mime: existing.mime_type, kind: existing.kind || kindForMime(existing.mime_type),
        width: existing.width || 0, height: existing.height || 0
      }
    };
  }

  if (!existing) {
    var quota = getQuotaInfo(uid);
    if (quota.used_bytes + buffer.length > quota.quota_bytes) {
      return {
        ok: false,
        message: '云盘空间不足（已用 ' + quota.used_mb + 'MB / 共 ' + quota.quota_mb + 'MB），请先删掉一些文件',
        quota_exceeded: true
      };
    }
  }

  var ext = extForMime(mime);
  var storagePath = storagePathFor(hash, ext);
  var absPath = absolutePathFor(storagePath);

  try {
    ensureDirs();
    if (!existing || !fs.existsSync(absPath)) {
      var dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, buffer);
    }
  } catch (err) {
    console.error('[Cloud] 写文件失败:', err.message);
    return { ok: false, message: '文件保存失败，请重试' };
  }

  var kind = kindForMime(mime);
  var now = time.nowUtc();

  try {
    var tx = db.transaction(function() {
      if (!existing) {
        db.prepare([
          'INSERT INTO cloud_files (hash, owner_user_id, original_name, size, mime_type,',
          '  storage_path, width, height, kind, deleted, created_at)',
          'VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?)'
        ].join('\n')).run(hash, uid, originalName, buffer.length, mime, storagePath, kind, now);
      }
      // 重新上传同一内容（用户可能删过一次）：cloud_files 行若已被软删，
      // 必须复活（deleted=0），否则 getUserFile / resolveAbsolutePath 会因
      // deleted=1 判「文件不存在」，前端 <img> 拿到的是一句 404 JSON。
      // 这是真实踩到过的坑：学生删除某题图、稍后重传同一张，图就再也打不开了。
      if (existing && existing.deleted) {
        db.prepare('UPDATE cloud_files SET deleted = 0 WHERE hash = ?').run(hash);
      }
      // UNIQUE(user_id, file_hash) 保证同一用户对同一文件只有一条引用
      db.prepare([
        'INSERT OR IGNORE INTO cloud_user_files (user_id, file_hash, display_name, uploaded_at)',
        'VALUES (?, ?, ?, ?)'
      ].join('\n')).run(uid, hash, originalName, now);
    });
    tx();
  } catch (err) {
    console.error('[Cloud] 写数据库失败:', err.message);
    return { ok: false, message: '文件记录保存失败，请重试' };
  }

  return {
    ok: true,
    file: {
      hash: hash, name: originalName, size: buffer.length,
      mime: mime, kind: kind, width: 0, height: 0
    }
  };
}

// ---- 读取 ----
// 校验归属：必须是该用户云盘里的文件，防止用别人的 hash 越权读取
function getUserFile(hash, userId) {
  if (!hash || !/^[a-f0-9]{64}$/.test(String(hash))) return null;
  var row = db.prepare([
    'SELECT f.hash, f.size, f.mime_type, f.storage_path, f.kind, f.width, f.height,',
    '       f.deleted, r.display_name',
    'FROM cloud_files f',
    'JOIN cloud_user_files r ON r.file_hash = f.hash',
    'WHERE f.hash = ? AND r.user_id = ?'
  ].join('\n')).get(String(hash), String(userId));

  if (!row || row.deleted) return null;
  return {
    hash: row.hash,
    name: row.display_name || row.hash,
    size: row.size,
    mime: row.mime_type,
    kind: row.kind || kindForMime(row.mime_type),
    width: row.width || 0,
    height: row.height || 0,
    storagePath: row.storage_path
  };
}

// 读取文件内容（带大小上限，防止把超大文件读进内存）
function readUserFile(hash, userId, maxBytes) {
  var info = getUserFile(hash, userId);
  if (!info) return { error: '文件不存在或无权访问' };

  var limit = Number(maxBytes || MAX_FILE_BYTES);
  if (info.size > limit) {
    return { error: '文件过大（' + Math.round(info.size / 1024 / 1024) + 'MB），上限 ' + Math.round(limit / 1024 / 1024) + 'MB' };
  }

  var absPath = absolutePathFor(info.storagePath);
  try {
    if (!fs.existsSync(absPath)) {
      return { error: '文件已丢失，请重新上传' };
    }
    var buffer = fs.readFileSync(absPath);
    return {
      buffer: buffer,
      mime: info.mime,
      name: info.name,
      size: info.size,
      hash: info.hash,
      kind: info.kind,
      width: info.width,
      height: info.height
    };
  } catch (err) {
    console.error('[Cloud] 读文件失败:', err.message);
    return { error: '文件读取失败' };
  }
}

// 按 hash 直接读文件内容，不做用户引用校验。
// 唯一调用方是云笔记的「公开笔记」分支：visibility='public' 意味着
// 作者主动把这篇笔记共享给全班，此时正文（作者名下的云盘文件）需要
// 跨用户可读。调用方必须先自行确认该 hash 确实属于一篇公开笔记。
function readFileByHash(hash, maxBytes) {
  if (!hash || !/^[a-f0-9]{64}$/.test(String(hash))) return { error: '文件不存在或无权访问' };
  var row = db.prepare('SELECT hash, size, mime_type, storage_path, kind FROM cloud_files WHERE hash = ?').get(String(hash));
  if (!row || row.deleted) return { error: '文件不存在或无权访问' };

  var limit = Number(maxBytes || MAX_FILE_BYTES);
  if (row.size > limit) {
    return { error: '文件过大（' + Math.round(row.size / 1024 / 1024) + 'MB），上限 ' + Math.round(limit / 1024 / 1024) + 'MB' };
  }
  var absPath = absolutePathFor(row.storage_path);
  try {
    if (!fs.existsSync(absPath)) {
      return { error: '文件已丢失，请重新上传' };
    }
    return {
      buffer: fs.readFileSync(absPath),
      mime: row.mime_type,
      name: row.hash,
      size: row.size,
      hash: row.hash,
      kind: row.kind || kindForMime(row.mime_type),
      width: 0,
      height: 0
    };
  } catch (err) {
    console.error('[Cloud] 按hash读文件失败:', err.message);
    return { error: '文件读取失败' };
  }
}
// 取绝对路径（供静态流式下发用，避免整文件读进内存）
function resolveAbsolutePath(hash, userId) {
  var info = getUserFile(hash, userId);
  if (!info) return { error: '文件不存在或无权访问' };
  var absPath = absolutePathFor(info.storagePath);
  if (!fs.existsSync(absPath)) return { error: '文件已丢失' };
  return { path: absPath, info: info };
}

// ---- 列表 ----
function listFiles(userId, opts) {
  var o = opts || {};
  var sql = [
    'SELECT f.hash, f.size, f.mime_type, f.kind, f.width, f.height, f.created_at,',
    '       r.display_name, r.uploaded_at',
    'FROM cloud_user_files r JOIN cloud_files f ON f.hash = r.file_hash',
    'WHERE r.user_id = ? AND f.deleted = 0'
  ].join('\n');
  var params = [String(userId)];

  if (o.kind) {
    sql += ' AND f.kind = ?';
    params.push(String(o.kind));
  }
  sql += ' ORDER BY r.uploaded_at DESC LIMIT ?';
  params.push(Math.min(Number(o.limit || 200), 500));

  var stmt = db.prepare(sql);
  var rows = stmt.all.apply(stmt, params);

  return rows.map(function(r) {
    return {
      hash: r.hash,
      name: r.display_name || r.hash,
      size: r.size,
      mime: r.mime_type,
      kind: r.kind || kindForMime(r.mime_type),
      width: r.width || 0,
      height: r.height || 0,
      is_image: isImageMime(r.mime_type) ? 1 : 0,
      uploaded_at: time.toISO(r.uploaded_at || r.created_at)
    };
  });
}

// ---- 删除 ----
// 顺序严格：先删用户引用，引用归零才软删文件（物理文件保留，避免影响他人引用）
function deleteFile(hash, userId) {
  var info = getUserFile(hash, userId);
  if (!info) return { ok: false, message: '文件不存在或无权访问' };

  var tx = db.transaction(function() {
    db.prepare('DELETE FROM cloud_user_files WHERE user_id = ? AND file_hash = ?')
      .run(String(userId), String(hash));

    var refs = db.prepare('SELECT COUNT(*) AS c FROM cloud_user_files WHERE file_hash = ?').get(String(hash));
    if (!refs || refs.c === 0) {
      db.prepare('UPDATE cloud_files SET deleted = 1 WHERE hash = ?').run(String(hash));
    }
  });
  tx();

  return { ok: true };
}

module.exports = {
  MAX_FILE_BYTES: MAX_FILE_BYTES,
  cloudRoot: cloudRoot,
  sharedRoot: sharedRoot,
  thumbRoot: thumbRoot,
  ensureDirs: ensureDirs,
  isImageMime: isImageMime,
  isTextMime: isTextMime,
  isAllowedMime: isAllowedMime,
  kindForMime: kindForMime,
  extForMime: extForMime,
  sniffMime: sniffMime,
  computeHash: computeHash,
  saveFile: saveFile,
  getUserFile: getUserFile,
  readUserFile: readUserFile,
  readFileByHash: readFileByHash,
  resolveAbsolutePath: resolveAbsolutePath,
  listFiles: listFiles,
  deleteFile: deleteFile,
  getQuotaInfo: getQuotaInfo,
  getQuotaBytes: getQuotaBytes
};