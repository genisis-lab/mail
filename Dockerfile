# ── Build ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries for common platforms; install a compiler
# toolchain only if none matches (e.g. unusual architectures).
RUN npm ci || (apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
      && rm -rf /var/lib/apt/lists/* && npm ci)
COPY . .
RUN npm run build && npm prune --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    SMTP_PORT=2525
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
# 3000 = web UI + API, 2525 = inbound SMTP (map host port 25 to it)
EXPOSE 3000 2525
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
