FROM node:20-alpine

WORKDIR /app/services/ui

COPY services/ui/package.json ./
RUN npm install

COPY services/ui ./

ENV NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_RESULTS_URL=http://localhost:3004
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

EXPOSE 3006

CMD ["npx", "next", "start", "-p", "3006"]