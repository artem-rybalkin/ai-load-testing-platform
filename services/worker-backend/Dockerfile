FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/worker-backend/package.json ./services/worker-backend/
RUN npm install
COPY packages/shared ./packages/shared
COPY services/worker-backend ./services/worker-backend
RUN npm run build --workspace=packages/shared
WORKDIR /app/services/worker-backend
EXPOSE 3002
CMD ["node", "-e", "console.log('worker-backend placeholder running'); setInterval(()=>{},1000)"]