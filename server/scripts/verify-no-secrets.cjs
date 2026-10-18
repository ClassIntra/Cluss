// 验证脚本：仓库里不能出现真实凭据
//
// 为什么要有这个检查：
//   这个仓里同时存在三类东西 —— 代码（要入库）、配置（含真实密钥，绝不能入库）、
//   以及随手粘贴的临时文件。第一类有 .gitignore 守着，但后两类有两个已知的坑：
//
//   1. 临时文件不进 .gitignore 就等于裸奔。真实事故：仓库根目录一个
//      「新建文本文档.txt」里抄着 server/.env 的校级接入密钥。它没被跟踪，
//      但也从未被忽略 —— 只要任何人执行 git add -A，它就进库了。
//   2. 日志会把 JWT 明文写盘。登录成功后 token 被打进 pm2 日志，任何拿到
//      日志文件（备份、同步盘、随手发给人）的人都直接拿到一个可用会话。
//
//   真实密钥还有一个更麻烦的性质：即使从未提交，只要它出现在磁盘上、且
//   仓库是公开的，它就已经是「已泄漏资产」，因为攻击者可以持续尝试。
//   所以这里检查的是**工作区内容**，不是 git 历史 —— git 历史是既成事实，
//   历史上真的泄漏过，只能改密钥而不能靠改代码补救。
//
//   本脚本不做 git 检查（那是 git check-ignore 的活），只回答一个问题：
//   当前磁盘上，有哪些文件装着看起来是真凭据的东西，它们安全吗。
//
// 跑法：node server/scripts/verify-no-secrets.cjs
// 退出码：0 = 干净；1 = 发现高危问题

'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');

// 只扫文本；这些目录是依赖、构建产物或运行数据，不可能有源码级凭据，
// 而且体积巨大，逐字节扫会把门禁变成慢操作。
var SKIP_DIRS = {
  '.git': 1, 'node_modules': 1, 'dist': 1, 'coverage': 1,
  'backups': 1, '.zcode': 1, 'Resources': 1
};

// 扫描上限：日志能到几十 MB，再大就只看形态不看内容了
var MAX_BYTES = 4 * 1024 * 1024;

/**
 * 真实凭据的形态。刻意不用单一正则 —— 一条正则永远漏得掉，
 * 这里分「一定是密钥」「大概率是密钥」「需要人看一眼」三档。
 */
var PATTERNS = [
  {
    level: 'fatal',
    name: 'OpenAI 风格 api_key',
    re: /\bsk-[A-Za-z0-9]{20,}\b/
  },
  {
    level: 'fatal',
    name: 'GitHub token',
    re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/
  },
  {
    level: 'fatal',
    name: 'GitHub fine-grained token',
    re: /github_pat_[A-Za-z0-9_]{20,}/
  },
  {
    level: 'fatal',
    name: 'AWS access key id',
    re: /\bAKIA[0-9A-Z]{16}\b/
  },
  {
    level: 'fatal',
    name: 'Google api key',
    re: /\bAIza[0-9A-Za-z_-]{30,}\b/
  },
  {
    level: 'fatal',
    name: 'PEM 私钥',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  },
  {
    level: 'fatal',
    name: '完整 JWT（含签名）',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/
  },
  {
    level: 'warn',
    name: '校级接入密钥赋值',
    // 校级密钥是 24 位随机大写码（形如 XXXX-XXXX-XXXX-XXXX-XXXX-XXXX 的大写码串）。
    // 这里刻意不写任何真实密钥当示例 —— 检查器自己被检出泄漏就是个笑话，
    // 而本仓是公开的，注释里的样例就是一次发布。
    re: /CLUSS_SHARED_SECRET\s*=\s*[A-Z0-9]{20,}/
  },
  {
    level: 'warn',
    name: '平台/MonkeyCode 会话',
    re: /monkeycode_ai_session[=\s:"']+[A-Za-z0-9_\-]{16,}/
  }
];

// 命中后如果整份文件在下面这些地方，就不算问题。
// server/.env 装着真实密钥是**设计如此** —— 它就是运行配置，且已被忽略。
var EXPECTED_SECRET_FILES = {
  'server/.env': 1,
  'server/.env.production': 1,
  'server/.env.local': 1
};

function walk(dir, out) {
  var entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS[e.name]) walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/** 二进制文件（数据库、sqlite）扫了只会出噪声，直接跳过。 */
function looksBinary(buf) {
  var n = Math.min(buf.length, 4096);
  for (var i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function main() {
  var files = walk(ROOT, []);
  var fatal = [];
  var warn = [];

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var relPath = rel(f);
    var isExpected = !!EXPECTED_SECRET_FILES[relPath];

    var st;
    try {
      st = fs.statSync(f);
    } catch (e) {
      continue;
    }
    if (st.size > MAX_BYTES) continue;

    var buf;
    try {
      buf = fs.readFileSync(f);
    } catch (e) {
      continue;
    }
    if (!buf.length || looksBinary(buf)) continue;

    var text = buf.toString('utf8');
    for (var p = 0; p < PATTERNS.length; p++) {
      var pat = PATTERNS[p];
      // 测试夹具里的假密钥不算问题：verify-*.cjs 自建了一校 A / 二校 B 的
      // 假 org 和假口令，这些常量是它们的输入，不是凭据。
      if (/verify-[\w-]+\.cjs$/.test(relPath)) continue;
      if (!pat.re.test(text)) continue;
      if (isExpected && pat.level === 'warn') continue;
      (pat.level === 'fatal' ? fatal : warn).push({
        file: relPath,
        name: pat.name,
        expected: isExpected
      });
    }
  }

  var ok = true;
  if (fatal.length) {
    ok = false;
    console.log('✗ 磁盘上存在看起来是真凭据的内容（高危）');
    var byFile = {};
    for (var i = 0; i < fatal.length; i++) {
      var item = fatal[i];
      byFile[item.file] = byFile[item.file] || [];
      if (byFile[item.file].indexOf(item.name) === -1) byFile[item.file].push(item.name);
    }
    Object.keys(byFile).forEach(function (file) {
      console.log('  · ' + file + '  →  ' + byFile[file].join('、'));
    });
    console.log('');
    console.log('  怎么处理：');
    console.log('    1. 确认该文件已在 .gitignore 里（git check-ignore -v <路径>）');
    console.log('    2. 若曾进过库，光加忽略没用 —— 必须改掉这个凭据本身');
    console.log('    3. 日志里的 JWT：轮换 JWT_SECRET 让旧 token 全部失效，再清日志');
  }

  if (warn.length) {
    console.log('! 以下文件含疑似真实密钥，人工确认一下（多数是本地配置副本）');
    var seen = {};
    for (var w = 0; w < warn.length; w++) {
      var it = warn[w];
      if (seen[it.file]) continue;
      seen[it.file] = 1;
      console.log('  · ' + it.file + '  →  ' + it.name + (it.expected ? '（本地配置，可接受）' : ''));
    }
  }

  if (ok) {
    console.log('✓ 磁盘扫描：未发现真实凭据' + (warn.length ? '（上方有需人工确认项）' : ''));
  }
  return ok ? 0 : 1;
}

process.exit(main());