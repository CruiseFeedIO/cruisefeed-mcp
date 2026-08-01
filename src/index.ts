/**
 * CruiseFeed MCP server — a remote Model Context Protocol server (Cloudflare Worker)
 * that exposes the live CruiseFeed REST API (https://api.cruisefeed.io) as MCP tools.
 *
 * It is a thin, faithful wrapper: every tool maps to a real GET endpoint on the live
 * API (v1.3.0) and returns exactly what the API returns. No endpoint is invented.
 *
 * Auth: the caller's CruiseFeed API key is read from the `X-CruiseFeed-Key` header
 * (preferred) or `Authorization: Bearer <key>`. If neither is present, the Worker
 * falls back to its own `CRUISEFEED_API_KEY` secret (single-tenant / demo mode).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

interface Env {
  CRUISEFEED_MCP: DurableObjectNamespace;
  CRUISEFEED_API_KEY?: string; // Worker secret (fallback key for demo/self-hosted use)
  API_BASE?: string;           // defaults to https://api.cruisefeed.io
}

type Props = { apiKey?: string };

const DEFAULT_BASE = "https://api.cruisefeed.io";

/** GET a path on the live CruiseFeed API and return parsed JSON (or throw a clean error). */
async function apiGet(
  env: Env,
  props: Props | undefined,
  path: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const base = env.API_BASE || DEFAULT_BASE;
  const url = new URL(base + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const key = props?.apiKey || env.CRUISEFEED_API_KEY;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "cruisefeed-mcp/1.0",
  };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const res = await fetch(url.toString(), { headers });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.detail || (typeof body === "string" ? body : "") || res.statusText;
    if (res.status === 401) {
      throw new Error(
        `401 Unauthorized from CruiseFeed. Set a valid API key via the X-CruiseFeed-Key header (or Authorization: Bearer). ${msg}`,
      );
    }
    if (res.status === 429) throw new Error(`429 Rate limited / quota exceeded on your CruiseFeed key. ${msg}`);
    throw new Error(`CruiseFeed API ${res.status}: ${msg}`);
  }
  return body;
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

