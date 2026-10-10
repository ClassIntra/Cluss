#!/usr/bin/env bash
# ============================================================
# Cluss Cloud 部署/运维脚本（在**本地**机器跑，Git Bash）
#
# 通过 SSH 隧道操作云机（免费容器没有公网入站，bore 反向隧道暴露 SSH）。
# 云机 ephemeral（三天不活跃整盘回滚），所以本脚本承担三件事：
#   deploy          推代码 + 引导服务（幂等，可反复执行）
#   --restore-latest 部署时顺带用本地最新备份恢复数据（重置后的第一次）
#   --pull-backup   远程执行备份并拉回本地（配合本地定时任务做数据外备）
#   --status        查看服务状态
#
# 用法：
#   bash scripts/cloud/deploy.sh deploy
#   bash scripts/cloud/deploy.sh --restore-latest deploy
#   bash scripts/cloud/deploy.sh --pull-backup
#   bash scripts/cloud/deploy.sh --status
# 环境变量：
#   CLOUD_SSH_HOST=bore.pub  CLOUD_SSH_PORT=32484  CLOUD_SSH_USER=root
#   CLOUD_SSH_KEY=~/.ssh/cluss_cloud
#   CLOUD_DEPLOY_DIR=/workspace/cluss
#   CLOUD_BACKUP_LOCAL=./backups/cloud
# ============================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${CLOUD_SSH_HOST:-bore.pub}"
PORT="${CLOUD_SSH_PORT:-32484}"
USER="${CLOUD_SSH_USER:-root}"
KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/cluss_cloud}"
DEPLOY_DIR="${CLOUD_DEPLOY_DIR:-/workspace/cluss}"
LOCAL_BACKUP_DIR="${CLOUD_BACKUP_LOCAL:-$REPO_DIR/backups/cloud}"

SSH_OPTS=(-i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20)
# scp 的端口参数是大写 -P（小写 -p 是 preserve），必须单列
SCP_OPTS=(-i "$KEY" -P "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20)
SSH="ssh ${SSH_OPTS[*]} $USER@$HOST"
SCP="scp ${SCP_OPTS[*]}"

log() { echo "[deploy] $*"; }

do_deploy() {
  local restore_flag="$1"

  log "打包服务端（server/src + dist + 云脚本）…"
  local tgz="/tmp/cluss-deploy.tar.gz"
  tar czf "$tgz" -C "$REPO_DIR" \
    server/src server/package.json $( [ -f server/package-lock.json ] && echo server/package-lock.json ) \
    client/dist scripts/cloud

  log "上传到云机…"
  $SSH "mkdir -p /tmp/cluss-deploy"
  $SCP "$tgz" "$USER@$HOST:/tmp/cluss-deploy.tar.gz" >/dev/null
  $SSH "tar xzf /tmp/cluss-deploy.tar.gz -C /tmp/cluss-deploy"

  local restore_env=""
  if [ "$restore_flag" = "restore" ]; then
    local latest
    latest=$(ls -1t "$LOCAL_BACKUP_DIR"/cluss-*.db.gz 2>/dev/null | head -1 || true)
    if [ -n "$latest" ]; then
      log "上传本地最新备份用于恢复: $latest"
      $SCP "$latest" "$USER@$HOST:/tmp/cluss-restore.db.gz" >/dev/null
      restore_env="CLUSS_RESTORE_DB=/tmp/cluss-restore.db.gz"
    else
      log "（本地没有可用备份，跳过恢复）"
    fi
  fi

  log "执行引导脚本…"
  $SSH "$restore_env CLUSS_DEPLOY_DIR=$DEPLOY_DIR bash /tmp/cluss-deploy/scripts/cloud/bootstrap.sh"
  log "部署完成。"
}

do_pull_backup() {
  log "触发远程备份…"
  $SSH "CLUSS_DEPLOY_DIR=$DEPLOY_DIR bash $DEPLOY_DIR/scripts/cloud/backup-data.sh"
  mkdir -p "$LOCAL_BACKUP_DIR"
  local remote_latest
  remote_latest=$($SSH "ls -1t $DEPLOY_DIR-backups/cluss-*.db.gz 2>/dev/null | head -1")
  if [ -z "$remote_latest" ]; then
    log "远程没有生成备份文件，退出"
    exit 1
  fi
  log "拉回备份: $remote_latest"
  $SCP "$USER@$HOST:$remote_latest" "$LOCAL_BACKUP_DIR/" >/dev/null
  log "本地备份目录：$LOCAL_BACKUP_DIR（$(ls -1 "$LOCAL_BACKUP_DIR" | wc -l) 份）"
}

do_status() {
  $SSH "pm2 ls; echo ---; CPORT=$(grep "^PORT=" $DEPLOY_DIR/.env 2>/dev/null | cut -d= -f2); curl -s http://127.0.0.1:${CPORT:-10003}/api/health | head -c 400; echo; echo ---; ls -1t $DEPLOY_DIR-backups/ 2>/dev/null | head -3"
}

ACTION="deploy"
RESTORE="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --restore-latest) RESTORE="restore" ;;
    --pull-backup) ACTION="pull-backup" ;;
    --status) ACTION="status" ;;
    deploy|pull-backup|status) ACTION="$1" ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
  shift
done

case "$ACTION" in
  deploy) do_deploy "$RESTORE" ;;
  pull-backup) do_pull_backup ;;
  status) do_status ;;
esac
