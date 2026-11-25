const http = require('node:http');
const { syncBuiltinESMExports } = require('node:module');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const v8 = require('node:v8');

const INSTALLED = Symbol.for('boardsesh.public-page-load-guard');
const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_TIMEOUT_MS = 10_000;
const REPORT_INTERVAL_MS = 30_000;

function positiveInteger(raw, fallback, maximum) {
  if (!/^\d+$/.test(String(raw ?? ''))) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

/** Classify paths rather than headers: neither RSC nor a forged browser may bypass the budget. */
function isPublicCatalogueRequest(method, requestUrl) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  try {
    let pathname = new URL(requestUrl ?? '/', 'http://localhost').pathname;
    for (let decoding = 0; decoding < 2; decoding += 1) {
      // Next matches dynamic segments before decoding their values. Preserve
      // that shape too: an encoded slash in a setter/climb name is still one leaf.
      if (matchesPublicCataloguePath(pathname)) return true;
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
    return matchesPublicCataloguePath(pathname);
  } catch {
    // Malformed paths do no expensive rendering, but must not evade the cap.
    return true;
  }
}

function matchesPublicCataloguePath(pathname) {
  const segments = pathname.toLowerCase().replaceAll('\\', '/').split('/').filter(Boolean);
  // Accept every locale-shaped prefix so a newly added locale inherits protection.
  if (/^[a-z]{2}(?:-[a-z]{2})?$/.test(segments[0] ?? '')) segments.shift();
  const [family] = segments;
  if (
    ['api', 'auth', 'admin', 'settings', 'app', '_next', 'assets', 'images', 'icons', 'fonts', 'brand'].includes(family)
  )
    return false;
  if (['setter', 'profile', 'gym'].includes(family)) return segments.length === 2;
  if (family === 'playlists') return segments.length <= 2;
  if (family === 'gyms') return segments.length === 1;
  if (family === 'b') {
    return (
      segments.length === 2 ||
      (segments.length === 4 && segments[3] === 'list') ||
      (segments.length === 5 && segments[3] === 'view')
    );
  }
  return (segments.length === 6 && segments[5] === 'list') || (segments.length === 7 && segments[5] === 'view');
}

function sendUnavailable(response) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  // Do not carry a middleware TTL, cookies, or a partial representation into this response.
  for (const header of response.getHeaderNames()) response.removeHeader(header);
  response.writeHead(503, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': '0',
    'Cache-Control': 'no-store',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
    'Retry-After': '5',
  });
  response.end();
}

function createPublicPageLoadGuard(options = {}) {
  const maximum =
    options.maxConcurrency ??
    positiveInteger(process.env.WEB_PUBLIC_RENDER_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY, 256);
  const timeoutMs =
    options.timeoutMs ?? positiveInteger(process.env.WEB_PUBLIC_RENDER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 60_000);
  const readHeap =
    options.readHeap ??
    (() => {
      const heap = v8.getHeapStatistics();
      return { used: heap.used_heap_size, limit: heap.heap_size_limit };
    });
  const now = options.now ?? Date.now;
  const log = options.log ?? ((metrics) => console.info('[PublicPageLoadGuard]', JSON.stringify(metrics)));
  const counters = {
    active: 0,
    peakActive: 0,
    admitted: 0,
    completed: 0,
    capacity: 0,
    pressureRejected: 0,
    deadline: 0,
  };
  let pressure = false;
  let pressureSince = null;
  let lastActivity = 0;
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  function pressureState() {
    const heap = readHeap();
    const fraction = heap.limit > 0 ? heap.used / heap.limit : 0;
    if (!pressure && fraction >= 0.7) {
      pressure = true;
      pressureSince = now();
    } else if (pressure && fraction <= 0.6) {
      pressure = false;
      pressureSince = null;
    }
    return heap;
  }

  function report() {
    const heap = pressureState();
    const activity = counters.admitted + counters.capacity + counters.pressureRejected;
    if (activity !== lastActivity || counters.active > 0 || pressure) {
      log({
        ...counters,
        maximum,
        heapUsedBytes: heap.used,
        heapLimitBytes: heap.limit,
        pressure,
        pressureMs: pressureSince === null ? 0 : now() - pressureSince,
        eventLoopP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
      });
      lastActivity = activity;
    }
    loopDelay.reset();
  }

  const reportIntervalMs = options.reportIntervalMs ?? REPORT_INTERVAL_MS;
  const reporter = reportIntervalMs > 0 ? setInterval(report, reportIntervalMs) : null;
  reporter?.unref();

  function wrap(handler) {
    return function guardedRequestListener(request, response) {
      if (!isPublicCatalogueRequest(request.method, request.url))
        return Reflect.apply(handler, this, [request, response]);
      pressureState();
      if (pressure || counters.active >= maximum) {
        if (pressure) counters.pressureRejected += 1;
        else counters.capacity += 1;
        sendUnavailable(response);
        return;
      }
      counters.active += 1;
      counters.admitted += 1;
      counters.peakActive = Math.max(counters.peakActive, counters.active);
      let responseEnded = response.destroyed || response.writableFinished;
      let handlerSettled = false;
      let released = false;
      let deadline;

      function release() {
        if (released || !handlerSettled || !responseEnded) return;
        released = true;
        counters.active -= 1;
        counters.completed += 1;
      }

      function ended() {
        responseEnded = true;
        clearTimeout(deadline);
        response.removeListener('finish', ended);
        response.removeListener('close', ended);
        release();
      }

      response.once('finish', ended);
      response.once('close', ended);
      deadline = setTimeout(() => {
        counters.deadline += 1;
        sendUnavailable(response);
      }, timeoutMs);
      deadline.unref();

      let handled;
      try {
        handled = Reflect.apply(handler, this, [request, response]);
      } catch (error) {
        handlerSettled = true;
        sendUnavailable(response);
        release();
        throw error;
      }
      return Promise.resolve(handled).finally(() => {
        handlerSettled = true;
        release();
      });
    };
  }

  return {
    wrap,
    report,
    getStats: () => ({ ...counters, pressure }),
    close: () => {
      if (reporter) clearInterval(reporter);
      loopDelay.disable();
    },
  };
}

/** Install before Next creates its server, without replacing its router or shutdown handling. */
function installPublicPageLoadGuard() {
  if (http[INSTALLED]) return http[INSTALLED];
  const guard = createPublicPageLoadGuard();
  const originalCreateServer = http.createServer;
  http.createServer = function guardedCreateServer(...arguments_) {
    const last = arguments_.length - 1;
    if (typeof arguments_[last] === 'function') arguments_[last] = guard.wrap(arguments_[last]);
    return Reflect.apply(originalCreateServer, this, arguments_);
  };
  Object.defineProperty(http, INSTALLED, { value: guard });
  syncBuiltinESMExports();
  return guard;
}

module.exports = { createPublicPageLoadGuard, installPublicPageLoadGuard, isPublicCatalogueRequest };
