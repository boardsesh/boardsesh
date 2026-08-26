import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertGroupedNotificationSchema,
  boardRenderEndpoint,
  checkBoardRenderOnce,
  checkBackendSchemaOnce,
  parseGraphqlResponse,
  runBackendSmoke,
} from './production-backend-smoke.mjs';

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
  assert.equal(requestUrl.searchParams.get('frames'), '');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(renderResult.contentType, 'image/webp');
  assert.equal(renderResult.byteLength, 12);
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
  assert.equal(new URL(boardRenderEndpoint('https://example.com/graphql', 'one')).pathname, '/render/board');
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
      return response(schemaPayload());
    },
    sleep: async (milliseconds) => sleepDurations.push(milliseconds),
    log: silentLog,
  });

  assert.equal(fetchCalls, 4);
  assert.deepEqual(sleepDurations, [25, 25]);
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
