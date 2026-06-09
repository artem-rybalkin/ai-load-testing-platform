#!/bin/sh
# Dev entrypoint: same X11 startup, then tsx watch instead of node dist/

# Clean up stale X11 lock files from previous container run
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

Xvfb :99 -screen 0 1280x960x24 -ac &

i=0
while [ ! -e /tmp/.X11-unix/X99 ] && [ $i -lt 50 ]; do
  sleep 0.2
  i=$((i+1))
done

if [ -e /tmp/.X11-unix/X99 ]; then
  # Use & instead of -bg — daemon fork is unreliable in Docker containers
  x11vnc -display :99 -nopw -listen 0.0.0.0 -forever -quiet > /dev/null 2>&1 &
  sleep 1  # give x11vnc time to bind port 5900 before websockify starts
  for d in /usr/share/webapps/novnc /usr/share/novnc; do
    if [ -d "$d" ]; then
      python3 -m websockify --web="$d" 6080 localhost:5900 &
      echo "noVNC started at http://0.0.0.0:6080"
      break
    fi
  done
else
  echo "Warning: Xvfb did not start"
fi

exec npx tsx watch src/index.ts
