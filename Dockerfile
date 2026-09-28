# EODView production image: Bun serves the API, /ws, /mcp and the built client on :3001.
FROM oven/bun:1.1.36 AS deps
WORKDIR /app
COPY package.json bun.lockb ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN bun install --frozen-lockfile

# Vite 8 needs Node (util.parseEnv is missing in Bun 1.1.36), so the client is built with Node 22.
FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app ./
COPY shared shared
COPY client client
RUN cd client && node ../node_modules/vite/bin/vite.js build

FROM oven/bun:1.1.36-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    EODVIEW_DATA_DIR=/data
COPY package.json bun.lockb ./
COPY shared shared
COPY server server
COPY client/package.json client/
RUN bun install --frozen-lockfile --production && mkdir -p /data && chown -R bun:bun /data
COPY --from=build /app/client/dist client/dist
USER bun
EXPOSE 3001
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "server/src/index.ts"]
