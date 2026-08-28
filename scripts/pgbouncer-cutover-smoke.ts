#!/usr/bin/env tsx
/// <reference types="node" />

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export const DEFAULT_REQUESTS = 100;
export const DEFAULT_CONCURRENCY = 32;
export const DEFAULT_TIMEOUT_MS = 10_000;
// One complete deterministic shard is enough to spread probes across many
// climbs without multiplying sitemap downloads during the cutover window.
export const CLIMB_SITEMAP_PATH = '/sitemaps/climbs/1.xml';
export const READINESS_PATH = '/api/internal/pgbouncer-cutover-readiness';
export const CUTOVER_TOKEN_ENV = 'PGBOUNCER_CUTOVER_SMOKE_TOKEN';

const MIN_CLIMB_HTML_CHARS = 4_000;
const MAX_CLIMB_HTML_BYTES = 2_000_000;
const MAX_SITEMAP_BYTES = 8_000_000;
const MAX_PROBE_BYTES = 1_024;

export type FailureCode =
  | 'timeout'
  | 'network'
  | 'http'
  | 'non-html'
  | 'short-html'
  | 'missing-main'
  | 'missing-h1'
  | 'missing-jsonld'
  | 'body-too-large'
  | 'invalid-probe'
  | 'cacheable-probe';

export type CutoverOptions = {
  origin: string;
  requests: number;
  concurrency: number;
  timeoutMs: number;
  probeToken: string;
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type RequestOutcome = {
  status: number | null;
  latencyMs: number;
  error: FailureCode | null;
};

export type CutoverSummary = {
  total: number;
  successful: number;
  failed: number;
  timedOut: number;
  networkErrors: number;
  invalidResponses: number;
  errorCounts: ReadonlyMap<FailureCode, number>;
  statusCounts: ReadonlyMap<number, number>;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

export type CutoverReport = {
  database: CutoverSummary;
  climbs: CutoverSummary;
};

function parsePositiveInteger(flag: string, raw: string | undefined): number {
  if (raw === undefined) throw new Error(`${flag} needs a value`);
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

/** Accepts an HTTP(S) origin, not a URL carrying a path, credentials, query, or fragment. */
export function parseOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('--origin must be a valid HTTP(S) origin');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('--origin must use http:// or https://');
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('--origin must use https:// outside localhost');
  }
  if (parsed.username || parsed.password) throw new Error('--origin must not contain credentials');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('--origin must not contain a path, query, or fragment');
  }
  return parsed.origin;
}

/** Parses public options from argv and the probe credential from one dedicated environment variable. */
export function parseArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): CutoverOptions {
  const parsed: Partial<CutoverOptions> = {};
  const seen = new Set<string>();
  const forwardedArguments = argv[0] === '--' ? argv.slice(1) : argv;

  for (let index = 0; index < forwardedArguments.length; index += 2) {
    const flag = forwardedArguments[index];
    const raw = forwardedArguments[index + 1];
    if (!flag?.startsWith('--')) throw new Error(`unexpected argument: ${flag ?? ''}`);
    if (seen.has(flag)) throw new Error(`${flag} may only be provided once`);
    seen.add(flag);

    switch (flag) {
      case '--origin':
        if (raw === undefined) throw new Error('--origin needs a value');
        parsed.origin = parseOrigin(raw);
        break;
      case '--requests':
        parsed.requests = parsePositiveInteger(flag, raw);
        break;
      case '--concurrency':
        parsed.concurrency = parsePositiveInteger(flag, raw);
        break;
      case '--timeout-ms':
        parsed.timeoutMs = parsePositiveInteger(flag, raw);
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }

  if (!parsed.origin) throw new Error('--origin is required');
  const probeToken = env[CUTOVER_TOKEN_ENV];
  if (!probeToken) throw new Error(`${CUTOVER_TOKEN_ENV} is required`);
  return {
    origin: parsed.origin,
    requests: parsed.requests ?? DEFAULT_REQUESTS,
    concurrency: parsed.concurrency ?? DEFAULT_CONCURRENCY,
    timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    probeToken,
  };
}

function decodeXmlText(encoded: string): string {
  return encoded.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|apos|gt|lt|quot);/gi, (entity, decimal, hexadecimal) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    const namedEntities: Record<string, string> = {
      '&amp;': '&',
      '&apos;': "'",
      '&gt;': '>',
      '&lt;': '<',
      '&quot;': '"',
    };
    return namedEntities[entity.toLowerCase()] ?? entity;
  });
}

