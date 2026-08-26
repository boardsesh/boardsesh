#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const DEFAULT_BASE_URL = 'https://ws.boardsesh.com';
const DEFAULT_ATTEMPTS = 12;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const BOARD_RENDER_VERSION = '00000000';
const REQUIRED_GROUPED_NOTIFICATION_FIELDS = Object.freeze(['climbLayoutId', 'climbAngle']);
const INTROSPECTION_QUERY = `
  query ProductionBackendSchemaSmoke {
    __type(name: "GroupedNotification") {
      fields {
        name
      }
    }
  }
`;

function parseGraphqlResponse(responseText) {
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`response was not valid JSON: ${error.message}`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GraphQL response must be a JSON object');
  }
  return payload;
}

function assertGroupedNotificationSchema(payload) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const messages = payload.errors
      .map((error) => (typeof error?.message === 'string' ? error.message : 'unknown GraphQL error'))
      .join('; ');
    throw new Error(`GraphQL introspection returned errors: ${messages}`);
  }

  const groupedNotification = payload?.data?.__type;
  if (!groupedNotification || !Array.isArray(groupedNotification.fields)) {
    throw new Error('GraphQL response did not contain fields for GroupedNotification');
  }

  const fieldNames = new Set(
    groupedNotification.fields.map((field) => (typeof field?.name === 'string' ? field.name : '')).filter(Boolean),
  );
  const missingFields = REQUIRED_GROUPED_NOTIFICATION_FIELDS.filter((fieldName) => !fieldNames.has(fieldName));
  if (missingFields.length > 0) {
    throw new Error(`GroupedNotification is missing required fields: ${missingFields.join(', ')}`);
  }

  return [...fieldNames];
}

function graphqlEndpoint(baseUrl) {
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`--base must use http or https (received ${parsedUrl.protocol})`);
  }
  if (parsedUrl.pathname === '' || parsedUrl.pathname === '/') parsedUrl.pathname = '/graphql';
  parsedUrl.search = '';
  parsedUrl.hash = '';
  return parsedUrl.toString();
}

function boardRenderEndpoint(baseUrl, cacheBuster = Date.now()) {
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`--base must use http or https (received ${parsedUrl.protocol})`);
  }
  parsedUrl.pathname = '/render/board';
  parsedUrl.search = new URLSearchParams({
    board_name: 'kilter',
    layout_id: '1',
    size_id: '10',
    set_ids: '1,20',
    frames: '',
    thumbnail: '1',
    include_background: '1',
    format: 'webp',
    v: BOARD_RENDER_VERSION,
    smoke: String(cacheBuster),
  }).toString();
  parsedUrl.hash = '';
  return parsedUrl.toString();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requirePositiveInteger(optionName, optionValue) {
  if (!Number.isInteger(optionValue) || optionValue < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }
}

async function checkBackendSchemaOnce({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  requirePositiveInteger('timeoutMs', timeoutMs);
  const endpoint = graphqlEndpoint(baseUrl);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        'Content-Type': 'application/json',
        Pragma: 'no-cache',
      },
      body: JSON.stringify({ query: INTROSPECTION_QUERY }),
      signal: abortController.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 500)}`);
    }
    const payload = parseGraphqlResponse(responseText);
    return assertGroupedNotificationSchema(payload);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkBoardRenderOnce({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheBuster = Date.now(),
}) {
  requirePositiveInteger('timeoutMs', timeoutMs);
  const endpoint = boardRenderEndpoint(baseUrl, cacheBuster);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'image/webp',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
      },
      signal: abortController.signal,
    });
    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`board render returned HTTP ${response.status}: ${responseText.slice(0, 300)}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/webp')) {
      throw new Error(`board render returned unexpected Content-Type: ${contentType || '(missing)'}`);
    }
    const cacheControl = response.headers.get('cache-control') ?? '';
    if (!cacheControl.includes('public') || !cacheControl.includes('immutable')) {
      throw new Error(`versioned board render returned unexpected Cache-Control: ${cacheControl || '(missing)'}`);
    }
    if (!response.headers.get('x-railway-request-id')) {
      throw new Error('board render response is missing x-railway-request-id');
    }
    if (response.headers.get('x-vercel-cache')) {
      throw new Error('board render unexpectedly passed through a Vercel origin');
    }

    const imageBytes = new Uint8Array(await response.arrayBuffer());
    if (
      imageBytes.length < 12 ||
      Buffer.from(imageBytes.subarray(0, 4)).toString('ascii') !== 'RIFF' ||
      Buffer.from(imageBytes.subarray(8, 12)).toString('ascii') !== 'WEBP'
    ) {
      throw new Error(`board render returned invalid WebP bytes (${imageBytes.length} bytes)`);
    }

    return { byteLength: imageBytes.length, contentType, cacheControl };
  } finally {
    clearTimeout(timeout);
  }
}

async function runBackendSmoke({
  baseUrl = DEFAULT_BASE_URL,
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  sleep = delay,
  log = console,
} = {}) {
  requirePositiveInteger('attempts', attempts);
  requirePositiveInteger('retryDelayMs', retryDelayMs);
  requirePositiveInteger('timeoutMs', timeoutMs);

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const fieldNames = await checkBackendSchemaOnce({ baseUrl, fetchImpl, timeoutMs });
      const renderResult = await checkBoardRenderOnce({
        baseUrl,
        fetchImpl,
        timeoutMs,
        cacheBuster: `${Date.now()}-${attempt}`,
      });
      log.info(
        `Production backend smoke passed on attempt ${attempt}: ${REQUIRED_GROUPED_NOTIFICATION_FIELDS.join(', ')}; ` +
          `board render ${renderResult.byteLength} bytes (${renderResult.contentType})`,
      );
      return fieldNames;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      log.warn(`Production backend schema smoke attempt ${attempt}/${attempts} failed: ${error.message}`);
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`production backend schema smoke failed after ${attempts} attempts: ${lastError?.message}`);
}

function parseCliArguments(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    attempts: DEFAULT_ATTEMPTS,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let argumentIndex = 0; argumentIndex < argv.length; argumentIndex += 1) {
    const argument = argv[argumentIndex];
    const optionValue = argv[argumentIndex + 1];
    switch (argument) {
      case '--base':
        options.baseUrl = optionValue ?? '';
        argumentIndex += 1;
        break;
      case '--attempts':
        options.attempts = Number(optionValue);
        argumentIndex += 1;
        break;
      case '--retry-delay-ms':
        options.retryDelayMs = Number(optionValue);
        argumentIndex += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(optionValue);
        argumentIndex += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] === scriptPath) {
  try {
    await runBackendSmoke(parseCliArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`production-backend-smoke: ${error.message}`);
    process.exit(1);
  }
}

export {
  DEFAULT_ATTEMPTS,
  DEFAULT_BASE_URL,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  INTROSPECTION_QUERY,
  REQUIRED_GROUPED_NOTIFICATION_FIELDS,
  assertGroupedNotificationSchema,
  boardRenderEndpoint,
  checkBoardRenderOnce,
  checkBackendSchemaOnce,
  graphqlEndpoint,
  parseCliArguments,
  parseGraphqlResponse,
  runBackendSmoke,
};
