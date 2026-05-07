FROM node:20-alpine

# Системні залежності для Chromium
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Говоримо Puppeteer використовувати встановлений Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/worker-client/package.json ./services/worker-client/

RUN npm install

COPY packages/shared ./packages/shared
COPY services/worker-client ./services/worker-client

RUN npm run build --workspace=packages/shared

WORKDIR /app/services/worker-client

EXPOSE 3003

CMD ["npx", "tsx", "src/index.ts"]