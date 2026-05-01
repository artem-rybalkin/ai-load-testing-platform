FROM node:20-alpine

WORKDIR /app


COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/api-service/package.json ./services/api-service/

# Встановлюємо залежності
RUN npm install

# Копіюємо вихідний код
COPY packages/shared ./packages/shared
COPY services/api-service ./services/api-service

# Білдимо shared спочатку
RUN npm run build --workspace=packages/shared

WORKDIR /app/services/api-service

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]