FROM node:22-alpine

# Install k6
RUN apk add --no-cache curl bash
RUN curl -fsSL https://dl.k6.io/key.gpg | cat > /etc/apk/keys/k6.rsa.pub 2>/dev/null || true
RUN echo "https://dl.k6.io/rpm/stable" >> /etc/apk/repositories || true
RUN apk add --no-cache --repository https://dl.k6.io/rpm/stable k6 || \
    (wget -qO /tmp/k6.tar.gz https://github.com/grafana/k6/releases/download/v0.54.0/k6-v0.54.0-linux-amd64.tar.gz && \
     tar -xzf /tmp/k6.tar.gz -C /tmp && \
     mv /tmp/k6-v0.54.0-linux-amd64/k6 /usr/local/bin/k6 && \
     rm -rf /tmp/k6*)

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/tracing/package.json ./packages/tracing/
COPY services/worker-backend/package.json ./services/worker-backend/

RUN --mount=type=cache,target=/root/.npm npm install

COPY packages/shared ./packages/shared
COPY packages/tracing ./packages/tracing
COPY services/worker-backend ./services/worker-backend

RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/tracing
RUN npm run build --workspace=@alt/worker-backend

# Hand ownership to the built-in non-root node user (UID 1000).
# k6 at /usr/local/bin/k6 is world-executable; per-test run dirs are
# created inside /tmp which is world-writable, so no extra chown needed.
RUN chown -R node:node /app

WORKDIR /app/services/worker-backend

USER node

EXPOSE 3002

CMD ["node", "dist/index.js"]
