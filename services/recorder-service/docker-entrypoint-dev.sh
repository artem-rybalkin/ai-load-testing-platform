#!/bin/sh
Xvfb :99 -screen 0 1280x800x24 -ac &
sleep 1
x11vnc -display :99 -nopw -listen localhost -forever -quiet &
/usr/share/novnc/utils/launch.sh --vnc localhost:5900 --listen 6080 &
exec npx tsx watch src/index.ts
