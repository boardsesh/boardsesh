import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const packageRoot = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'boardsesh-mcp-smoke-'));
const profile = path.join(temporaryRoot, 'profile');
const client = new Client({ name: 'boardsesh-package-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(packageRoot, 'dist/cli.js'), 'serve', '--data-dir', profile],
  cwd: tmpdir(),
  stderr: 'pipe',
});
// Always drain stderr; it must never be interleaved with MCP protocol messages.
transport.stderr?.on('data', () => {});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 9);
  assert.equal(tools.find((tool) => tool.name === 'cancel_workout')?.annotations?.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === 'search_logbook')?.annotations?.readOnlyHint, true);
  // Opening the writer creates/migrates SQLite before the expected login error.
  const sync = await client.callTool({ name: 'sync_logbook', arguments: {} });
  assert.equal(sync.isError, true);
  assert.equal(sync.structuredContent.result.error.code, 'login_required');
  const status = await client.callTool({ name: 'get_connection_status', arguments: {} });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.result.connected, false);
  const history = await client.callTool({ name: 'search_logbook', arguments: {} });
  assert.equal(history.isError, true);
  assert.match(history.structuredContent.result.error.message, /login/i);
  process.stdout.write('Packaged MCP: stdio negotiation, nine tools, native SQLite and logged-out behavior passed.\n');
} finally {
  await client.close();
  await transport.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
