FROM node:20-alpine

WORKDIR /app/services/ui

COPY services/ui/package.json ./
RUN npm install

COPY services/ui ./

# Vite bakes VITE_* vars into the bundle at build time — pass them as build args
ARG VITE_API_URL=http://localhost:3000
ARG VITE_RESULTS_URL=http://localhost:3004
ARG VITE_RECORDER_URL=http://localhost:3007
ARG VITE_API_KEY=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_RESULTS_URL=$VITE_RESULTS_URL
ENV VITE_RECORDER_URL=$VITE_RECORDER_URL
ENV VITE_API_KEY=$VITE_API_KEY

RUN npm run build

# Hand ownership to the built-in non-root node user (UID 1000)
RUN chown -R node:node /app

USER node

EXPOSE 3006

CMD ["npx", "vite", "preview", "--port", "3006", "--host", "0.0.0.0"]
