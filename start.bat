@echo off
rem Cluss 一键启动：自动补依赖、按需构建前端、再启动服务端（逻辑见 scripts/start.js）
>nul 2>&1 chcp 65001
cd /d "%~dp0"
node scripts\start.js %*
if errorlevel 1 pause
