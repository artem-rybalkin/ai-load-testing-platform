FROM node:20-alpine

# ── System deps: Chromium + Xvfb virtual display + noVNC browser viewer ───────
# `novnc` pulls in the `websockify` apk package (and python3) as a transitive
# dependency — no separate python3/py3-pip/pip install needed (saves ~15-20MB
# of py3-pip/setuptools/packaging that pip would otherwise require).
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    xvfb \
    x11vnc \
    novnc

# Pre-create the X11 Unix socket directory with correct sticky-bit permissions
# (required because Xvfb runs as non-root and cannot create /tmp/.X11-unix itself)
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Tell puppeteer-core to skip its own Chromium download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV DISPLAY=:99

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/recorder-service/package.json ./services/recorder-service/

RUN --mount=type=cache,target=/root/.npm npm install

COPY packages/shared ./packages/shared
COPY services/recorder-service ./services/recorder-service

# Build shared types first, then the recorder-service itself
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=services/recorder-service

# Hand ownership to the built-in non-root node user (UID 1000).
# Chromium works correctly as non-root with --no-sandbox flags.
RUN chown -R node:node /app

COPY services/recorder-service/docker-entrypoint.sh /docker-entrypoint.sh
RUN sed -i 's/\r$//' /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh

WORKDIR /app/services/recorder-service

USER node

EXPOSE 3007 6080

CMD ["/docker-entrypoint.sh"]
