// Real installed-framework regression fixture. All sockets are loopback, and
// Sentry envelopes use a no-op transport. GC runs only in the isolated child.
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { fork } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { parse } = require('node:url');
const { gunzipSync } = require('node:zlib');
const { randomFillSync } = require('node:crypto');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const responseBody = Buffer.from(
  JSON.stringify({ geometry: randomFillSync(Buffer.alloc(128 * 1024)).toString('base64') }),
);

function awaitMessage(child, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('message', receive);
      child.off('error', rejectWithCleanup);
      child.off('exit', exit);
    };
    const receive = (message) => {
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const rejectWithCleanup = (error) => {
      cleanup();
      reject(error);
    };
    const exit = (code) => rejectWithCleanup(new Error(`Proxy fixture exited before ${type}: ${code}`));
    child.on('message', receive);
    child.once('error', rejectWithCleanup);
    child.once('exit', exit);
  });
}

async function runApplication() {
  const upstreamOrigin = process.argv[3];
  const webRequire = createRequire(path.resolve(__dirname, '../../../package.json'));
  const Sentry = webRequire('@sentry/nextjs');
  Sentry.init({
    dsn: 'https://public@example.invalid/1',
    defaultIntegrations: false,
    tracesSampleRate: 1,
    transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
    integrations: [Sentry.httpIntegration({ disableIncomingRequestSpans: true })],
  });
  const { proxyRequest } = webRequire('next/dist/server/lib/router-utils/proxy-request');
  const compression = webRequire('next/dist/compiled/compression')();
  const { releaseCompressionStream } = webRequire('next/dist/server/lib/release-compression-stream');
  const { signalFromNodeResponse } = webRequire('next/dist/server/web/spec-extension/adapters/next-request');
  const references = [];
  const responsesToDestroy = new Map();
  const warnings = [];
  const responseLimits = new Set();
  const proxyErrors = [];
  process.on('warning', (warning) => {
    if (warning.name === 'MaxListenersExceededWarning') warnings.push({ count: warning.count, type: warning.type });
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://fixture.invalid');
    const scenario = requestUrl.searchParams.get('scenario');
    if (scenario === 'downstream-error')
      responsesToDestroy.set(Number(requestUrl.searchParams.get('requestId')), new WeakRef(response));
    references.push(new WeakRef(response));
    responseLimits.add(response.getMaxListeners());
    compression(request, response, () => {});
    // Same compression cleanup and route-resolution adaptation as Next's router.
    response.once('close', () => {
      if (!response.writableFinished) releaseCompressionStream(response);
    });
    request.on('error', () => {});
    response.on('error', () => {});
    // /monitoring is excluded by the app's middleware matcher, so it has no
    // second middleware request adaptation.
    signalFromNodeResponse(response);
    proxyRequest(request, response, parse(upstreamOrigin + request.url, true), undefined, undefined, 2000).catch(
      (error) => {
        proxyErrors.push({ scenario, code: error.code || error.name });
        if (!response.destroyed) response.destroy();
      },
    );
  });
  server.keepAliveTimeout = 60_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.send({ type: 'ready', port: server.address().port });
  const finish = async () => {
    await sleep(100);
    for (let index = 0; index < 6; index += 1) {
      await sleep(20);
      global.gc();
    }
    let survivingResponses = 0;
    for (const reference of references) if (reference.deref()) survivingResponses += 1;
    process.send({
      type: 'result',
      warnings,
      defaultLimit: EventEmitter.defaultMaxListeners,
      responseLimits: [...responseLimits],
      proxyErrors,
      trackedResponses: references.length,
      survivingResponses,
    });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Sentry.close(500);
    process.disconnect();
  };
  process.on('message', (message) => {
    if (message.type === 'destroy-response') {
      responsesToDestroy.get(message.requestId)?.deref()?.destroy(new Error('local downstream reset'));
      responsesToDestroy.delete(message.requestId);
    }
    if (message.type === 'finish')
      void finish().catch((error) => {
        console.error(error);
        process.exit(1);
      });
  });
}

async function requestScenario(port, agent, scenario, requestId, expectedBodies, forwardedBodies, resetUpstreamBody) {
  const envelopeHeader = Buffer.from(JSON.stringify({ requestId, scenario, note: 'local POST bytes: café' }));
  const requestBody =
    requestId === 1 ? Buffer.concat([envelopeHeader, Buffer.from([0, 255, 254, 1, 2])]) : envelopeHeader;
  expectedBodies.set(requestId, requestBody);
  return new Promise((resolve) => {
    let finished = false;
    let status;
    let encoding;
    const chunks = [];
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      let bodyMatches = false;
      if (outcome === 'complete' && status === 200) {
        try {
          const body = Buffer.concat(chunks);
          bodyMatches = (encoding === 'gzip' ? gunzipSync(body) : body).equals(responseBody);
        } catch {
          bodyMatches = false;
        }
      }
      resolve({ scenario, outcome, status, encoding, bodyMatches });
    };
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        agent,
        method: 'POST',
        path: `/monitoring?scenario=${scenario}&requestId=${requestId}`,
        headers: {
          'Content-Type': requestId === 1 ? 'application/x-sentry-envelope' : 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'Accept-Encoding': 'gzip',
        },
      },
      (response) => {
        status = response.statusCode;
        encoding = response.headers['content-encoding'];
        response.on('data', (chunk) => {
          chunks.push(chunk);
          if (scenario === 'client-midbody') request.destroy();
          if (scenario === 'upstream-midbody-error') resetUpstreamBody(requestId);
        });
        response.on('end', () => finish('complete'));
        response.on('aborted', () => finish('response-aborted'));
        response.on('error', () => finish('response-error'));
      },
    );
    request.on('error', (error) => finish(error.code || error.name));
    request.setTimeout(4000, () => {
      request.destroy();
      finish('timeout');
    });
    if (scenario === 'client-preheaders') forwardedBodies.set(requestId, () => request.destroy());
    request.end(requestBody);
  });
}

