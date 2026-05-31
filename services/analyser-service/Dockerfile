FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/analyser-service/package.json ./services/analyser-service/

RUN npm install

COPY packages/shared ./packages/shared
COPY services/analyser-service ./services/analyser-service

RUN npm run build --workspace=packages/shared

# Hand ownership to the built-in non-root node user (UID 1000)
RUN chown -R node:node /app

WORKDIR /app/services/analyser-service

USER node

EXPOSE 3008

CMD ["npx", "tsx", "src/index.ts"]
