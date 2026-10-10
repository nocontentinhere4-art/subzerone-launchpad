# SUBZERONE launchpad: one container runs the web process and one worker (tools/start.sh starts the server, waits
# for /healthz, then the worker, and forwards SIGTERM). The city client's Vite build is copied in from ./city-dist (tools/deploy-railway.sh fills it) and served
# same-origin via CITY_DIST. The database, uploads and backups live on the volume mounted at DATA_DIR (/data).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    CITY_DIST=/app/city-dist

COPY package.json package-lock.json ./
# --ignore-scripts: the pump SDK's optional native bigint binding falls back to pure JS (docs/DEPLOY.md)
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY docs ./docs
COPY scripts ./scripts
COPY city-dist ./city-dist
COPY tools/start.sh ./tools/start.sh

# Runs as root: Railway mounts the volume at /data owned by root, so a non-root USER cannot create the database there.
RUN mkdir -p /data && chmod +x tools/start.sh

EXPOSE 8787
# web server first (migrations), then the worker; see tools/start.sh
CMD ["bash", "tools/start.sh"]
