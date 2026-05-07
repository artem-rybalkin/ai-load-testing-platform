FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/ai-service/package.json ./services/ai-service/

RUN npm install

COPY packages/shared ./packages/shared
COPY services/ai-service ./services/ai-service

RUN npm run build --workspace=packages/shared

WORKDIR /app/services/ai-service

EXPOSE 3001

CMD ["npx", "tsx", "src/index.ts"]