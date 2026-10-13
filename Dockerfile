# OPERA room-status demo: Node backend (Express + SSE + OHIP façade) serving the built web UI.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=3001 DATA_FILE=/data/state.json NODE_ENV=production
VOLUME ["/data"]
EXPOSE 3001
CMD ["npx", "tsx", "apps/server/src/index.ts"]
