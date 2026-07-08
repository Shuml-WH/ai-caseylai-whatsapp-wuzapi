FROM asternic/wuzapi:latest

# Install curl and python3 for relay and healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download cloudflared Linux binary
RUN curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" \
    -o /app/cloudflared \
    && chmod +x /app/cloudflared

# Copy relay and entrypoint
COPY relay.py /app/relay.py
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create volume mount point for persistent data
RUN mkdir -p /app/dbdata

# Expose ports
# 8080 - wuzapi
# 3100 - relay
EXPOSE 8080 3100

# Healthcheck against relay (no auth required)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3100/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
