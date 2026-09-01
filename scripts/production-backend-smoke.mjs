#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const DEFAULT_BASE_URL = 'https://ws.boardsesh.com';
const DEFAULT_ATTEMPTS = 12;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const RAILWAY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mirrors DAILY_TTL_SECONDS / DAILY_STALE_TTL_SECONDS in
// packages/shared/board-render/src/headers.ts, which is what the backend serves
// for an unversioned render. Kept honest by a test that reads those constants.
const DAILY_CACHE_TTL_SECONDS = 86_400;
const DAILY_CACHE_STALE_TTL_SECONDS = 604_800;
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

function loadBoardRenderVersion() {
  const generatedModule = readFileSync(
    new URL('../packages/shared/board-render/src/generated/render-version.ts', import.meta.url),
    'utf8',
  );
  const versionMatch = generatedModule.match(/BOARD_RENDER_VERSION = '([0-9a-f]{8,64})'/);
  if (!versionMatch) {
    throw new Error('could not read BOARD_RENDER_VERSION from the generated renderer version module');
  }
  return versionMatch[1];
}

const BOARD_RENDER_VERSION = loadBoardRenderVersion();

function parseJsonObject(responseText, responseLabel) {
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`${responseLabel} was not valid JSON: ${error.message}`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${responseLabel} must be a JSON object`);
  }
  return payload;
}

function parseGraphqlResponse(responseText) {
  return parseJsonObject(responseText, 'GraphQL response');
}

function parseHealthResponse(responseText) {
  return parseJsonObject(responseText, 'health response');
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

function healthEndpoint(baseUrl) {
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`--base must use http or https (received ${parsedUrl.protocol})`);
  }
  parsedUrl.pathname = '/health';
  parsedUrl.search = '';
  parsedUrl.hash = '';
  return parsedUrl.toString();
}

function boardRenderEndpoint(baseUrl, cacheBuster = Date.now(), renderVersion = BOARD_RENDER_VERSION) {
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`--base must use http or https (received ${parsedUrl.protocol})`);
  }
  parsedUrl.pathname = '/render/board';
  const renderSearchParams = new URLSearchParams({
    board_name: 'kilter',
    layout_id: '1',
    size_id: '10',
    set_ids: '1,20',
    frames: '',
    thumbnail: '1',
    include_background: '1',
    format: 'webp',
    smoke: String(cacheBuster),
  });
  if (renderVersion !== null) renderSearchParams.set('v', renderVersion);
  parsedUrl.search = renderSearchParams.toString();
  parsedUrl.hash = '';
  return parsedUrl.toString();
}

function parseCacheControl(headerValue) {
  const directives = new Map();
  for (const rawDirective of headerValue.split(',')) {
    const directive = rawDirective.trim().toLowerCase();
    if (!directive) continue;
    const separatorIndex = directive.indexOf('=');
    if (separatorIndex === -1) directives.set(directive, '');
    else directives.set(directive.slice(0, separatorIndex), directive.slice(separatorIndex + 1));
  }
  return directives;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requirePositiveInteger(optionName, optionValue) {
  if (!Number.isInteger(optionValue) || optionValue < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }
}

function normalizeRailwayDeploymentId(rawDeploymentId) {
  const deploymentId = String(rawDeploymentId ?? '')
    .trim()
    .toLowerCase();
  if (!RAILWAY_UUID_PATTERN.test(deploymentId)) {
    throw new Error('SMOKE_EXPECTED_DEPLOYMENT_ID must be a Railway deployment UUID');
  }
  return deploymentId;
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

async function checkBackendIdentityOnce({
  baseUrl = DEFAULT_BASE_URL,
  expectedDeploymentId,
  expectedRelease = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  requirePositiveInteger('timeoutMs', timeoutMs);
  if (!expectedDeploymentId) throw new Error('SMOKE_EXPECTED_DEPLOYMENT_ID is required for identity smoke');
  const normalizedExpectedDeploymentId = normalizeRailwayDeploymentId(expectedDeploymentId);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetchImpl(healthEndpoint(baseUrl), {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
      },
      signal: abortController.signal,
    });
    const responseText = await response.text();
    let payload;
    try {
      payload = parseHealthResponse(responseText);
    } catch (error) {
      if (!response.ok) throw new Error(`health returned HTTP ${response.status}: ${responseText.slice(0, 300)}`);
      throw error;
    }
    const httpFailurePrefix = response.ok ? '' : `health returned HTTP ${response.status}; `;
    if (payload.deploymentId !== normalizedExpectedDeploymentId) {
      throw new Error(
        `${httpFailurePrefix}expected deployment ${normalizedExpectedDeploymentId}, ` +
          `got ${String(payload.deploymentId ?? '<missing>')}`,
      );
    }
    if (expectedRelease && payload.release !== expectedRelease) {
      throw new Error(
        `${httpFailurePrefix}expected release ${expectedRelease}, got ${String(payload.release ?? '<missing>')}`,
      );
    }
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}: ${responseText.slice(0, 300)}`);
    if (payload.status !== 'healthy') throw new Error(`health returned status ${String(payload.status)}`);
    return { deploymentId: payload.deploymentId, release: payload.release };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkBoardRenderOnce({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheBuster = Date.now(),
  renderVersion = BOARD_RENDER_VERSION,
}) {
  requirePositiveInteger('timeoutMs', timeoutMs);
  const endpoint = boardRenderEndpoint(baseUrl, cacheBuster, renderVersion);
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
    const cacheDirectives = parseCacheControl(cacheControl);
    if (!cacheDirectives.has('public')) {
      throw new Error(`board render returned unexpected Cache-Control: ${cacheControl || '(missing)'}`);
    }
    if (renderVersion === null) {
      // The daily tier keeps browsers honest (`max-age=0`) and lets the CDN hold
      // the bytes for a day, so assert the shared-cache directives, not max-age.
      if (
        cacheDirectives.has('immutable') ||
        cacheDirectives.get('s-maxage') !== String(DAILY_CACHE_TTL_SECONDS) ||
        cacheDirectives.get('stale-while-revalidate') !== String(DAILY_CACHE_STALE_TTL_SECONDS)
      ) {
        throw new Error(`unversioned board render returned unexpected Cache-Control: ${cacheControl || '(missing)'}`);
      }
    } else if (!cacheDirectives.has('immutable')) {
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
  expectedDeploymentId = '',
  expectedRelease = '',
  sleep = delay,
  log = console,
} = {}) {
  requirePositiveInteger('attempts', attempts);
  requirePositiveInteger('retryDelayMs', retryDelayMs);
  requirePositiveInteger('timeoutMs', timeoutMs);
  if (expectedRelease && !expectedDeploymentId) {
    throw new Error('SMOKE_EXPECTED_RELEASE cannot be checked without SMOKE_EXPECTED_DEPLOYMENT_ID');
  }
  const normalizedExpectedDeploymentId = expectedDeploymentId ? normalizeRailwayDeploymentId(expectedDeploymentId) : '';
  if (normalizedExpectedDeploymentId && !expectedRelease) {
    throw new Error('SMOKE_EXPECTED_RELEASE is required when SMOKE_EXPECTED_DEPLOYMENT_ID is set');
  }
  if (expectedRelease && !/^[0-9a-f]{40}$/.test(expectedRelease)) {
    throw new Error('SMOKE_EXPECTED_RELEASE must be a 40-character lowercase Git SHA');
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (normalizedExpectedDeploymentId) {
        await checkBackendIdentityOnce({
          baseUrl,
          expectedDeploymentId: normalizedExpectedDeploymentId,
          expectedRelease,
          fetchImpl,
          timeoutMs,
        });
      }
      const fieldNames = await checkBackendSchemaOnce({ baseUrl, fetchImpl, timeoutMs });
      const versionedRenderResult = await checkBoardRenderOnce({
        baseUrl,
        fetchImpl,
        timeoutMs,
        cacheBuster: `${Date.now()}-${attempt}`,
      });
      const dailyRenderResult = await checkBoardRenderOnce({
        baseUrl,
        fetchImpl,
        timeoutMs,
        cacheBuster: `${Date.now()}-${attempt}-daily`,
        renderVersion: null,
      });
      log.info(
        `Production backend smoke passed on attempt ${attempt}: ${REQUIRED_GROUPED_NOTIFICATION_FIELDS.join(', ')}; ` +
          `versioned board render ${versionedRenderResult.byteLength} bytes (${versionedRenderResult.contentType}); ` +
          `daily board render ${dailyRenderResult.byteLength} bytes`,
      );
      return fieldNames;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      log.warn(`Production backend smoke attempt ${attempt}/${attempts} failed: ${error.message}`);
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`production backend smoke failed after ${attempts} attempts: ${lastError?.message}`);
}

function parseCliArguments(argv, env = process.env) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    attempts: DEFAULT_ATTEMPTS,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    expectedDeploymentId: env.SMOKE_EXPECTED_DEPLOYMENT_ID?.trim() ?? '',
    expectedRelease: env.SMOKE_EXPECTED_RELEASE?.trim() ?? '',
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
  BOARD_RENDER_VERSION,
  DAILY_CACHE_STALE_TTL_SECONDS,
  DAILY_CACHE_TTL_SECONDS,
  DEFAULT_ATTEMPTS,
  DEFAULT_BASE_URL,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  INTROSPECTION_QUERY,
  REQUIRED_GROUPED_NOTIFICATION_FIELDS,
  assertGroupedNotificationSchema,
  boardRenderEndpoint,
  checkBoardRenderOnce,
  checkBackendIdentityOnce,
  checkBackendSchemaOnce,
  graphqlEndpoint,
  healthEndpoint,
  parseCacheControl,
  parseCliArguments,
  parseGraphqlResponse,
  parseHealthResponse,
  runBackendSmoke,
};
