@echo off
rem 组网互联（mesh）：中枢主动向班级节点建立反向隧道
rem
rem 为什么需要隧道：中枢（本机）的入站被系统防火墙拦着（非管理员改不动），
rem 而**本机 → 节点**方向是通的。于是由中枢主动发起 SSH，把本机的 9003
rem 反向映射到节点自己的 127.0.0.1:9119 —— 节点连自己的回环地址即可到达中枢，
rem 不需要中枢放行任何入站规则。
rem
rem 若哪天中枢的 9003 入站被正式放行（管理员执行防火墙放行），
rem 节点 .env 的 CLUSS_RELAY_URL 改回 http://100.99.237.111:9003，
rem 这条隧道就可以停掉了 —— 它只是绕过入站限制的手段，不是架构的一部分。
rem
rem -N              只做端口转发，不执行远程命令
rem -R              反向转发：远端 9119 → 本机 9003
rem ServerAlive     每 30 秒保活，避免中间设备掐掉空闲连接（这是断连的主因）
rem ExitOnForward   端口被占用时立刻失败退出，而不是挂着一个假“已连接”

ssh -N -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 9119:127.0.0.1:9003 cideploy@100.115.93.90
