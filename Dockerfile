# Runs the CruiseFeed MCP server as a stdio server (bridging to the hosted
# endpoint) under mcp-proxy, which exposes it over HTTP/SSE for introspection.
# The primary deployment is the Cloudflare Worker (see wrangler.jsonc); this
# image exists for local runs and directory build/introspection checks.
FROM node:22-bookworm-slim

WORKDIR /app

# Install runtime deps (tsx + MCP SDK are needed to run the stdio bridge)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# mcp-proxy wraps the stdio server and exposes it over HTTP/SSE (:8080)
RUN npm install -g mcp-proxy@6.4.3

COPY . .

ENV CRUISEFEED_MCP_URL=https://mcp.cruisefeed.io/mcp
EXPOSE 8080

CMD ["mcp-proxy", "--", "npx", "tsx", "src/stdio.ts"]
