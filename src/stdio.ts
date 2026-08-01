/**
 * stdio entrypoint for the CruiseFeed MCP server.
 *
 * The primary server is a remote Cloudflare Worker (Streamable HTTP) at
 * https://mcp.cruisefeed.io/mcp. This thin stdio bridge exposes the same 9 tools
 * over stdio, so it can run in a local MCP client (Claude Desktop, etc.) or in a
 * container for build/introspection checks. It forwards every request to the
 * hosted endpoint; `tools/list` works without a key, and any request that needs a
 * key uses CRUISEFEED_API_KEY from the environment.
 *
 * Env:
 *   CRUISEFEED_API_KEY   optional; forwarded as the X-CruiseFeed-Key header
 *   CRUISEFEED_MCP_URL   optional; override the hosted endpoint
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const REMOTE_URL = process.env.CRUISEFEED_MCP_URL || "https://mcp.cruisefeed.io/mcp";

async function main() {
  const headers: Record<string, string> = {};
  if (process.env.CRUISEFEED_API_KEY) headers["X-CruiseFeed-Key"] = process.env.CRUISEFEED_API_KEY;

  // Client -> hosted CruiseFeed MCP server (Streamable HTTP)
  const client = new Client({ name: "cruisefeed-stdio-bridge", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(REMOTE_URL), { requestInit: { headers } }));

  // Server <- local stdio client, forwarding to the hosted server
  const server = new Server({ name: "cruisefeed", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await client.listTools();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return await client.callTool({
      name: req.params.name,
      arguments: req.params.arguments ?? {},
    });
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`cruisefeed-mcp stdio bridge -> ${REMOTE_URL}\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
