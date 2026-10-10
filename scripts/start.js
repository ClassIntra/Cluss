#!/usr/bin/env node
// Cluss 一键启动
//
// 每一步都先判断、能跳过就跳过：
//   1) 依赖检查 —— node_modules 缺失，或 package.json 比「上次安装」新，才 npm install
//   2) 前端构建 —— client/dist 缺失，或 client 源码比构建产物新，才 vite build
//   3) 端口预检 —— 端口已被监听视为「服务已在运行」，直接开页面，不重复起服
//   4) 起服务   —— 拉起 server/src/app.js；--open 时监听成功后打开浏览器
//
// 用法：node scripts/start.js [--open] [--force-build] [--skip-build]

var fs = require('fs');
var path = require('path');
var net = require('net');
var spawn = require('child_process').spawn;
var spawnSync = require('child_process').spawnSync;

var ROOT = path.join(__dirname, '..');
var SERVER = path.join(ROOT, 'server');
var CLIENT = path.join(ROOT, 'client');
var DEFAULT_PORT = 9003;

var args = process.argv.slice(2);
var shouldOpen = args.indexOf('--open') !== -1;
var forceBuild = args.indexOf('--force-build') !== -1;
var skipBuild = args.indexOf('--skip-build') !== -1;
if (args.indexOf('-h') !== -1 || args.indexOf('--help') !== -1) {
  console.log('用法：node scripts/start.js [--open] [--force-build] [--skip-build]');
  process.exit(0);
}

function log(s) { console.log('[start] ' + s); }
function die(msg) { console.error('[start] ' + msg); process.exit(1); }
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ---------- 1) 依赖 ----------
// npm 装完会在 node_modules/.package-lock.json 留下时间戳，拿它和 package.json 比较
function needInstall(dir) {
  var nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) return true;
  var marker = path.join(nm, '.package-lock.json');
  if (!fs.existsSync(marker)) return false; // 装过但没留标记（老版本 npm），不重复装
  var installedAt = fs.statSync(marker).mtimeMs;
  var files = ['package.json', 'package-lock.json'];
  for (var i = 0; i < files.length; i++) {
    var p = path.join(dir, files[i]);
    if (fs.existsSync(p) && fs.statSync(p).mtimeMs > installedAt + 1000) return true;
  }
  return false;
}

function npmInstall(dir, name) {
  log(name + ' 依赖缺失或刚更新，执行 npm install ...');
  var r = spawnSync('npm install', { cwd: dir, stdio: 'inherit', shell: true });
  if (r.status !== 0) die(name + ' npm install 失败，请查看上方报错');
}

// ---------- 2) 构建 ----------
// 这些目录不参与「源码是否变过」的判断：产物本身、依赖、一次性代码巡检脚本
var SKIP_DIRS = { 'node_modules': 1, 'dist': 1, '.git': 1, 'scripts': 1 };

function clientLatestMtime() {
  var latest = 0;
  (function walk(dir) {
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach(function(e) {
      if (SKIP_DIRS[e.name]) return;
      var p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      try {
        var m = fs.statSync(p).mtimeMs;
        if (m > latest) latest = m;
      } catch (e2) { /* 读不到的条目跳过 */ }
    });
  })(CLIENT);
  return latest;
}

function clientNeedBuild() {
  if (forceBuild) return true;
  var distIndex = path.join(CLIENT, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) return true;
  // 留 1 秒余量，吸收 FAT/exFAT 分区秒级粒度的时间戳
  return clientLatestMtime() > fs.statSync(distIndex).mtimeMs + 1000;
}

// ---------- 3) 端口 ----------
// 与 server/src/config 同序：进程环境变量优先，其次 server/.env，最后默认 9003
function resolvePort() {
  if (process.env.PORT) return Number(process.env.PORT);
  var envFile = path.join(SERVER, '.env');
  if (fs.existsSync(envFile)) {
    var m = fs.readFileSync(envFile, 'utf8').match(/^\s*PORT\s*=\s*['"]?(\d+)/m);
    if (m) return Number(m[1]);
  }
  return DEFAULT_PORT;
}

function portOpen(port) {
  return new Promise(function(resolve) {
    var sock = net.connect({ host: '127.0.0.1', port: port });
    var done = function(yes) { sock.destroy(); resolve(yes); };
    sock.setTimeout(500);
    sock.once('connect', function() { done(true); });
    sock.once('timeout', function() { done(false); });
    sock.once('error', function() { done(false); });
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ---------- 主流程 ----------
async function main() {
  var major = Number(process.versions.node.split('.')[0]);
  if (major < 20) die('需要 Node.js 20+（当前 ' + process.versions.node + '），建议直接用 22 LTS');

  var port = resolvePort();
  var url = 'http://127.0.0.1:' + port + '/';
  log('Cluss 一键启动，页面地址 ' + url);

  if (!fs.existsSync(path.join(SERVER, '.env'))) {
    console.warn('[start] 警告：未找到 server/.env —— 服务端会因缺少 JWT_SECRET 拒绝启动。');
    console.warn('[start]        请先：cd server && cp .env.example .env，然后编辑填写。');
  }

  if (needInstall(SERVER)) npmInstall(SERVER, '服务端');
  else log('服务端依赖齐全，跳过安装');
  if (needInstall(CLIENT)) npmInstall(CLIENT, '前端');
  else log('前端依赖齐全，跳过安装');

  if (skipBuild) log('--skip-build：跳过前端构建检查');
  else if (clientNeedBuild()) {
    log('前端需要构建' + (forceBuild ? '（--force-build）' : '（源码比 client/dist 新，或产物缺失）') + ' ...');
    var r = spawnSync('npm run build', { cwd: CLIENT, stdio: 'inherit', shell: true });
    if (r.status !== 0) die('前端构建失败，请查看上方报错');
  } else log('前端产物已是最新，跳过构建');

  if (await portOpen(port)) {
    log('端口 ' + port + ' 已有服务在监听（Cluss 可能已在运行），不再重复启动');
    if (shouldOpen) openBrowser(url);
    return;
  }

  log('启动服务端 ...');
  var child = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, stdio: 'inherit' });
  var childCode = null;
  child.on('exit', function(code) { childCode = code; });
  process.on('SIGINT', function() { child.kill('SIGINT'); });
  process.on('SIGTERM', function() { child.kill('SIGTERM'); });

  // 等监听成功（首次启动含建库迁移，多给点时间），最多 30 秒
  var deadline = Date.now() + 30000;
  var opened = false;
  while (Date.now() < deadline && childCode === null) {
    if (await portOpen(port)) { opened = true; break; }
    await sleep(300);
  }

  if (opened) {
    log('服务已就绪：' + url + '（Ctrl+C 停止）');
    if (shouldOpen) openBrowser(url);
  } else if (childCode === null) {
    log('30 秒内未检测到端口就绪，请查看上方服务端日志');
  } else {
    log('服务端启动失败（退出码 ' + childCode + '），请查看上方日志');
  }

  // 前台陪跑：服务端退出则本脚本以相同退出码结束
  await new Promise(function(resolve) { child.on('exit', resolve); });
  process.exit(childCode === null ? 1 : childCode);
}

main();
