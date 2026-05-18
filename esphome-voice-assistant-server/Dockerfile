ARG BUILD_FROM

# --- Build stage ---
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# --- Runtime stage ---
FROM $BUILD_FROM

RUN apk add --no-cache nodejs

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

COPY run.sh /run.sh
RUN chmod +x /run.sh

# tini is included in the HA base images; use it as PID 1 (init: false in config.yaml
# disables s6-overlay so we own the entrypoint)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/run.sh"]
