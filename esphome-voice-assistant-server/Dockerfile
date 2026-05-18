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

# Register as an s6 service so s6-overlay stays as PID 1
RUN mkdir -p /etc/services.d/voice-assistant
COPY run.sh /etc/services.d/voice-assistant/run
RUN chmod +x /etc/services.d/voice-assistant/run
