FROM node:22-slim AS builder
WORKDIR /app

# Install pm-cli globally + fix shebang path
RUN npm install -g @unbrained/pm-cli@latest && \
    (test -f /usr/bin/node || ln -s $(which node) /usr/bin/node)

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app

# Install pm-cli globally in runtime stage
RUN npm install -g @unbrained/pm-cli@latest && \
    # pm-cli shebang uses /usr/bin/node; create symlink if needed
    (test -f /usr/bin/node || ln -s $(which node) /usr/bin/node)

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY public/ ./public/

RUN mkdir -p /app/projects

ENV PORT=4000
ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/server.js"]
