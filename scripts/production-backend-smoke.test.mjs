import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  BOARD_RENDER_VERSION,
  DAILY_CACHE_STALE_TTL_SECONDS,
  DAILY_CACHE_TTL_SECONDS,
  assertGroupedNotificationSchema,
  boardRenderEndpoint,
  checkBoardRenderOnce,
  checkBackendIdentityOnce,
  checkBackendSchemaOnce,
  parseGraphqlResponse,
  parseHealthResponse,
  healthEndpoint,
  runBackendSmoke,
} from './production-backend-smoke.mjs';

// The exact header the backend serves for an unversioned render — browsers
// revalidate every time (`max-age=0`), the CDN holds the bytes for a day.
const DAILY_CACHE_CONTROL = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';

function schemaPayload(fieldNames = ['id', 'climbLayoutId', 'climbAngle']) {
  return {
    data: {
      __type: {
        fields: fieldNames.map((name) => ({ name })),
      },
    },
  };
}

function response(payload, { ok = true, status = 200, headers = {} } = {}) {
  const encodedPayload =
    payload instanceof Uint8Array
      ? payload
      : new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return {
    ok,
    status,
    headers: new Headers(headers),
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    arrayBuffer: async () =>
      encodedPayload.buffer.slice(encodedPayload.byteOffset, encodedPayload.byteOffset + encodedPayload.byteLength),
  };
}

function boardRenderResponse(overrides = {}) {
  const webpBytes = new TextEncoder().encode('RIFF0000WEBP');
  return response(webpBytes, {
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Railway-Request-Id': 'request-123',
    },
    ...overrides,
  });
}

const silentLog = { info() {}, warn() {} };

void test('accepts a GroupedNotification schema containing both required fields', () => {
  const fields = assertGroupedNotificationSchema(schemaPayload());
  assert.deepEqual(fields, ['id', 'climbLayoutId', 'climbAngle']);
});

void test('rejects a GroupedNotification schema missing either required field', () => {
  assert.throws(
    () => assertGroupedNotificationSchema(schemaPayload(['id', 'climbLayoutId'])),
    /missing required fields: climbAngle/,
  );
  assert.throws(
    () => assertGroupedNotificationSchema(schemaPayload(['id'])),
    /missing required fields: climbLayoutId, climbAngle/,
  );
});

void test('surfaces GraphQL errors before inspecting schema data', () => {
  assert.throws(
    () =>
      assertGroupedNotificationSchema({
        errors: [{ message: 'Introspection is unavailable' }],
        data: { __type: null },
      }),
    /GraphQL introspection returned errors: Introspection is unavailable/,
  );
});

void test('rejects malformed JSON and malformed introspection payloads', () => {
  assert.throws(() => parseGraphqlResponse('<html>bad gateway</html>'), /not valid JSON/);
  assert.throws(
    () => assertGroupedNotificationSchema(parseGraphqlResponse('{"data":{"__type":null}}')),
    /did not contain fields/,
  );
});

void test('parses REST health responses independently from GraphQL responses', () => {
  assert.deepEqual(parseHealthResponse('{"status":"healthy"}'), { status: 'healthy' });
  assert.throws(() => parseHealthResponse('[]'), /health response must be a JSON object/);
});

void test('posts a no-cache introspection request to the base GraphQL endpoint', async () => {
  let request;
  await checkBackendSchemaOnce({
    baseUrl: 'https://example.com',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(schemaPayload());
    },
    timeoutMs: 100,
  });

  assert.equal(request.url, 'https://example.com/graphql');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.cache, 'no-store');
  assert.match(request.options.headers['Cache-Control'], /no-cache/);
  assert.match(request.options.headers.Pragma, /no-cache/);
  assert.match(JSON.parse(request.options.body).query, /GroupedNotification/);
  assert.match(JSON.parse(request.options.body).query, /__type/);
});

void test('binds backend health to the exact Railway deployment and stamped release', async () => {
  const expectedDeploymentId = '12345678-1234-4234-8234-123456789abc';
  const expectedRelease = '0123456789abcdef0123456789abcdef01234567';
  let request;
  const identity = await checkBackendIdentityOnce({
    baseUrl: 'https://example.com/graphql',
    expectedDeploymentId,
    expectedRelease,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ status: 'healthy', deploymentId: expectedDeploymentId, release: expectedRelease });
    },
    timeoutMs: 100,
  });

  assert.equal(request.url, 'https://example.com/health');
  assert.match(request.options.headers['Cache-Control'], /no-store/);
  assert.deepEqual(identity, { deploymentId: expectedDeploymentId, release: expectedRelease });

  await assert.rejects(
    checkBackendIdentityOnce({
      baseUrl: 'https://example.com',
      expectedDeploymentId: '87654321-4321-4321-8321-cba987654321',
      expectedRelease,
      fetchImpl: async () =>
        response({ status: 'healthy', deploymentId: expectedDeploymentId, release: expectedRelease }),
      timeoutMs: 100,
    }),
    /expected deployment/,
  );
  await assert.rejects(
    checkBackendIdentityOnce({
      baseUrl: 'https://example.com',
      expectedDeploymentId,
      expectedRelease: 'fedcba9876543210fedcba9876543210fedcba98',
      fetchImpl: async () =>
        response({ status: 'healthy', deploymentId: expectedDeploymentId, release: expectedRelease }),
      timeoutMs: 100,
    }),
    /expected release/,
  );
});

