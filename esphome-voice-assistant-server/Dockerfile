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
COPY package.json ./

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
