FROM node:20-alpine
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
CMD ["node", "-e", "console.log('worker-client placeholder running'); setInterval(()=>{},1000)"]