export class CruiseFeedMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "cruisefeed", version: "1.0.0" });

  async init() {
    const env = this.env;
    const props = () => this.props;

    // --- Cruises ---------------------------------------------------------
    this.server.registerTool(
      "search_cruises",
      {
        title: "Search cruises",
        description:
          "Search and filter cruise sailings across every line. Returns a page of sailings " +
          "(id, line, ship, title, dates, nights, ports, region, lead-in price). Upcoming " +
          "sailings only unless include_past is true. Use get_cruise for full itinerary + fares.",
        inputSchema: {
          cruise_line: z.string().optional().describe("Exact cruise line name, e.g. 'Carnival Cruise Line'. See list_cruise_lines."),
          ship_name: z.string().optional().describe("Ship name filter."),
          embark_port: z.string().optional().describe("Substring match on the embarkation port."),
          region: z.string().optional().describe("Substring match on the region, e.g. 'Caribbean'."),
          departure_from: z.string().optional().describe("Earliest departure date, YYYY-MM-DD."),
          departure_to: z.string().optional().describe("Latest departure date, YYYY-MM-DD."),
          min_price: z.number().optional().describe("Minimum lead-in price."),
          max_price: z.number().optional().describe("Maximum lead-in price."),
          min_nights: z.number().int().optional(),
          max_nights: z.number().int().optional(),
          round_trip: z.boolean().optional().describe("Only round-trip (or only one-way) sailings."),
          include_past: z.boolean().optional().describe("Include already-departed sailings (default false)."),
          sort: z.enum(["departure_date", "-departure_date", "price", "-price"]).optional(),
          limit: z.number().int().min(1).max(500).optional().describe("Max rows (default 50, max 500)."),
          offset: z.number().int().min(0).optional().describe("Rows to skip for pagination."),
        },
      },
      async (args) => {
        try {
          return ok(await apiGet(env, props(), "/v1/cruises", args));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "get_cruise",
      {
        title: "Get a cruise by id",
        description:
          "Full detail for one sailing: day-by-day itinerary, per-cabin-class fares, taxes, " +
          "onboard credit, booking/detail URLs, and the matched ship's specs when known.",
        inputSchema: { cruise_id: z.string().describe("The cruise id from search_cruises.") },
      },
      async ({ cruise_id }) => {
        try {
          return ok(await apiGet(env, props(), `/v1/cruises/${encodeURIComponent(cruise_id)}`));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "get_cruise_price_history",
      {
        title: "Get a cruise's price history",
        description:
          "Daily lead-in price / availability timeline for one sailing (only the days the value " +
          "changed). Use to detect price drops or trends for a specific cruise.",
        inputSchema: { cruise_id: z.string().describe("The cruise id from search_cruises.") },
      },
      async ({ cruise_id }) => {
        try {
          return ok(await apiGet(env, props(), `/v1/cruises/${encodeURIComponent(cruise_id)}/history`));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "list_price_changes",
      {
        title: "List recent price changes",
        description:
          "Cruises whose lead-in price moved between consecutive daily snapshots — the price-drop " +
          "feed. Each item has old/new price and the two snapshot dates.",
        inputSchema: {
          since: z.string().optional().describe("Only changes on/after this date, YYYY-MM-DD (default: last 30 days)."),
          cruise_line: z.string().optional(),
          limit: z.number().int().min(1).max(1000).optional().describe("Default 100, max 1000."),
          offset: z.number().int().min(0).optional(),
        },
      },
      async (args) => {
        try {
          return ok(await apiGet(env, props(), "/v1/changes", args));
        } catch (e) {
          return fail(e);
        }
      },
    );

    // --- Ships ----------------------------------------------------------
    this.server.registerTool(
      "search_ships",
      {
        title: "Search ships",
        description:
          "Search vessels by name / operator / flag state. Returns ship specs (tonnage, capacity, " +
          "decks, year built, builder, sister ships).",
        inputSchema: {
          q: z.string().optional().describe("Case-insensitive ship-name search, e.g. 'spirit'."),
          operator: z.string().optional().describe("Operator filter (partial match), e.g. 'Carnival'."),
          flag_state: z.string().optional().describe("Flag state (partial match), e.g. 'Bahamas'."),
          limit: z.number().int().min(1).max(500).optional().describe("Default 50, max 500."),
          offset: z.number().int().min(0).optional(),
        },
      },
      async (args) => {
        try {
          return ok(await apiGet(env, props(), "/v1/ships", args));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "get_ship",
      {
        title: "Get a ship by id",
        description: "One ship's full spec sheet by its source_id (IMO number, or slug when IMO is absent).",
        inputSchema: { ship_id: z.string().describe("The ship source_id (IMO) from search_ships.") },
      },
      async ({ ship_id }) => {
        try {
          return ok(await apiGet(env, props(), `/v1/ships/${encodeURIComponent(ship_id)}`));
        } catch (e) {
          return fail(e);
        }
      },
    );

    // --- Reference ------------------------------------------------------
    this.server.registerTool(
      "list_cruise_lines",
      { title: "List cruise lines", description: "All cruise line names in the catalogue (use as the cruise_line filter).", inputSchema: {} },
      async () => {
        try {
          return ok(await apiGet(env, props(), "/v1/cruise-lines"));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "list_ports",
      { title: "List departure ports", description: "All embarkation ports in the catalogue (use as the embark_port filter).", inputSchema: {} },
      async () => {
        try {
          return ok(await apiGet(env, props(), "/v1/ports"));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "get_stats",
      { title: "Catalogue stats", description: "Catalogue size (total + unique sailings) and when it was last updated.", inputSchema: {} },
      async () => {
        try {
          return ok(await apiGet(env, props(), "/v1/stats"));
        } catch (e) {
          return fail(e);
        }
      },
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);

    // Extract the caller's CruiseFeed key and pass it to the agent as props.
    const xkey = request.headers.get("x-cruisefeed-key") || undefined;
    const authz = request.headers.get("authorization") || "";
    const bearer = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, "").trim() : undefined;
    (ctx as unknown as { props: Props }).props = { apiKey: xkey || bearer };

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return CruiseFeedMCP.serve("/mcp", { binding: "CRUISEFEED_MCP" }).fetch(request, env, ctx);
    }
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return new Response(
        "CruiseFeed MCP server — connect an MCP client to /mcp (Streamable HTTP).\n" +
          "Auth: send your CruiseFeed key as the X-CruiseFeed-Key header.\n" +
          "Get a key + docs at https://cruisefeed.io\n",
        { headers: { "content-type": "text/plain" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
