#!/usr/bin/env bash
# ============================================================
# Cluss Cloud 保活 + 数据外备（在本地 Windows / Git Bash 跑）
#
# 免费云机三天不活跃就整盘回滚，而中枢是权威账本 —— 数据必须每天
# 拉到机器外。本脚本：
#   1. 确保 cloudflared access 隧道在本地 2222 端口活着（死了就重启）；
#   2. 触发云机上的 backup-data.sh（在线备份 cluss.db，保留 48 份）；
#   3. 把最新备份拉回本地 backups/cloud/。
#
# ⚠️ 云机重置后隧道地址会变（trycloudflare 随机域名），本脚本会失败并
#    在日志里留下明显错误 —— 那时需要先用共享终端重建云机（见
#    docs/cloud-runbook.md，重置后一条命令恢复）。
#
# 定时：由 ZCode 的每日任务调用（见会话记录），或手动：
#   bash scripts/cloud/keepalive.sh
# ============================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$REPO_DIR/backups/cloud/keepalive.log"
ACCESS_HOST="${CLOUD_CF_HOST:-armed-ana-luck-hartford.trycloudflare.com}"
LOCAL_PORT="${CLOUD_SSH_PORT:-2222}"
mkdir -p "$REPO_DIR/backups/cloud"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# ---- 1) access 隧道：端口活着就复用，否则后台拉起 ----
if ! (echo > /dev/tcp/127.0.0.1/$LOCAL_PORT) >/dev/null 2>&1; then
  log "access 隧道不在，重启: $ACCESS_HOST -> 127.0.0.1:$LOCAL_PORT"
  nohup "$HOME/bin/cloudflared.exe" access tcp \
    --hostname "$ACCESS_HOST" --url "127.0.0.1:$LOCAL_PORT" \
    --loglevel error >> "$LOG" 2>&1 &
  sleep 6
fi

# ---- 2+3) 备份并拉回 ----
log "=== 开始每日备份 ==="
if CLOUD_SSH_HOST=127.0.0.1 CLOUD_SSH_PORT=$LOCAL_PORT \
   bash "$REPO_DIR/scripts/cloud/deploy.sh" --pull-backup >> "$LOG" 2>&1; then
  log "备份成功：$(ls -1t "$REPO_DIR/backups/cloud/"cluss-*.db.gz 2>/dev/null | head -1)"
else
  log "备份失败（云机可能已重置或隧道失效，需要跑 runbook 重建）"
  exit 1
fi
