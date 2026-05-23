#!/bin/sh
# Dev entrypoint: same X11 startup, then tsx watch instead of node dist/

Xvfb :99 -screen 0 1280x800x24 -ac &

i=0
while [ ! -e /tmp/.X11-unix/X99 ] && [ $i -lt 50 ]; do
  sleep 0.2
  i=$((i+1))
done

if [ -e /tmp/.X11-unix/X99 ]; then
  x11vnc -display :99 -nopw -listen 0.0.0.0 -forever -quiet -bg 2>/dev/null || true
  for d in /usr/share/webapps/novnc /usr/share/novnc; do
    if [ -d "$d" ]; then
      python3 -m websockify --web="$d" 6080 localhost:5900 &
      break
    fi
  done
else
  echo "Warning: Xvfb did not start"
fi

exec npx tsx watch src/index.ts
