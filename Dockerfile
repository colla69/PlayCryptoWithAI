# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install -g npm@10 && npm ci --unsafe-perm --no-audit --no-fund

# ── Runtime image ──────────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Non-root user for security
RUN addgroup -S bot && adduser -S bot -G bot

# Copy app source
COPY --chown=bot:bot src/        ./src/
COPY --chown=bot:bot config/     ./config/
COPY --chown=bot:bot public/     ./public/
COPY --chown=bot:bot package.json ./

# Copy installed dependencies from deps stage
COPY --chown=bot:bot --from=deps /app/node_modules ./node_modules

# Create volume mount points with correct ownership
# data/ and logs/ are mounted from Docker named volumes at runtime
RUN mkdir -p data/candles logs && chown -R bot:bot data logs

USER bot

EXPOSE 3001

# Healthcheck: dashboard API must respond
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/summary > /dev/null || exit 1

CMD ["node", "src/main.js"]

