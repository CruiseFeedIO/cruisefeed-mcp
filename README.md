# CruiseFeed MCP server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
live **CruiseFeed API** (`https://api.cruisefeed.io`) as tools, so AI agents (Claude, and any
MCP-capable app) can search cruises, pull itineraries and fares, track price drops, and read
ship specs directly.

It runs as a **Cloudflare Worker** (Streamable HTTP transport) and is a thin, faithful wrapper:
every tool maps to a real GET endpoint on the live API — nothing is invented.

## Tools

| Tool | Wraps | Purpose |
|------|-------|---------|
| `search_cruises` | `GET /v1/cruises` | filter sailings by line, ship, port, region, dates, price, nights, round-trip |
| `get_cruise` | `GET /v1/cruises/{id}` | full sailing: itinerary, per-cabin fares, taxes, matched ship |
| `get_cruise_price_history` | `GET /v1/cruises/{id}/history` | daily price timeline (change days only) |
| `list_price_changes` | `GET /v1/changes` | recent fare moves — the price-drop feed |
| `search_ships` | `GET /v1/ships` | vessels by name / operator / flag state, with specs |
| `get_ship` | `GET /v1/ships/{id}` | one ship's full spec sheet (by IMO) |
| `list_cruise_lines` | `GET /v1/cruise-lines` | reference facet |
| `list_ports` | `GET /v1/ports` | reference facet |
| `get_stats` | `GET /v1/stats` | catalogue size + freshness |

## Authentication

Each caller supplies their **own** CruiseFeed API key (get one at https://cruisefeed.io). The
server reads it, in order of preference, from:

1. the `X-CruiseFeed-Key` request header (recommended), or
2. `Authorization: Bearer <key>`, or
3. the Worker's own `CRUISEFEED_API_KEY` secret (single-tenant / demo fallback).

The key is forwarded to the API as `Authorization: Bearer`; the API enforces the plan's monthly
quota and rate limits. The server stores nothing.

## Develop & test locally

```bash
cd cruisefeed-mcp
npm install
# .dev.vars holds a CRUISEFEED_API_KEY for local runs (gitignored). Create it if missing:
#   echo "CRUISEFEED_API_KEY=cf_live_..." > .dev.vars
npm run dev          # wrangler dev -> http://localhost:8787/mcp
```

Inspect the tools with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
# then connect to http://localhost:8787/mcp (Streamable HTTP)
```

## Deploy (Cloudflare)

Live at **`https://mcp.cruisefeed.io/mcp`**.

```bash
npx wrangler login       # one-time (if not already authenticated)
npm run deploy           # -> https://mcp.cruisefeed.io/mcp
```

**No `CRUISEFEED_API_KEY` secret is set in production** — the server is purely bring-your-own-key:
every caller must send their own key, and keyless calls return 401. (The env-key fallback in the
code only activates if you choose to `wrangler secret put CRUISEFEED_API_KEY` for a private,
single-tenant instance.) To move it to a custom domain like `mcp.cruisefeed.io`, add a Worker route.

## Connect from Claude

Add the live URL as a remote MCP server and set your CruiseFeed key as a header:

```json
{
  "mcpServers": {
    "cruisefeed": {
      "url": "https://mcp.cruisefeed.io/mcp",
      "headers": { "X-CruiseFeed-Key": "cf_live_your_key" }
    }
  }
}
```
