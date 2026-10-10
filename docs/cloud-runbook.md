# Cluss Cloud 运维手册（免费云机 / ephemeral 部署）

> 云机 = MonkeyCode 免费容器（Debian 12，Firecracker 微虚机，2C/8G/20G 盘）。
> **它三天不和平台 agent 对话就整盘回滚** —— 本手册的前提就是「机器随时会没」，
> 所有持久化的东西都在机器外：代码在 git，账本备份在本地 `backups/cloud/`。

## 当前部署形态

| 项 | 值 |
|---|---|
| 部署目录 | `/workspace/cluss`（只部署服务端 + client/dist，端口 **10003**） |
| 进程守护 | pm2，应用名 `cluss-cloud` |
| 公网入口 | Cloudflare 快速隧道（trycloudflare.com，pm2 应用 `cf-http`） |
| SSH 通道 | Cloudflare 快速隧道（pm2 应用 `cf-ssh`）+ 本地 `cloudflared access` |
| 平台运营者 | 账号 `999999`，密码见云机 `/workspace/cluss/.env`（bootstrap 生成时打印过） |

⚠️ 快速隧道的域名是随机的，**云机重置或隧道重启后会变**。固定域名需要
Cloudflare 账号绑定（设计文档 §10.2），当前阶段接受漂移。

## 日常操作（本地 Git Bash）

```bash
# 部署/更新代码（幂等，可反复执行）
CLOUD_SSH_HOST=127.0.0.1 CLOUD_SSH_PORT=2222 bash scripts/cloud/deploy.sh deploy

# 每日备份（已挂 ZCode 每日 9 点任务，也可手动）
bash scripts/cloud/keepalive.sh

# 看服务状态
CLOUD_SSH_HOST=127.0.0.1 CLOUD_SSH_PORT=2222 bash scripts/cloud/deploy.sh --status
```

前置条件：本地 `~/bin/cloudflared.exe` 存在，且 access 隧道活着
（keepalive.sh 会自动拉起，也可手动）：

```bash
~/bin/cloudflared.exe access tcp \
  --hostname <cf-ssh 隧道域名> --url 127.0.0.1:2222 --loglevel error &
```

## 云机重置后的恢复（Runbook）

1. 打开共享终端（MonkeyCode → 远程协助），新容器里重做一次性环境：

   ```bash
   # ① SSH + 隧道底座
   apt-get update -qq && apt-get install -y -qq openssh-server rsync curl
   # 写入本地公钥（本机 ~/.ssh/cluss_cloud.pub 的内容）
   mkdir -p /root/.ssh && echo 'ssh-ed25519 AAAA... zcode-cluss-cloud' > /root/.ssh/authorized_keys
   chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys
   printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\n' > /etc/ssh/sshd_config.d/99-cluss.conf
   mkdir -p /run/sshd && /usr/sbin/sshd

   # ② cloudflared + pm2
   curl -sL -o /tmp/cf.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && dpkg -i /tmp/cf.deb
   npm install -g pm2 --no-audit --no-fund

   # ③ 两条隧道（http2 协议，QUIC 在容器网络里不通）
   pm2 start cloudflared --name cf-ssh -- tunnel --url tcp://localhost:22 --protocol http2
   pm2 start cloudflared --name cf-http -- tunnel --url http://localhost:10003 --protocol http2
   grep -hoE 'https://[a-z0-9-]+[.]trycloudflare[.]com' /root/.pm2/logs/*error.log | sort -u
   ```

2. 本地重建 access 隧道（新 SSH 域名）：

   ```bash
   ~/bin/cloudflared.exe access tcp --hostname <新 cf-ssh 域名> --url 127.0.0.1:2222 --loglevel error &
   ```

3. 推代码 + 从本地最新备份恢复数据：

   ```bash
   CLOUD_SSH_HOST=127.0.0.1 CLOUD_SSH_PORT=2222 bash scripts/cloud/deploy.sh --restore-latest deploy
   ```

4. 新的 HTTP 隧道域名就是新的公共服务入口，各班节点 `.env` 里的
   `CLUSS_RELAY_URL` 需要跟着改（这是快速隧道的代价；绑固定域名后消失）。

## 数据边界

- 上云的只有计量数据（学号、用量、费用、班级标识）与分配额度；
  对话内容、云盘文件、学生密码**永远只在班级节点本地**。
- 备份文件含账目，已在 `.gitignore` 里排除，不要提交、不要外传。