void test('normalizes the backend health endpoint to the selected origin', () => {
  assert.equal(healthEndpoint('https://example.com/graphql?query=x'), 'https://example.com/health');
});

void test('requires an exact immutable release whenever backend identity smoke is enabled', async () => {
  const expectedDeploymentId = '12345678-1234-4234-8234-123456789abc';
  await assert.rejects(runBackendSmoke({ expectedDeploymentId }), /SMOKE_EXPECTED_RELEASE is required/);
  await assert.rejects(
    runBackendSmoke({ expectedDeploymentId, expectedRelease: 'not-a-full-lowercase-sha' }),
    /40-character lowercase Git SHA/,
  );
  await assert.rejects(
    runBackendSmoke({ expectedRelease: '0123456789abcdef0123456789abcdef01234567' }),
    /cannot be checked without SMOKE_EXPECTED_DEPLOYMENT_ID/,
  );
});

void test('fetches uncached board image bytes directly from the Railway endpoint', async () => {
  let request;
  const renderResult = await checkBoardRenderOnce({
    baseUrl: 'https://example.com/graphql',
    cacheBuster: 'deploy-123',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return boardRenderResponse();
    },
    timeoutMs: 100,
  });

  const requestUrl = new URL(request.url);
  assert.equal(requestUrl.origin, 'https://example.com');
  assert.equal(requestUrl.pathname, '/render/board');
  assert.equal(requestUrl.searchParams.get('smoke'), 'deploy-123');
  assert.equal(requestUrl.searchParams.get('v'), BOARD_RENDER_VERSION);
  assert.equal(requestUrl.searchParams.get('frames'), '');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(renderResult.contentType, 'image/webp');
  assert.equal(renderResult.byteLength, 12);
});

void test('checks the unversioned daily-cache board render path', async () => {
  let requestUrl;
  const renderResult = await checkBoardRenderOnce({
    baseUrl: 'https://example.com',
    renderVersion: null,
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return boardRenderResponse({
        headers: {
          'Content-Type': 'image/webp',
          'Cache-Control': DAILY_CACHE_CONTROL,
          'X-Railway-Request-Id': 'request-123',
        },
      });
    },
    timeoutMs: 100,
  });

  assert.equal(requestUrl.searchParams.has('v'), false);
  assert.doesNotMatch(renderResult.cacheControl, /immutable/);
  assert.match(renderResult.cacheControl, /s-maxage=86400/);
});

void test('rejects an unversioned render served on the short redirect-grade tier', async () => {
  await assert.rejects(
    checkBoardRenderOnce({
      baseUrl: 'https://example.com',
      renderVersion: null,
      fetchImpl: async () =>
        boardRenderResponse({
          headers: {
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
            'X-Railway-Request-Id': 'request-123',
          },
        }),
      timeoutMs: 100,
    }),
    /unversioned board render returned unexpected Cache-Control/,
  );
});

// The smoke check asserts a header the backend builds elsewhere. A fixture that
// drifts from `createOgImageHeaders` is how the daily-tier check shipped asserting
// a `max-age=86400` production never sent, so read the real constants here.
void test('mirrors the daily cache tier defined by the shared board-render headers', () => {
  const headersModule = readFileSync(
    new URL('../packages/shared/board-render/src/headers.ts', import.meta.url),
    'utf8',
  );
  const dailyTtl = headersModule.match(/const DAILY_TTL_SECONDS = ([\d_]+);/);
  const dailyStaleTtl = headersModule.match(/const DAILY_STALE_TTL_SECONDS = ([\d_]+);/);
  assert.ok(dailyTtl && dailyStaleTtl, 'could not read the daily cache constants from headers.ts');
  assert.equal(Number(dailyTtl[1].replaceAll('_', '')), DAILY_CACHE_TTL_SECONDS);
  assert.equal(Number(dailyStaleTtl[1].replaceAll('_', '')), DAILY_CACHE_STALE_TTL_SECONDS);
  assert.equal(
    DAILY_CACHE_CONTROL,
    `public, max-age=0, s-maxage=${DAILY_CACHE_TTL_SECONDS}, stale-while-revalidate=${DAILY_CACHE_STALE_TTL_SECONDS}`,
  );
});

