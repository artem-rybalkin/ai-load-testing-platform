FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/tracing/package.json ./packages/tracing/
COPY services/ai-service/package.json ./services/ai-service/

RUN --mount=type=cache,target=/root/.npm npm install

COPY packages/shared ./packages/shared
COPY packages/tracing ./packages/tracing
COPY services/ai-service ./services/ai-service

RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/tracing
RUN npm run build --workspace=@alt/ai-service

# Hand ownership to the built-in non-root node user (UID 1000)
RUN chown -R node:node /app

WORKDIR /app/services/ai-service

USER node

EXPOSE 3001

CMD ["node", "dist/index.js"]
