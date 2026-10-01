// 学号分配：YYNNCC 格式
//   YY = 入学年份后两位（2025 → 25）
//   NN = 班级号
//   CC = 班内注册编号
// 例：2025 年入学、3 班、第 7 个注册 → 250307
//
// 为什么用这个格式：
//   1. 与 ClassIntra 的学号体系天然对应——联动部署时账号可直接照面，不需要映射表
//   2. 学号本身携带年份与班级，管理端按班级筛选、批量充值只需解析字符串
//
// 溢出处理：某班某届 99 个编号用尽时，回落到 800001+ 保留段，
// 仍保证唯一，只是学号不再携带班级信息（同时写入 enrollment_year / class_no 兜底）。

var db = require('../utils/db');

var RESERVED_BASE = 800000;   // 保留段起点
var RESERVED_MAX = 999998;

// 规范化入学年份：接受 2025 / 25 / '2025'，统一为四位字符串
function normalizeYear(raw) {
  var s = String(raw || '').trim();
  if (/^\d{4}$/.test(s)) return s;
  if (/^\d{2}$/.test(s)) {
    // 两位年份按 2000 年后解释（校园场景足够）
    return String(2000 + parseInt(s, 10));
  }
  return '';
}

// 规范化班级号：接受 1 / '01' / '1班'，统一为两位字符串
function normalizeClass(raw) {
  var s = String(raw || '').trim().replace(/[班\s]/g, '');
  if (!/^\d{1,2}$/.test(s)) return '';
  var n = parseInt(s, 10);
  if (n < 1 || n > 99) return '';
  return n < 10 ? '0' + n : String(n);
}

function validateProfile(enrollmentYearRaw, classNoRaw) {
  var year = normalizeYear(enrollmentYearRaw);
  if (!year) {
    return { ok: false, message: '请填写正确的入学年份（如 2025）' };
  }
  var yearNum = parseInt(year, 10);
  if (yearNum < 2000 || yearNum > 2100) {
    return { ok: false, message: '入学年份需在 2000 ~ 2100 之间' };
  }
  var classNo = normalizeClass(classNoRaw);
  if (!classNo) {
    return { ok: false, message: '请填写正确的班级（1 ~ 99）' };
  }
  return { ok: true, year: year, classNo: classNo, yy: year.slice(2) };
}

// 在 YYNN 前缀下找一个未被占用的 CC（班内注册编号）
function allocateClassUserId(yy, nn) {
  var prefix = yy + nn;
  var rows = db.prepare(
    'SELECT user_id FROM users WHERE user_id LIKE ? AND length(user_id) = 6'
  ).all(prefix + '__');

  var used = {};
  for (var i = 0; i < rows.length; i++) {
    var cc = rows[i].user_id.slice(4);
    if (/^\d{2}$/.test(cc)) used[cc] = true;
  }

  for (var n = 1; n <= 99; n++) {
    var cc = n < 10 ? '0' + n : String(n);
    if (!used[cc]) return prefix + cc;
  }
  return null;
}

// 保留段自增分配（班内编号溢出时的兜底）
function allocateReservedUserId() {
  var row = db.prepare(
    'SELECT MAX(CAST(user_id AS INTEGER)) AS max_id FROM users WHERE CAST(user_id AS INTEGER) > ? AND CAST(user_id AS INTEGER) <= ?'
  ).get(RESERVED_BASE, RESERVED_MAX);
  var next = (row && row.max_id ? row.max_id : RESERVED_BASE) + 1;
  if (next > RESERVED_MAX) return null;
  return String(next);
}

// 统一入口：优先分配 YYNNCC，溢出则回落保留段
// 返回 { user_id, overflow } 或 null（彻底耗尽）
function allocateUserId(enrollmentYear, classNo) {
  var v = validateProfile(enrollmentYear, classNo);
  if (!v.ok) return null;

  var classId = allocateClassUserId(v.yy, v.classNo);
  if (classId) return { user_id: classId, overflow: false };

  var reserved = allocateReservedUserId();
  if (!reserved) return null;
  return { user_id: reserved, overflow: true };
}

module.exports = {
  normalizeYear: normalizeYear,
  normalizeClass: normalizeClass,
  validateProfile: validateProfile,
  allocateUserId: allocateUserId,
  allocateReservedUserId: allocateReservedUserId
};