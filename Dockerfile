# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install -g npm@10 && npm ci --unsafe-perm --no-audit --no-fund

# ── Runtime image ──────────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Use the built-in `node` user (UID 1000) — matches typical Linux deploy-user UID
# so bind-mounted ./data and ./logs are readable/writable without extra chmod steps.

# Copy app source
COPY --chown=node:node src/        ./src/
COPY --chown=node:node config/     ./config/
COPY --chown=node:node public/     ./public/
COPY --chown=node:node package.json ./

# Copy installed dependencies from deps stage
COPY --chown=node:node --from=deps /app/node_modules ./node_modules

# Create fallback dirs in case the bind mounts don't exist on host yet
RUN mkdir -p data/candles logs && chown -R node:node data logs

USER node

EXPOSE 3001

# Healthcheck: dashboard API must respond
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health > /dev/null || exit 1

CMD ["node", "src/main.js"]