void test('rejects cached proxy responses and malformed image bytes', async () => {
  await assert.rejects(
    checkBoardRenderOnce({
      baseUrl: 'https://example.com',
      fetchImpl: async () =>
        boardRenderResponse({
          headers: {
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Railway-Request-Id': 'request-123',
            'X-Vercel-Cache': 'MISS',
          },
        }),
      timeoutMs: 100,
    }),
    /Vercel origin/,
  );

  await assert.rejects(
    checkBoardRenderOnce({
      baseUrl: 'https://example.com',
      fetchImpl: async () =>
        response(new TextEncoder().encode('not an image'), {
          headers: {
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Railway-Request-Id': 'request-123',
          },
        }),
      timeoutMs: 100,
    }),
    /invalid WebP bytes/,
  );
});

void test('normalizes the board renderer URL to an HTTP(S) origin', () => {
  const versionedUrl = new URL(boardRenderEndpoint('https://example.com/graphql', 'one'));
  assert.equal(versionedUrl.pathname, '/render/board');
  assert.equal(versionedUrl.searchParams.get('v'), BOARD_RENDER_VERSION);
  assert.match(BOARD_RENDER_VERSION, /^[0-9a-f]{8,64}$/);
  assert.throws(() => boardRenderEndpoint('ws://example.com/graphql'), /must use http or https/);
});

void test('aborts an introspection request that exceeds its timeout', async () => {
  await assert.rejects(
    checkBackendSchemaOnce({
      baseUrl: 'https://example.com',
      fetchImpl: async (_url, options) =>
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('request aborted')));
        }),
      timeoutMs: 1,
    }),
    /request aborted/,
  );
});

void test('retries transient failures and succeeds within the bounded attempt count', async () => {
  let fetchCalls = 0;
  const sleepDurations = [];

  const fields = await runBackendSmoke({
    attempts: 3,
    retryDelayMs: 25,
    timeoutMs: 100,
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) throw new Error('socket reset');
      if (fetchCalls === 2) return response('upstream unavailable', { ok: false, status: 503 });
      if (fetchCalls === 4) return boardRenderResponse();
      if (fetchCalls === 5) {
        return boardRenderResponse({
          headers: {
            'Content-Type': 'image/webp',
            'Cache-Control': DAILY_CACHE_CONTROL,
            'X-Railway-Request-Id': 'request-123',
          },
        });
      }
      return response(schemaPayload());
    },
    sleep: async (milliseconds) => sleepDurations.push(milliseconds),
    log: silentLog,
  });

  assert.equal(fetchCalls, 5);
  assert.deepEqual(sleepDurations, [25, 25]);
  assert.ok(fields.includes('climbLayoutId'));
});

void test('retries a transient backend identity mismatch before schema and render smoke', async () => {
  const expectedDeploymentId = '12345678-1234-4234-8234-123456789abc';
  const expectedRelease = '0123456789abcdef0123456789abcdef01234567';
  const sleepDurations = [];
  let fetchCalls = 0;

  const fields = await runBackendSmoke({
    attempts: 2,
    retryDelayMs: 25,
    timeoutMs: 100,
    expectedDeploymentId,
    expectedRelease,
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return response({
          status: 'healthy',
          deploymentId: '87654321-4321-4321-8321-cba987654321',
          release: expectedRelease,
        });
      }
      if (fetchCalls === 2) {
        return response({ status: 'healthy', deploymentId: expectedDeploymentId, release: expectedRelease });
      }
      if (fetchCalls === 3) return response(schemaPayload());
      if (fetchCalls === 4) return boardRenderResponse();
      return boardRenderResponse({
        headers: {
          'Content-Type': 'image/webp',
          'Cache-Control': DAILY_CACHE_CONTROL,
          'X-Railway-Request-Id': 'request-123',
        },
      });
    },
    sleep: async (milliseconds) => sleepDurations.push(milliseconds),
    log: silentLog,
  });

  assert.equal(fetchCalls, 5);
  assert.deepEqual(sleepDurations, [25]);
  assert.ok(fields.includes('climbLayoutId'));
});

void test('reports the last schema failure after exhausting retries', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    runBackendSmoke({
      attempts: 2,
      retryDelayMs: 1,
      timeoutMs: 100,
      fetchImpl: async () => {
        fetchCalls += 1;
        return response(schemaPayload(['id']));
      },
      sleep: async () => {},
      log: silentLog,
    }),
    /failed after 2 attempts.*climbLayoutId, climbAngle/,
  );
  assert.equal(fetchCalls, 2);
});

void test('rejects non-positive retry and timeout bounds', async () => {
  await assert.rejects(
    runBackendSmoke({ attempts: 1, retryDelayMs: 0, log: silentLog }),
    /retryDelayMs must be a positive integer/,
  );
  await assert.rejects(
    runBackendSmoke({ attempts: 1, retryDelayMs: 1, timeoutMs: 0, log: silentLog }),
    /timeoutMs must be a positive integer/,
  );
});
