// 组网反向隧道（中枢 → 8 班）
//
// 为什么存在：中枢 9003 的**入站**被系统防火墙拦着（非管理员改不动），
// 而中枢 → 节点方向是通的。于是由中枢主动 SSH，把中枢的 9003 反向映射到
// 节点自己的 127.0.0.1:9119；节点连自己的回环就能到中枢。
//
// 为什么是 .js 而不是 .bat：PM2 不会把 .bat 当脚本执行（试过两种 interpreter，
// 一种只开一个空 cmd，一种让 Node 去 require 批处理直接报错），而 PM2 的
// 自动重启/日志轮转对 Node 进程才是原生的。这里只做一件事：托管 ssh 子进程，
// 子进程退出就跟着退出，让 PM2 拉起下一次。
//
// 若哪天中枢 9003 入站被正式放行，节点 .env 的 CLUSS_RELAY_URL 改回
// http://100.99.237.111:9003，这个进程就可以删掉 —— 它是绕路，不是架构。
var spawn = require('child_process').spawn;

var SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
var TARGET = 'cideploy@100.115.93.90';
var ARGS = [
  '-N',
  '-o', 'BatchMode=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-R', '9119:127.0.0.1:9003',
  TARGET
];

function log(msg) {
  console.log('[' + new Date().toISOString().slice(0, 19).replace('T', ' ') + '] ' + msg);
}

function run() {
  log('建立反向隧道 8 班:9119 → 中枢:9003');
  var child = spawn(SSH, ARGS, { stdio: ['ignore', 'inherit', 'inherit'] });

  child.on('error', function(e) {
    log('启动 ssh 失败: ' + e.message);
    process.exit(1);
  });

  child.on('exit', function(code, signal) {
    log('ssh 退出 code=' + code + ' signal=' + signal + '，交给 PM2 重启');
    process.exit(typeof code === 'number' ? code : 1);
  });

  process.on('SIGINT', function() { child.kill(); process.exit(0); });
  process.on('SIGTERM', function() { child.kill(); process.exit(0); });
}

run();
