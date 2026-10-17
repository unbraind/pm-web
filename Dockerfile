FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS builder
WORKDIR /app

# The held pm-brand release is pinned to a public Git commit at build time.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && npm install --global npm@11.17.0 --ignore-scripts --no-audit --no-fund

COPY package.json package-lock.json* ./
RUN npm_config_ignore_scripts=true npm ci --ignore-scripts --no-audit --no-fund

# Copy server source and build
COPY tsconfig.json ./
COPY scripts/build-brand.ts scripts/brand-token-data.ts ./scripts/
COPY src/ ./src/
# Copy entire public directory for frontend build
COPY public/ ./public/
# Build both server and frontend
RUN npm run build

FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS runtime
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

RUN mkdir -p /app/projects && chown node:node /app/projects

ENV PORT=4000
ENV NODE_ENV=production
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'4000')+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

USER node

CMD ["node", "dist/server.js"]
