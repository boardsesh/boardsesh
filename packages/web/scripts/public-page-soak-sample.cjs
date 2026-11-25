// Test-only preload. Never copied into the production image.
const http = require('node:http');
const v8 = require('node:v8');

const originalFetch = global.fetch;
global.fetch = (input, ...arguments_) => {
  const requested = typeof input === 'string' || input instanceof URL ? input : input.url;
  const hostname = new URL(requested).hostname;
  const localHosts = ['localhost', '127.0.0.1', '[::1]'];
  if (process.env.PUBLIC_PAGE_SOAK_ALLOW_DOCKER_HOST === '1') localHosts.push('host.docker.internal');
  if (!localHosts.includes(hostname)) {
    return Promise.reject(new Error('The isolated public-page soak refuses non-loopback HTTP fetches'));
  }
  return originalFetch(input, ...arguments_);
};

process.on('message', (message) => {
  if (message?.type !== 'public-page-soak-sample') return;
  if (typeof global.gc !== 'function') throw new Error('The isolated soak needs --expose-gc');
  const beforeGcHeapUsedBytes = v8.getHeapStatistics().used_heap_size;
  if (message.forceGc) global.gc();
  const heap = v8.getHeapStatistics();
  const guard = http[Symbol.for('boardsesh.public-page-load-guard')];
  process.send?.({
    type: 'public-page-soak-sample',
    timestamp: Date.now(),
    forcedGc: Boolean(message.forceGc),
    beforeGcHeapUsedBytes,
    heapUsedBytes: heap.used_heap_size,
    heapLimitBytes: heap.heap_size_limit,
    rssBytes: process.memoryUsage().rss,
    guard: guard?.getStats(),
  });
});
