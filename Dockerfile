# DUTY HUB — сервер приложения.
# Состояние (SQLite + загруженные фото) живёт в одном томе /app/data,
# поэтому приложение можно поднимать на любом хостинге с постоянным диском.
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DUTYHUB_DATA=/app/data \
    DUTYHUB_UPLOADS=/app/data/uploads

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /app/data/uploads && chown -R node:node /app

USER node
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
