FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# Copy server source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY extensions/ ./extensions/
WORKDIR /app/extensions/pm-graph
RUN npm ci --ignore-scripts --no-audit --no-fund
WORKDIR /app
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
COPY --from=builder /app/extensions ./extensions

RUN mkdir -p /app/projects && chown node:node /app/projects

ENV PORT=4000
ENV NODE_ENV=production
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'4000')+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

USER node

CMD ["node", "dist/server.js"]
