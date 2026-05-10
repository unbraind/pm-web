FROM node:22-slim AS builder
WORKDIR /app
ARG PM_CLI_CACHE_BUST=latest

# Install pm-cli globally + fix shebang path
RUN echo "pm-cli cache bust: ${PM_CLI_CACHE_BUST}" && npm install -g @unbrained/pm-cli@latest && \
    (test -f /usr/bin/node || ln -s $(which node) /usr/bin/node)

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

# Copy server source and build
COPY tsconfig.json ./
COPY src/ ./src/
# Copy entire public directory for frontend build
COPY public/ ./public/
# Build both server and frontend
RUN npm run build && cd public && npx tsc

FROM node:22-slim AS runtime
WORKDIR /app
ARG PM_CLI_CACHE_BUST=latest

# Install pm-cli globally in runtime stage
RUN echo "pm-cli cache bust: ${PM_CLI_CACHE_BUST}" && npm install -g @unbrained/pm-cli@latest && \
    (test -f /usr/bin/node || ln -s $(which node) /usr/bin/node)

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

RUN mkdir -p /app/projects

ENV PORT=4000
ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/server.js"]
