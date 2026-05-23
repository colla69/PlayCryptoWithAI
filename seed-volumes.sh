#!/usr/bin/.env sh
# seed-volumes.sh — copy local candle data & runtime files into Docker named volumes.
# Run ONCE after first `docker compose build` on a new server, or after pulling
# a fresh clone that has candle data committed to git.
#
# Usage:
#   ./seed-volumes.sh
#
set -e

COMPOSE_PROJECT=$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | tr -d '-_')

echo "Seeding candle-data volume…"
docker run --rm \
  -v "$(pwd)/data/candles":/src \
  -v "${COMPOSE_PROJECT}_candle-data":/dst \
  alpine sh -c "cp -a /src/. /dst/"

echo "Seeding runtime-data volume (dashboard_persist, fearGreed…)"
docker run --rm \
  -v "$(pwd)/data":/src \
  -v "${COMPOSE_PROJECT}_runtime-data":/dst \
  alpine sh -c "cp -a /src/. /dst/"

echo "Seeding trade-logs volume (trades.csv…)"
docker run --rm \
  -v "$(pwd)/logs":/src \
  -v "${COMPOSE_PROJECT}_trade-logs":/dst \
  alpine sh -c "cp -a /src/. /dst/"

echo "✅  Volumes seeded. You can now run: docker compose up -d"