/** Extracts unique HTTP(S) URLs, then samples evenly across the complete sitemap. */
export function selectClimbUrls(xml: string, count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('request count must be a positive integer');
  if (!/<urlset\b/i.test(xml)) throw new Error('climb sitemap has no <urlset> root');

  const uniqueUrls: string[] = [];
  const seen = new Set<string>();
  const locationPattern = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi;
  let match: RegExpExecArray | null;

  while ((match = locationPattern.exec(xml)) !== null) {
    const location = decodeXmlText(match[1].trim());
    let parsed: URL;
    try {
      parsed = new URL(location);
    } catch {
      throw new Error('climb sitemap contains an invalid <loc> URL');
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      throw new Error('climb sitemap contains an unsafe <loc> URL');
    }
    if (parsed.hash) throw new Error('climb sitemap contains a fragmented <loc> URL');
    if (!parsed.pathname.includes('/view/')) throw new Error('climb sitemap contains a non-climb <loc> URL');
    if (!seen.has(parsed.href)) {
      seen.add(parsed.href);
      uniqueUrls.push(parsed.href);
    }
  }

  if (uniqueUrls.length < count) {
    throw new Error(`climb sitemap has ${uniqueUrls.length} unique URLs; ${count} required`);
  }

  // Include both ends and evenly cover everything between them. This makes a
  // cutover hit long-tail/cold pages without adding randomness to incident QA.
  if (count === 1) return [uniqueUrls[0]];
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round((index * (uniqueUrls.length - 1)) / (count - 1));
    return uniqueUrls[sourceIndex];
  });
}

/** Keeps each climb path/query but guarantees every request starts on the target origin. */
export function rewriteUrlsToOrigin(urls: readonly string[], origin: string): string[] {
  const targetOrigin = parseOrigin(origin);
  return urls.map((source) => {
    const parsed = new URL(source);
    return new URL(`${parsed.pathname}${parsed.search}`, targetOrigin).href;
  });
}

/** Rejects status-only and streamed error shells that can otherwise look like healthy climb responses. */
export function validateClimbResponse(status: number, contentType: string, body: string): FailureCode | null {
  if (status < 200 || status >= 300) return 'http';
  if (!contentType.toLowerCase().includes('text/html')) return 'non-html';
  if (body.length < MIN_CLIMB_HTML_CHARS) return 'short-html';
  if (!/<main[\s>]/i.test(body)) return 'missing-main';
  if (!/<h1[\s>]/i.test(body)) return 'missing-h1';
  if (!/type=["']application\/ld\+json["']/i.test(body) || !/["']@type["']\s*:\s*["']CreativeWork["']/i.test(body)) {
    return 'missing-jsonld';
  }
  return null;
}

class BodyTooLargeError extends Error {
  constructor() {
    super('response body exceeded safety limit');
  }
}

/** Reads a complete response without allowing 32 concurrent bodies to grow without limit. */
async function readBody(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytesRead = 0;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return body + decoder.decode();
    bytesRead += chunk.value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
}

async function requestOnce(url: string, timeoutMs: number, fetchImpl: FetchLike): Promise<RequestOutcome> {
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'boardsesh-pgbouncer-cutover-smoke/1.0', 'Cache-Control': 'no-cache' },
    });
    // Await the complete body under the same abort signal. A streamed 200 shell
    // is not a pass until its meaningful climb markup actually arrives.
    const body = await readBody(response, MAX_CLIMB_HTML_BYTES);
    const validationFailure = validateClimbResponse(response.status, response.headers.get('content-type') ?? '', body);
    return {
      status: response.status,
      latencyMs: performance.now() - startedAt,
      error: validationFailure,
    };
  } catch (error) {
    return {
      status: null,
      latencyMs: performance.now() - startedAt,
      error: controller.signal.aborted ? 'timeout' : error instanceof BodyTooLargeError ? 'body-too-large' : 'network',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Runs every URL once with a worker pool; `concurrency` is a hard upper bound. */
export async function runRequests(
  urls: readonly string[],
  concurrency: number,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch,
): Promise<RequestOutcome[]> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeout must be a positive integer');
  return runWorkerPool(urls.length, concurrency, (requestIndex) =>
    requestOnce(urls[requestIndex], timeoutMs, fetchImpl),
  );
}

async function runWorkerPool(
  itemCount: number,
  concurrency: number,
  perform: (itemIndex: number) => Promise<RequestOutcome>,
): Promise<RequestOutcome[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');

  const outcomes: RequestOutcome[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, itemCount);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < itemCount) {
        const requestIndex = nextIndex;
        nextIndex += 1;
        outcomes[requestIndex] = await perform(requestIndex);
      }
    }),
  );
  return outcomes;
}

function percentile(sortedLatencies: readonly number[], percentileValue: number): number {
  if (sortedLatencies.length === 0) return 0;
  return sortedLatencies[Math.ceil(sortedLatencies.length * percentileValue) - 1];
}

