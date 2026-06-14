#!/bin/sh
# Entrypoint for recorder-service in Docker.
# Starts Xvfb virtual display + x11vnc VNC server + noVNC WebSocket proxy,
# then starts the recorder Node.js service.
# X11/VNC failures are non-fatal — the recorder still works, just without a visible browser.

# ── 0. Clean up stale X11 lock files from previous container run ─────────────
# These are left behind when Docker restarts the container without recreating it.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

# ── 1. Start Xvfb virtual display ────────────────────────────────────────────
Xvfb :99 -screen 0 1280x960x24 -ac &
XVFB_PID=$!

# Wait for X11 socket to appear (max 10 seconds)
i=0
while [ ! -e /tmp/.X11-unix/X99 ] && [ $i -lt 50 ]; do
  sleep 0.2
  i=$((i+1))
done

if [ ! -e /tmp/.X11-unix/X99 ]; then
  echo "Warning: Xvfb did not start — recording browser will run headlessly"
else
  # ── 2. Start x11vnc VNC server ─────────────────────────────────────────────
  # VNC_PASSWORD (if set) requires clients to authenticate before viewing the
  # recording browser — required for production where 6080 may be reachable
  # beyond localhost. Falls back to no auth for local dev.
  if [ -n "$VNC_PASSWORD" ]; then
    x11vnc -display :99 -passwd "$VNC_PASSWORD" -listen 0.0.0.0 -forever -quiet > /dev/null 2>&1 &
  else
    x11vnc -display :99 -nopw -listen 0.0.0.0 -forever -quiet > /dev/null 2>&1 &
  fi
  sleep 1  # give x11vnc time to bind port 5900 before websockify starts

  # ── 3. Start websockify (noVNC WebSocket-to-VNC proxy) ────────────────────
  # Alpine installs noVNC web files to /usr/share/webapps/novnc
  NOVNC_WEB=""
  for d in /usr/share/webapps/novnc /usr/share/novnc; do
    if [ -d "$d" ]; then
      NOVNC_WEB="$d"
      break
    fi
  done

  if [ -n "$NOVNC_WEB" ]; then
    python3 -m websockify --web="$NOVNC_WEB" 6080 localhost:5900 &
    echo "noVNC started at http://0.0.0.0:6080 (web files: $NOVNC_WEB)"
  else
    echo "Warning: noVNC web files not found — VNC viewer will not be available on port 6080"
  fi
fi

# ── 4. Start recorder-service ─────────────────────────────────────────────────
exec node dist/index.js
