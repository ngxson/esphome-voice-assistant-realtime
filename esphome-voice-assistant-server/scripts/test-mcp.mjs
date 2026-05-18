#!/usr/bin/env node
/**
 * Quick test for the Home Assistant MCP integration.
 * Usage: HASSIO_KEY=... HA_MCP_URL=http://... npm run test:mcp
 */

const MCP_URL = process.env.HA_MCP_URL;
const TOKEN   = process.env.HASSIO_KEY;

if (!MCP_URL) {
  console.error('HA_MCP_URL is not set');
  process.exit(1);
}

if (!TOKEN) {
  console.error('HASSIO_KEY is not set');
  process.exit(1);
}

async function mcpCall(method, params = {}) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

console.log(`MCP URL: ${MCP_URL}\n`);

// 1. List tools
console.log('=== tools/list ===');
const { tools } = await mcpCall('tools/list');
console.log(`Found ${tools.length} tools:`);
for (const t of tools) console.log(`  - ${t.name}: ${t.description}`);

// 2. GetLiveContext (full home state)
console.log('\n=== GetLiveContext (no filter) ===');
const ctx = await mcpCall('tools/call', { name: 'GetLiveContext', arguments: {} });
console.log(ctx.content[0]?.text ?? JSON.stringify(ctx));

// 3. GetLiveContext filtered by domain
console.log('\n=== GetLiveContext (domain: light) ===');
const lights = await mcpCall('tools/call', { name: 'GetLiveContext', arguments: { domain: 'light' } });
console.log(lights.content[0]?.text ?? JSON.stringify(lights));
