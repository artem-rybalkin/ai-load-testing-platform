FROM node:20-alpine

WORKDIR /app/services/ui

COPY services/ui/package.json ./
RUN npm install

COPY services/ui ./

ENV NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_RESULTS_URL=http://localhost:3004
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Hand ownership to the built-in non-root node user (UID 1000).
# The .next build output is created as root above; chown it so the
# node user can serve the app at runtime.
RUN chown -R node:node /app

USER node

EXPOSE 3006

CMD ["npx", "next", "start", "-p", "3006"]
