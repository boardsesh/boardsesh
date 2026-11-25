const assert = require('node:assert/strict');
const http = require('node:http');
const v8 = require('node:v8');
const { createPublicPageLoadGuard } = require('../../../scripts/public-page-load-guard.cjs');

async function run() {
  assert.equal(typeof global.gc, 'undefined', 'Recovery must use natural GC');
  const guard = createPublicPageLoadGuard({ reportIntervalMs: 0 });
  let held = [];
  while (v8.getHeapStatistics().used_heap_size / v8.getHeapStatistics().heap_size_limit < 0.72) {
    held.push(Array.from({ length: 256 * 1024 }, () => 7));
  }
  const retained = Symbol.for('boardsesh.pressure-fixture-holds');
  const allocationProbe = Symbol.for('boardsesh.pressure-fixture-allocation');
  global[retained] = held;
  const server = http.createServer(guard.wrap((_request, response) => response.end('ok')));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const sample = () =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/setter/person' }, (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        })
        .once('error', reject);
    });
  try {
    const initialStatus = await sample();
    delete global[retained];
    held = [];
    let recoveredAfterMs = null;
    let allocationCount = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 35_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Continue a small, bounded allocation workload after dropping the large
      // retained set. V8 need not schedule a major collection while idle. Keep
      // only the latest 2 MiB array alive; never force a collection with gc().
      global[allocationProbe] = Array.from({ length: 256 * 1024 }, () => 9);
      allocationCount += 1;
      if ((await sample()) === 200) {
        recoveredAfterMs = Date.now() - startedAt;
        break;
      }
    }
    const heap = v8.getHeapStatistics();
    process.stdout.write(
      JSON.stringify({
        initialStatus,
        recoveredAfterMs,
        allocationCount,
        heapFraction: heap.used_heap_size / heap.heap_size_limit,
        stats: guard.getStats(),
      }),
    );
  } finally {
    delete global[retained];
    delete global[allocationProbe];
    guard.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
