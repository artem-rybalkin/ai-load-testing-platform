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

WORKDIR /app/services/api-service

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]