#!/usr/bin/with-contenv bashio

bashio::log.info "Starting ESPHome Voice Assistant Realtime Server..."
exec node /app/dist/index.js
