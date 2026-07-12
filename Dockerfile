FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# Copy server source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY extensions/ ./extensions/
RUN cd extensions/pm-graph && npm ci --ignore-scripts --no-audit --no-fund
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

RUN mkdir -p /app/projects

ENV PORT=4000
ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/server.js"]
