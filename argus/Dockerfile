## ----- Build Stage -----
FROM node:22-alpine AS builder

WORKDIR /app

# Install build deps for better-sqlite3 (native addon)
RUN apk add --no-cache python3 make g++

# Copy package files first (layer cache)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

## ----- Production Stage -----
FROM node:22-alpine

WORKDIR /app

# Runtime deps for better-sqlite3
RUN apk add --no-cache libstdc++

# Copy package files and install production deps only
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps \
    && npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create data + logs dirs
RUN mkdir -p /app/data /app/logs

# Non-root user
RUN addgroup -g 1001 -S argus && \
    adduser -S argus -u 1001 -G argus && \
    chown -R argus:argus /app
USER argus

EXPOSE 3000

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "dist/server.js"]
