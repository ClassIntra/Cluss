#!/usr/bin/env bash
# ============================================================
# Cluss Cloud 服务端一键引导（在一台全新的 Linux 机器/容器上执行）
#
# 云上只跑**服务端**：relay API + 托管的静态页面（client/dist，
# 管理台与公共服务页都是 Express 直接托管的产物文件）。
# 前端源码、构建链、qa、docs 都不上云 —— 构建在本地完成，dist 随包同步。
#
# 设计前提是这台机器是 ephemeral 的 —— 免费容器三天不活跃就整盘回滚，
# 所以本脚本必须幂等、可反复执行；数据由 backup-data.sh 周期备份到
# 机器外，重置后由 deploy.sh --restore 拉回。
#
# 用法（在仓库根目录）：
#   CLUSS_DEPLOY_DIR=/workspace/cluss bash scripts/cloud/bootstrap.sh
# 可选环境变量：
#   CLUSS_DEPLOY_DIR    部署目录，默认 /workspace/cluss
#   CLUSS_CLOUD_PORT    服务端口，默认 9003
#   CLUSS_ADMIN_PW      平台运营者密码；不填则随机生成并打印
#   CLUSS_CLOUD_SECRET  中枢自托管的 CLUSS_SHARED_SECRET；不填随机
#   CLUSS_RESTORE_DB    恢复用的数据库备份文件（.db 或 .db.gz）；首次部署恢复数据用
# ============================================================
set -euo pipefail

DEPLOY_DIR="${CLUSS_DEPLOY_DIR:-/workspace/cluss}"
CLOUD_PORT="${CLUSS_CLOUD_PORT:-10003}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[bootstrap] 部署目录: $DEPLOY_DIR（只部署服务端 + 静态页面）"

# ---- 1) 同步代码（白名单：服务端源码、依赖清单、前端产物、云运维脚本）----
# 用 rm+cp 而非 rsync：本地 Windows（Git Bash）与精简容器都未必带 rsync
mkdir -p "$DEPLOY_DIR/server" "$DEPLOY_DIR/client" "$DEPLOY_DIR/scripts/cloud"
rm -rf "$DEPLOY_DIR/server/src" "$DEPLOY_DIR/client/dist"
cp -r "$REPO_DIR/server/src" "$DEPLOY_DIR/server/src"
cp "$REPO_DIR/server/package.json" "$DEPLOY_DIR/server/"
[ -f "$REPO_DIR/server/package-lock.json" ] && cp "$REPO_DIR/server/package-lock.json" "$DEPLOY_DIR/server/"
cp -r "$REPO_DIR/client/dist" "$DEPLOY_DIR/client/dist"
cp "$REPO_DIR"/scripts/cloud/*.sh "$DEPLOY_DIR/scripts/cloud/"

# ---- 2) 依赖安装（node_modules 缺失才装；原生模块按本机 node 重建）----
cd "$DEPLOY_DIR/server"
if [ ! -d node_modules ]; then
  echo "[bootstrap] 安装 server 依赖…"
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -2
else
  npm rebuild better-sqlite3 sharp 2>&1 | tail -1 || true
fi

# ---- 3) .env（已存在则不动；首次生成随机密钥）----
cd "$DEPLOY_DIR"
if [ ! -f .env ]; then
  ADMIN_PW="${CLUSS_ADMIN_PW:-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)}"
  SHARED="${CLUSS_CLOUD_SECRET:-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)}"
  JWT="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48)"
  cat > .env <<EOF
NODE_ENV=production
CLUSS_MODE=relay
PORT=$CLOUD_PORT
CLUSS_INSTANCE_ID=cluss-cloud
JWT_SECRET=$JWT
ADMIN_USER_ID=999999
ADMIN_NET_NAME=运营者
ADMIN_REAL_NAME=Cloud运营者
ADMIN_PASSWORD=$ADMIN_PW
CLUSS_SHARED_SECRET=$SHARED
PUBLIC_BASE_URL=
EOF
  echo "[bootstrap] 已生成 .env —— 平台运营者密码: $ADMIN_PW（请立即保存）"
else
  echo "[bootstrap] .env 已存在，保持不变"
fi

# ---- 3.5) 数据恢复（重置后的机器：把最近一份备份放回去）----
if [ -n "${CLUSS_RESTORE_DB:-}" ] && [ ! -f "$DEPLOY_DIR/server/database/cluss.db" ]; then
  mkdir -p "$DEPLOY_DIR/server/database"
  case "$CLUSS_RESTORE_DB" in
    *.gz) gunzip -c "$CLUSS_RESTORE_DB" > "$DEPLOY_DIR/server/database/cluss.db" ;;
    *)    cp "$CLUSS_RESTORE_DB" "$DEPLOY_DIR/server/database/cluss.db" ;;
  esac
  echo "[bootstrap] 已从备份恢复数据库: $CLUSS_RESTORE_DB"
fi

# ---- 4) 前端产物检查（本地随包带 client/dist；缺了就地报错，不在云上构建）----
if [ ! -f "$DEPLOY_DIR/client/dist/index.html" ]; then
  echo "[bootstrap][FATAL] client/dist 缺失 —— 请在本地 npm run build 后再部署（云上不装构建链）"
  exit 1
fi

# ---- 5) 进程守护：pm2（容器里没有 systemd）----
if ! command -v pm2 >/dev/null 2>&1; then
  echo "[bootstrap] 安装 pm2…"
  npm install -g pm2 --no-audit --no-fund 2>&1 | tail -1
fi
cd "$DEPLOY_DIR"
pm2 delete cluss-cloud >/dev/null 2>&1 || true
PORT="$CLOUD_PORT" pm2 start server/src/app.js --name cluss-cloud --time \
  --max-memory-restart 700M --max-restarts 50 >/dev/null
pm2 save >/dev/null
pm2 logs cluss-cloud --lines 5 --nostream || true

echo "[bootstrap] 完成。健康检查：curl -s http://127.0.0.1:$CLOUD_PORT/api/health"
