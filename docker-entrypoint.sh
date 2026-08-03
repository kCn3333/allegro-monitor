#!/bin/sh
set -eu

: "${VNC_PASSWORD:?Set VNC_PASSWORD in Portainer}"

export DISPLAY=:99
Xvfb :99 -screen 0 1365x768x24 -nolisten tcp &
sleep 1
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vnc.pass >/dev/null
x11vnc -display :99 -forever -shared -localhost -rfbport 5900 -rfbauth /tmp/vnc.pass -quiet &
websockify --web=/usr/share/novnc/ 0.0.0.0:6080 localhost:5900 &

exec node --experimental-sqlite dist/src/server.js
