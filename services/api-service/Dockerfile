FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/api-service/package.json ./services/api-service/

RUN npm install

COPY packages/shared ./packages/shared
COPY services/api-service ./services/api-service

RUN npm run build --workspace=packages/shared

# Hand ownership to the built-in non-root node user (UID 1000)
RUN chown -R node:node /app

WORKDIR /app/services/api-service

USER node

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]