async function runController() {
  const expectedBodies = new Map();
  const forwardedBodies = new Map();
  const upstreamBodiesToReset = new Map();
  const upstreamCounts = {
    requests: 0,
    closed: 0,
    bodyMismatches: 0,
    binaryBodiesVerified: 0,
    pathMismatches: 0,
    connections: 0,
  };
  const upstream = http.createServer((request, response) => {
    upstreamCounts.requests += 1;
    request.on('error', () => {});
    response.on('error', () => {});
    response.once('close', () => {
      upstreamCounts.closed += 1;
      upstreamBodiesToReset.delete(requestId);
    });
    const requestUrl = new URL(request.url, 'http://fixture.invalid');
    const scenario = requestUrl.searchParams.get('scenario');
    const requestId = Number(requestUrl.searchParams.get('requestId'));
    if (request.method !== 'POST' || requestUrl.pathname !== '/monitoring') upstreamCounts.pathMismatches += 1;
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const expectedBody = expectedBodies.get(requestId);
      if (!expectedBody || !body.equals(expectedBody)) upstreamCounts.bodyMismatches += 1;
      else if (requestId === 1) upstreamCounts.binaryBodiesVerified += 1;
      response.setHeader('Content-Type', 'application/json');
      forwardedBodies.get(requestId)?.();
      forwardedBodies.delete(requestId);
      // Wait without headers until the driver cancels the forwarded request.
      if (scenario === 'client-preheaders' || scenario === 'downstream-error') return;
      if (scenario === 'upstream-preheaders-error') {
        setTimeout(() => response.destroy(new Error('local upstream reset')), 10);
        return;
      }
      let offset = 0;
      function writeChunk() {
        if (response.destroyed) return;
        response.write(responseBody.subarray(offset, offset + 32 * 1024));
        offset += 32 * 1024;
        if (scenario === 'upstream-midbody-error')
          upstreamBodiesToReset.set(requestId, () => response.destroy(new Error('local upstream body reset')));
        else if (offset >= responseBody.length) response.end();
        else setTimeout(writeChunk, 5);
      }
      writeChunk();
    });
  });
  upstream.on('connection', () => {
    upstreamCounts.connections += 1;
  });
  upstream.keepAliveTimeout = 60_000;
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const child = fork(__filename, ['application', `http://127.0.0.1:${upstream.address().port}`], {
    execArgv: ['--expose-gc'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test' },
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => {
    childStderr = (childStderr + chunk.toString()).slice(-32 * 1024);
  });
  const deadline = setTimeout(() => {
    child.kill('SIGKILL');
    console.error('Local proxy fixture timed out');
    process.exit(1);
  }, 20_000);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 });
  const resetUpstreamBody = (requestId) => upstreamBodiesToReset.get(requestId)?.();
  try {
    const { port } = await awaitMessage(child, 'ready');
    const stress = { completed: 0, aborted: 0, gzipCompleted: 0, bodyMatches: 0 };
    let nextRequest = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (nextRequest < 64) {
          const requestId = nextRequest++;
          const scenario = requestId % 5 === 0 ? 'client-midbody' : 'complete';
          const result = await requestScenario(
            port,
            agent,
            scenario,
            requestId,
            expectedBodies,
            forwardedBodies,
            resetUpstreamBody,
          );
          if (result.outcome === 'complete' && result.status === 200) {
            stress.completed += 1;
            if (result.encoding === 'gzip') stress.gzipCompleted += 1;
            if (result.bodyMatches) stress.bodyMatches += 1;
          } else if (scenario === 'client-midbody' && result.outcome === 'response-aborted') stress.aborted += 1;
          else throw new Error(`Unexpected stress outcome: ${JSON.stringify(result)}`);
        }
      }),
    );
    const scenarios = [];
    for (const scenario of [
      'complete',
      'client-preheaders',
      'client-midbody',
      'upstream-preheaders-error',
      'upstream-midbody-error',
      'downstream-error',
    ]) {
      const requestId = nextRequest++;
      if (scenario === 'downstream-error')
        forwardedBodies.set(requestId, () => child.send({ type: 'destroy-response', requestId }));
      const { outcome, status } = await requestScenario(
        port,
        false,
        scenario,
        requestId,
        expectedBodies,
        forwardedBodies,
        resetUpstreamBody,
      );
      scenarios.push({ scenario, outcome, status });
    }
    agent.destroy();
    upstream.closeIdleConnections();
    const measured = awaitMessage(child, 'result');
    const exited = once(child, 'exit');
    child.send({ type: 'finish' });
    const measurements = await measured;
    const [exitCode, signal] = await exited;
    if (exitCode !== 0) throw new Error(`Proxy application exited with ${exitCode} (${signal})`);
    const { type: _messageType, ...application } = measurements;
    console.log(JSON.stringify({ ...application, stress, scenarios, upstream: upstreamCounts }));
  } catch (error) {
    throw new Error(`${error.message}\n${childStderr}`);
  } finally {
    clearTimeout(deadline);
    agent.destroy();
    if (child.connected) child.kill('SIGKILL');
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

(process.argv[2] === 'application' ? runApplication() : runController()).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
