# Pattern: Non-root Docker Container (node:20-alpine)

## Context
Used in: all 6 service Dockerfiles

## Problem
Running as root in Docker is a security risk. Node.js alpine images have a built-in `node` user (UID 1000) that should be used.

## Solution

```dockerfile
FROM node:20-alpine

WORKDIR /app

# All root-level operations first (apk installs, npm install, build)
RUN apk add --no-cache <deps>
COPY package*.json ./
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY . .
RUN npm run build

# Fix ownership for the node user, then switch
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Exceptions / Special Cases
- `worker-backend`: k6 binary is at `/usr/local/bin/k6` (world-executable); per-test run dirs in `/tmp` (world-writable) — no extra permissions needed
- `worker-client`: Chromium works as non-root with `--no-sandbox --disable-setuid-sandbox` launch flags
- `recorder-service`: Same Chromium flags; Xvfb display server is started by entrypoint script before switching to node user

## Key Rules
- NEVER use `USER node` before all root-level operations complete
- Use `--ignore-scripts && npm rebuild esbuild` to avoid parallel build race conditions
- `chown -R node:node /app` must run as root (before USER node)
- Dist/ built as root then chowned — node user only needs read access to serve it
