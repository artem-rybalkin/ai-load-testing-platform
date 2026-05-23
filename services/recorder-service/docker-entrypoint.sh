#!/bin/sh
# Start Xvfb virtual display so non-headless Chromium has a screen to render on
Xvfb :99 -screen 0 1280x800x24 -ac &
XVFB_PID=$!

# Give Xvfb a moment to initialise
sleep 1

# Start VNC server (no password, localhost only — noVNC proxies it to HTTP)
x11vnc -display :99 -nopw -listen localhost -forever -quiet &

# Start noVNC WebSocket → VNC proxy on port 6080
/usr/share/novnc/utils/launch.sh --vnc localhost:5900 --listen 6080 &

# Start the recorder-service Node.js process
exec node dist/index.js
