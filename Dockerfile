# Optional: run Wren on your own server. This image runs the same Cloudflare
# Worker in workerd (Cloudflare's open-source Workers runtime); there is no
# separate server code. Most people should deploy to Cloudflare instead
# (`npm run setup`), which needs no Docker at all.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV WRANGLER_SEND_METRICS=false \
    DATA_DIR=/data \
    PORT=8787

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx vite build

VOLUME /data
EXPOSE 8787
CMD ["node", "scripts/serve.mjs"]
