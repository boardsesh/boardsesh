import { auroraUserAgent, assertAuroraBoardName, type AuroraBoardName, WEB_HOSTS } from './types';
import {
  assertAuroraResponseOk,
  createAuroraInvalidResponseError,
  createAuroraNetworkError,
  createAuroraTimeoutError,
  isAuroraRequestError,
} from './errors';

export type AuroraLiveBoardName = Exclude<AuroraBoardName, 'kilter'>;
export type AuroraLiveDisplay = {
  climbUuid: string;
  serialNumber: string;
  /** Canonical UTC timestamp, retaining all six fractional digits. */
  displayedAt: string;
  /** Unmodified server timestamp for the timestamp-only pagination contract. */
  rawTimestamp: string;
};

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PAGE_ENTRIES = 1000;

/** Aurora's naive display timestamps are UTC, as in its Android client. */
export function normalizeAuroraDisplayTime(timestamp: unknown): string | null {
  if (typeof timestamp !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/.exec(timestamp);
  if (!match) return null;
  const seconds = `${match[1]}T${match[2]}`;
  const instant = new Date(`${seconds}Z`);
  // Date.parse normalizes some invalid dates, such as February 30.
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 19) !== seconds) return null;
  return `${seconds}.${(match[3] ?? '').padEnd(6, '0')}Z`;
}

/** A malformed page fails as a whole, so a caller cannot advance past skipped rows. */
export function parseAuroraLiveHistory(response: unknown, serialNumber: string): AuroraLiveDisplay[] {
  if (!response || typeof response !== 'object' || !('exhibits' in response) || !Array.isArray(response.exhibits)) {
    throw createAuroraInvalidResponseError('/exhibits');
  }
  if (response.exhibits.length > MAX_PAGE_ENTRIES) throw createAuroraInvalidResponseError('/exhibits');
  return response.exhibits.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw createAuroraInvalidResponseError('/exhibits');
    const fields = entry as Record<string, unknown>;
    const displayedAt = normalizeAuroraDisplayTime(fields.created_at);
    if (
      typeof fields.climb_uuid !== 'string' ||
      !fields.climb_uuid.trim() ||
      fields.climb_uuid.length > 128 ||
      fields.serial_number !== serialNumber ||
      !displayedAt ||
      typeof fields.created_at !== 'string'
    ) {
      throw createAuroraInvalidResponseError('/exhibits');
    }
    return {
      climbUuid: fields.climb_uuid,
      serialNumber,
      displayedAt,
      rawTimestamp: fields.created_at,
    };
  });
}

async function readBoundedJson(response: Response, url: string): Promise<unknown> {
  const advertisedLength = Number(response.headers.get('content-length'));
  if (advertisedLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw createAuroraInvalidResponseError(url);
  }
  if (!response.body) throw createAuroraInvalidResponseError(url);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw createAuroraInvalidResponseError(url);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/** Read-only display history. Kilter uses its existing, separate integration. */
export async function fetchAuroraLiveHistory(
  board: AuroraLiveBoardName,
  serialNumber: string,
  token: string,
  options: { before?: string; after?: string; signal?: AbortSignal } = {},
): Promise<AuroraLiveDisplay[]> {
  assertAuroraBoardName(board);
  if ((board as AuroraBoardName) === 'kilter') throw new Error('Kilter has a separate live-history provider');
  if (!serialNumber || serialNumber.trim() !== serialNumber || serialNumber.length > 128 || !token) {
    throw new Error('Aurora live history requires a controller serial and session');
  }
  for (const timestamp of [options.before, options.after]) {
    if (timestamp !== undefined && !normalizeAuroraDisplayTime(timestamp)) throw new Error('Invalid display cursor');
  }
  const url = new URL('/exhibits', WEB_HOSTS[board]);
  url.searchParams.set('serial_number', serialNumber);
  if (options.before !== undefined) url.searchParams.set('before', options.before);
  if (options.after !== undefined) url.searchParams.set('after', options.after);
  const requestUrl = url.toString();
  try {
    const response = await fetch(requestUrl, {
      headers: { Accept: 'application/json', Cookie: `token=${token}`, 'User-Agent': auroraUserAgent(board) },
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    await assertAuroraResponseOk(response, requestUrl);
    const parsed = await readBoundedJson(response, requestUrl);
    return parseAuroraLiveHistory(parsed, serialNumber);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (isAuroraRequestError(error)) throw error;
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw createAuroraTimeoutError(requestUrl, error);
    }
    if (error instanceof TypeError) throw createAuroraNetworkError(requestUrl, error);
    throw createAuroraInvalidResponseError(requestUrl, error);
  }
}