export function summarizeOutcomes(outcomes: readonly RequestOutcome[]): CutoverSummary {
  const statusCounts = new Map<number, number>();
  const errorCounts = new Map<FailureCode, number>();
  let successful = 0;
  let timedOut = 0;
  let networkErrors = 0;
  let invalidResponses = 0;

  for (const outcome of outcomes) {
    if (outcome.error) errorCounts.set(outcome.error, (errorCounts.get(outcome.error) ?? 0) + 1);
    if (outcome.status !== null) {
      statusCounts.set(outcome.status, (statusCounts.get(outcome.status) ?? 0) + 1);
      if (outcome.error === null) successful += 1;
    } else if (outcome.error === 'timeout') {
      timedOut += 1;
    } else {
      networkErrors += 1;
    }
    if (outcome.error && outcome.error !== 'timeout' && outcome.error !== 'network') invalidResponses += 1;
  }

  const latencies = outcomes.map((outcome) => outcome.latencyMs).sort((left, right) => left - right);
  return {
    total: outcomes.length,
    successful,
    failed: outcomes.length - successful,
    timedOut,
    networkErrors,
    invalidResponses,
    errorCounts,
    statusCounts,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: latencies.at(-1) ?? 0,
  };
}

export function formatSummary(summary: CutoverSummary): string {
  const statuses = [...summary.statusCounts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([status, count]) => `${status}:${count}`)
    .join(',');
  const errors = [...summary.errorCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([error, count]) => `${error}:${count}`)
    .join(',');
  return [
    `requests=${summary.total}`,
    `ok=${summary.successful}`,
    `failed=${summary.failed}`,
    `status=${statuses || 'none'}`,
    `timeouts=${summary.timedOut}`,
    `network=${summary.networkErrors}`,
    `invalid=${summary.invalidResponses}`,
    `errors=${errors || 'none'}`,
    `latency_ms=p50:${Math.round(summary.p50Ms)},p95:${Math.round(summary.p95Ms)},max:${Math.round(summary.maxMs)}`,
  ].join(' ');
}

async function fetchSitemapXml(origin: string, timeoutMs: number, fetchImpl: FetchLike): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL(CLIMB_SITEMAP_PATH, origin), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'boardsesh-pgbouncer-cutover-smoke/1.0', 'Cache-Control': 'no-cache' },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`climb sitemap returned HTTP ${response.status}`);
    }
    return await readBody(response, MAX_SITEMAP_BYTES);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`climb sitemap timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeDatabaseOnce(
  options: CutoverOptions,
  requestIndex: number,
  fetchImpl: FetchLike,
): Promise<RequestOutcome> {
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const probeUrl = new URL(READINESS_PATH, options.origin);
    probeUrl.searchParams.set('request', String(requestIndex + 1));
    const response = await fetchImpl(probeUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${options.probeToken}`,
        'User-Agent': 'boardsesh-pgbouncer-cutover-smoke/1.0',
        'Cache-Control': 'no-cache',
      },
    });
    const bodyText = await readBody(response, MAX_PROBE_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
    const validPayload =
      response.status === 200 && typeof body === 'object' && body !== null && 'ok' in body && body.ok === true;
    const noStore = (response.headers.get('cache-control') ?? '').toLowerCase().includes('no-store');
    return {
      status: response.status,
      latencyMs: performance.now() - startedAt,
      error: !validPayload ? 'invalid-probe' : !noStore ? 'cacheable-probe' : null,
    };
  } catch (error) {
    return {
      status: null,
      latencyMs: performance.now() - startedAt,
      error: controller.signal.aborted ? 'timeout' : error instanceof BodyTooLargeError ? 'body-too-large' : 'network',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runProbeRequests(
  options: CutoverOptions,
  fetchImpl: FetchLike = fetch,
): Promise<RequestOutcome[]> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error('timeout must be a positive integer');
  }
  return runWorkerPool(options.requests, options.concurrency, (requestIndex) =>
    probeDatabaseOnce(options, requestIndex, fetchImpl),
  );
}

export async function runCutoverSmoke(options: CutoverOptions, fetchImpl: FetchLike = fetch): Promise<CutoverReport> {
  const sitemapXml = await fetchSitemapXml(options.origin, options.timeoutMs, fetchImpl);
  const sourceUrls = selectClimbUrls(sitemapXml, options.requests);
  const targetUrls = rewriteUrlsToOrigin(sourceUrls, options.origin);
  const databaseOutcomes = await runProbeRequests(options, fetchImpl);
  const climbOutcomes = await runRequests(targetUrls, options.concurrency, options.timeoutMs, fetchImpl);
  return { database: summarizeOutcomes(databaseOutcomes), climbs: summarizeOutcomes(climbOutcomes) };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  console.log(
    `PgBouncer cutover smoke origin=${options.origin} requests=${options.requests} concurrency=${options.concurrency} timeout_ms=${options.timeoutMs}`,
  );
  const report = await runCutoverSmoke(options);
  console.log(`database ${formatSummary(report.database)}`);
  console.log(`climbs   ${formatSummary(report.climbs)}`);
  const failures = report.database.failed + report.climbs.failed;
  if (failures > 0) throw new Error(`${failures} request(s) failed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`PgBouncer cutover smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
