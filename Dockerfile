# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 — deps: install production dependencies.
# Toolchain native (python3/make/g++) hanya fallback kalau better-sqlite3
# tidak punya prebuilt binary untuk platform ini; stage ini dibuang,
# jadi image final tetap ramping.
###############################################################################
FROM node:20-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# package-lock.json* : lock file mungkin belum ada — glob membuat COPY tetap valid.
COPY package.json package-lock.json* ./

RUN npm install --omit=dev && npm cache clean --force

###############################################################################
# Stage 2 — runtime: image final bersih, non-root, dengan healthcheck.
###############################################################################
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    DB_PATH=/data/zro-pool.db
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY server.js ./
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY public/ ./public/

# User `node` adalah user non-root bawaan image resmi Node.
# /data = lokasi SQLite (titik mount volume) supaya DB bertahan rebuild.
RUN mkdir -p /data \
    && chown -R node:node /app /data
USER node

VOLUME /data
EXPOSE 3600

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3600)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
