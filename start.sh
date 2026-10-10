#!/bin/sh
# Cluss 一键启动（Linux / macOS / Git Bash）：逻辑见 scripts/start.js
cd "$(dirname "$0")" || exit 1
exec node scripts/start.js "$@"
