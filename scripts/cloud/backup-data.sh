#!/usr/bin/env bash
# ============================================================
# Cluss Cloud 数据备份（在部署机上周期执行）
#
# 为什么必须做：免费容器整盘回滚（三天不活跃），中枢又是权威账本——
# cluss.db 丢了等于全校的额度记录没了。备份保存在机器外的路径
# （默认 /workspace 是容器盘的一部分也会被回滚！），由部署方的
# cron / 外部任务定期拉走（scripts/cloud/deploy.sh 的 --pull-backup）。
#
# 用 sqlite 在线备份（better-sqlite3 .backup），对运行中的服务安全；
# WAL 模式下直接 cp 有撕裂风险，不采用。
#
# 用法：CLUSS_DEPLOY_DIR=/workspace/cluss bash scripts/cloud/backup-data.sh
# 环境变量：
#   CLUSS_DEPLOY_DIR   部署目录（默认 /workspace/cluss）
#   CLUSS_BACKUP_DIR   备份目录（默认 $DEPLOY_DIR-backups，建议指到容器外挂载卷）
#   CLUSS_BACKUP_KEEP  保留份数（默认 48：一小时一次刚好两天）
# ============================================================
set -euo pipefail

DEPLOY_DIR="${CLUSS_DEPLOY_DIR:-/workspace/cluss}"
BACKUP_DIR="${CLUSS_BACKUP_DIR:-$DEPLOY_DIR-backups}"
KEEP="${CLUSS_BACKUP_KEEP:-48}"
DB_PATH="$DEPLOY_DIR/server/database/cluss.db"

[ -f "$DB_PATH" ] || { echo "[backup] 数据库不存在：$DB_PATH（首次启动前无需备份）"; exit 0; }
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/cluss-$STAMP.db"

# 在线备份：better-sqlite3 的 backup API（锁页复制，不阻塞业务）
node -e '
  var dbPath = process.argv[1], target = process.argv[2];
  var Database = require(dbPath.replace(/server\/database\/[^/]+$/, "server/node_modules/better-sqlite3"));
  var db = new Database(dbPath, { readonly: true });
  db.backup(target).then(function () {
    db.close();
    console.log("[backup] 完成: " + target);
  }).catch(function (e) { console.error(e.message); process.exit(1); });
' "$DB_PATH" "$TARGET"

gzip -f "$TARGET"

# 只保留最近 KEEP 份
ls -1t "$BACKUP_DIR"/cluss-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "[backup] 当前备份：$(ls -1 "$BACKUP_DIR"/cluss-*.db.gz | wc -l) 份，最新 $(ls -1t "$BACKUP_DIR"/cluss-*.db.gz | head -1)"
