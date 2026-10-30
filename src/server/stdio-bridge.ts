/**
 * Lets Claude Desktop use a local Trellis. Claude Desktop starts this as a
 * stdio MCP server; it forwards every message to Trellis's HTTP MCP endpoint
 * with an API key.
 *
 *   TRELLIS_URL=http://localhost:3000 TRELLIS_API_KEY=trk_... node dist/server/stdio-bridge.js
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const baseUrl = process.env.TRELLIS_URL ?? 'http://localhost:3000';
const apiKey = process.env.TRELLIS_API_KEY;

if (!apiKey) {
  console.error('Set TRELLIS_API_KEY to an API key from Trellis Settings.');
  process.exit(1);
}

const remote = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
  requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
});
const local = new StdioServerTransport();

local.onmessage = (message) => {
  remote.send(message).catch((err: Error) => {
    console.error(`[trellis] ${err.message}`);
    // Answer requests with an error so Claude does not wait forever.
    if ('id' in message && message.id !== undefined && 'method' in message) {
      void local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `Trellis is not reachable at ${baseUrl}: ${err.message}` } });
    }
  });
};
remote.onmessage = (message) => {
  void local.send(message);
};
remote.onerror = (err) => console.error(`[trellis] ${err.message}`);
local.onclose = () => {
  void remote.close().finally(() => process.exit(0));
};

await remote.start();
await local.start();
