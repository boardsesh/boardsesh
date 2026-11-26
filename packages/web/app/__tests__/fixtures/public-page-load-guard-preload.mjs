import { createServer } from 'node:http';
import * as http from 'node:http';
import { createRequire } from 'node:module';
const { installPublicPageLoadGuard } = createRequire(import.meta.url)('../../../scripts/public-page-load-guard.cjs');
const originalCreateServer = createServer;
const guard = installPublicPageLoadGuard();
const installedOnce = installPublicPageLoadGuard() === guard;
const namedImportUpdated = createServer !== originalCreateServer;
const server = createServer({ headersTimeout: 12_345 }, (_request, response) => response.end('render'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
// The process always starts above an intentionally tiny heap budget in this fixture.
const originalHeap = createRequire(import.meta.url)('node:v8').getHeapStatistics;
createRequire(import.meta.url)('node:v8').getHeapStatistics = () => ({ used_heap_size: 71, heap_size_limit: 100 });
const status = await new Promise((resolve, reject) => {
  http
    .get({ hostname: '127.0.0.1', port: address.port, path: '/setter/person' }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    })
    .once('error', reject);
});
createRequire(import.meta.url)('node:v8').getHeapStatistics = originalHeap;
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
guard.close();
process.stdout.write(
  JSON.stringify({ installedOnce, namedImportUpdated, status, headersTimeout: server.headersTimeout }),
);
