var dbMod;
var timeMod;

function db() {
  dbMod = dbMod || require('../utils/db');
  return dbMod;
}

function nowUtc() {
  timeMod = timeMod || require('../utils/time');
  return timeMod.nowUtc();
}

// 连续失败到这个数才熔断
var FAIL_LIMIT = 3;

// 只有「连接中断」与「一直不出字」这两类才允许自动熔断。
// 401 / 402 / 429 不在此列：那是配置或配额问题，需要管理员处理，
// 自动熔断会把真实原因藏起来。
function isFusableError(code) {
  var c = String(code || '').toUpperCase();
  return c === 'AI_STALLED' || c === 'UPSTREAM_TIMEOUT' ||
    c === 'ETIMEDOUT' || c === 'ECONNRESET' || c === 'ECONNABORTED';
}

function blankRow(id) {
  return {
    model_id: id,
    fail_count: 0,
    health_status: 'unknown',
    health_detail: '',
    checked_at: null
  };
}

function getHealthRow(id) {
  try {
    return db().prepare('SELECT * FROM ai_model_health WHERE model_id = ?').get(id) || blankRow(id);
  } catch (e) {
    return blankRow(id);
  }
}

function putHealthRow(id, patch) {
  var prev = getHealthRow(id);
  var next = {
    model_id: id,
    fail_count: prev.fail_count,
    health_status: prev.health_status,
    health_detail: prev.health_detail,
    checked_at: prev.checked_at
  };
  Object.keys(patch).forEach(function(k) {
    if (patch[k] !== undefined) next[k] = patch[k];
  });
  db().prepare([
    'INSERT INTO ai_model_health (model_id, fail_count, health_status, health_detail, checked_at)',
    'VALUES (?, ?, ?, ?, ?)',
    'ON CONFLICT(model_id) DO UPDATE SET',
    '  fail_count = excluded.fail_count,',
    '  health_status = excluded.health_status,',
    '  health_detail = excluded.health_detail,',
    '  checked_at = excluded.checked_at'
  ].join('\n')).run(
    id, next.fail_count, next.health_status, next.health_detail, next.checked_at
  );
  return next;
}

function recordSuccess(id) {
  var row = getHealthRow(id);
  if (row.fail_count === 0 && row.health_status !== 'down') {
    putHealthRow(id, { health_status: 'healthy', checked_at: nowUtc() });
    return;
  }
  putHealthRow(id, {
    fail_count: 0,
    health_status: 'healthy',
    health_detail: '曾连续失败 ' + row.fail_count + ' 次，已恢复',
    checked_at: nowUtc()
  });
}

function recordFailure(id, code) {
  var row = getHealthRow(id);
  var cnt = row.fail_count + 1;
  var detail = '连续失败 ' + cnt + ' 次（' + String(code || '未知') + '）';
  var status = cnt >= FAIL_LIMIT ? 'down' : 'degraded';
  putHealthRow(id, { fail_count: cnt, health_status: status, health_detail: detail, checked_at: nowUtc() });
  console.warn('[ModelHealth] %s → %s（%s）', id, status, detail);
  return status;
}

module.exports = {
  getHealthRow: getHealthRow,
  putHealthRow: putHealthRow,
  recordSuccess: recordSuccess,
  recordFailure: recordFailure,
  isFusableError: isFusableError,
  FAIL_LIMIT: FAIL_LIMIT,
  blankRow: blankRow
};
