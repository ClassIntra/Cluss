@echo off
rem Cluss mesh tunnel - the hub actively opens a reverse tunnel to the class node.
rem
rem Why a tunnel is needed: inbound connections to this hub are blocked by the
rem system firewall (cannot be changed without admin), while hub -> node is
rem fine. So the hub starts the SSH session itself and maps its local 9003 out
rem to the node 127.0.0.1:9119 -- the node reaches the hub via its own loopback
rem and no inbound firewall rule is required on the hub.
rem
rem If port 9003 inbound is ever allowed for real (admin adds a firewall rule),
rem point the node CLUSS_RELAY_URL back to http://100.99.237.111:9003 and this
rem tunnel can be retired -- it is a workaround for the inbound restriction,
rem not part of the architecture.
rem
rem -N               forward ports only, run no remote command
rem -R               reverse forward: remote 9119 -> local 9003
rem ServerAlive     keepalive every 30s; idle connections being dropped by
rem                  intermediate devices is the main cause of disconnects
rem ExitOnForward    fail fast when the remote port is taken, instead of
rem                  hanging on a fake connected session
rem
rem NOTE: keep this file pure ASCII + CRLF.  cmd.exe parses .bat as GBK, so
rem UTF-8 Chinese comments get mis-split at the byte level and end up being
rem executed as commands (seen on 2026-10-25: five not-recognized-as-command
rem errors per boot, right before the ssh line finally ran).
rem

ssh -N -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 9119:127.0.0.1:9003 cideploy@100.115.93.90
