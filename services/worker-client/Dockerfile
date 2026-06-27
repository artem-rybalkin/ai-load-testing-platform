FROM node:20-alpine

# System dependencies for Chromium
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Tell Puppeteer to use the system-installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/tracing/package.json ./packages/tracing/
COPY services/worker-client/package.json ./services/worker-client/

RUN --mount=type=cache,target=/root/.npm npm install

COPY packages/shared ./packages/shared
COPY packages/tracing ./packages/tracing
COPY services/worker-client ./services/worker-client

RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/tracing
RUN npm run build --workspace=@alt/worker-client

# Hand ownership to the built-in non-root node user (UID 1000).
# Running Chromium as non-root is the correct approach; the existing
# --no-sandbox / --disable-setuid-sandbox launch flags remain valid.
RUN chown -R node:node /app

WORKDIR /app/services/worker-client

USER node

EXPOSE 3003

CMD ["node", "dist/index.js"]
