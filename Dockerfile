FROM python:3.11-slim

# Install Node 22 for the OAuth sidecar (apt-delivered nodejs is old; use nodesource)
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps — copy metadata first for better layer caching
COPY pyproject.toml uv.lock README.md ./
RUN pip install --no-cache-dir uv \
 && uv pip install --system --no-cache .

# Copy the rest of the application
COPY nanobanana_mcp_server ./nanobanana_mcp_server
COPY oauth-server.js ./oauth-server.js

# Image I/O root — IMAGE_OUTPUT_DIR env (set in .env) must be inside this
# Docker volume so the clamp in validate_output_path / ensure_inside_image_root
# works correctly.
RUN mkdir -p /data/images
VOLUME ["/data/images"]

EXPOSE 8080

# OAuth sidecar spawns Python FastMCP as a child on port 8081 and exposes 8080
CMD ["node", "oauth-server.js"]
