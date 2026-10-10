var fs = require('fs');
var path = require('path');

// ============================================================================
// Cluss 服务端 PM2 配置
//
// 为什么需要这个文件：
//   Cluss 此前一直是一个「脱离 PM2 的裸 node 进程」，机器重启后不会自启，
//   而且崩了也没人拉起来（无 autorestart、无日志轮转）。
//   ClassIntra 侧同样的教训：不写进 PM2 应用清单的常驻进程，重启后会静默消失。
//
// 开机链路（本机现状）：
//   启动文件夹 ClassIntraStart.lnk -> start-classintra.cmd -> `pm2 resurrect`
//   （resurrect 读的是 C:\Users\iflytek\.pm2\dump.pm2，**不是**本文件）
//   所以新增应用除了 pm2 start，**必须再 `pm2 save`**，否则下次开机不会恢复。
// ============================================================================

// Node 解释器：显式钉死系统 Node。
// 原因：better-sqlite3 是原生模块，按**系统 Node 的 ABI** 编译（Node 24 = NODE_MODULE_VERSION 137）。
// 如果 PM2 子进程从 PATH 解析到别的 Node（例如被外部工具注入到 PATH 前端的 Node 22 = ABI 127），
// 服务会在 require('better-sqlite3') 处 ERR_DLOPEN_FAILED 崩溃，
// 表现为「PM2 反复重启 + 端口不通」，且日志里只有一行 ABI 数字，极易误判成别的问题。
var NODE_BIN = 'C:\\Program Files\\nodejs\\node.exe';
var nodeInterpreter = fs.existsSync(NODE_BIN) ? NODE_BIN : 'node';

// 绝对路径：pm2 resurrect 时工作目录不一定是我们期望的那个，绝不能用相对路径
var serverDir = path.resolve(__dirname, 'server');

module.exports = {
  apps: [
    {
      name: 'cluss-server',
      script: 'src/app.js',
      cwd: serverDir,
      exec_mode: 'fork',
      exec_interpreter: nodeInterpreter,   // 见上方 NODE_BIN 说明，必须钉死
      autorestart: true,
      max_restarts: 20,
      restart_delay: 8000,
      exp_backoff_restart_delay: 100,      // 崩溃循环时退避，别把磁盘日志刷爆
      min_uptime: '30s',
      listen_timeout: 30000,
      kill_timeout: 10000,                 // 留够时间让 SQLite 正常收尾
      watch: false,
      max_memory_restart: '1G',
      node_args: '--max-old-space-size=768',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(serverDir, 'logs', 'pm2-error.log'),
      out_file: path.join(serverDir, 'logs', 'pm2-out.log'),
      merge_logs: true,

      // ⚠️ 这里**刻意不逐个转发 .env 的键**（ClassIntra 的 ecosystem.config.js 是逐个列出的）。
      //
      //   原因：dotenv **不覆盖**已存在的 process.env。PM2 的 env 会先写进 process.env，
      //   于是凡是在这里列出的键都会**盖住 .env 的同名键**。后果是：
      //   哪天改了 server/.env（换 AI 模型 / 换密钥 / 改端口）却忘了 pm2 save + restart，
      //   进程会一直用 dump.pm2 里那份旧值 —— 「改了配置不生效，且没有任何报错」。
      //
      //   本仓库的 server/src/app.js 第 8 行自带 require('dotenv').config()，cwd 指向 server/，
      //   所以 .env 是**唯一且始终最新**的配置源。此处只保留两个与运行环境相关的键。
      env: {
        NODE_ENV: 'production',
        NODE_PATH: path.join(serverDir, 'node_modules'),
        // 外部工具（WorkBuddy 等）会通过 NODE_OPTIONS=--require <shim> 注入自己的垫片。
        // 一旦被 PM2 守护进程继承，本应用也会被注入（同族的 PYTHONPATH 劫持见 classintra 的 pcagent）。
        // 显式清空，避免这层污染顺着 PM2 传到服务进程里。
        NODE_OPTIONS: ''
      }
    }
  ]
};
