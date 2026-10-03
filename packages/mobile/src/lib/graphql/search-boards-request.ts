import type { SearchBoardsInput } from '@boardsesh/graphql/generated/graphql';
import { SEARCH_BOARDS, type SearchBoardsQueryResponse } from './operations';
import { getHttpClient } from './client';
import { readGraphqlRateLimit } from './extract-error-message';
import { createAbortError } from './request-timeout';
import { shouldRetryQuery } from './query-retry';
import { reportHandledError } from '../error-reporting';

const RATE_LIMIT_FALLBACK_MS = 60_000;
const RATE_LIMIT_BUFFER_MS = 250;
// Shared across query keys: changing filters must not bypass server backpressure.
let cooldownUntil = 0;

function rateLimitDelay(error: unknown): number | null {
  const rateLimit = readGraphqlRateLimit(error);
  if (!rateLimit) return null;
  return (
    (rateLimit.retryAfterSeconds === null ? RATE_LIMIT_FALLBACK_MS : rateLimit.retryAfterSeconds * 1000) +
    RATE_LIMIT_BUFFER_MS
  );
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError('Board search cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError('Board search cancelled'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function requestSearchBoards(
  input: SearchBoardsInput,
  signal: AbortSignal,
): Promise<SearchBoardsQueryResponse> {
  // Re-read after each wait: another active search may have extended the deadline.
  while (cooldownUntil > Date.now()) await wait(cooldownUntil - Date.now(), signal);
  if (signal.aborted) throw createAbortError('Board search cancelled');
  try {
    return await getHttpClient().request<SearchBoardsQueryResponse>({
      document: SEARCH_BOARDS,
      variables: { input },
      signal,
    });
  } catch (error) {
    const delay = rateLimitDelay(error);
    if (delay !== null && !signal.aborted) {
      cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
      reportHandledError(error, { tags: { source: 'board-search', kind: 'query' } });
    }
    throw error;
  }
}

export function shouldRetryBoardSearch(failureCount: number, error: unknown): boolean {
  if (readGraphqlRateLimit(error)) return failureCount < 2;
  return shouldRetryQuery(failureCount, error);
}

export function boardSearchRetryDelay(failureCount: number, error: unknown): number {
  return rateLimitDelay(error) ?? Math.min(1000 * 2 ** failureCount, 30_000);
}

export function resetBoardSearchCooldownForTests(): void {
  cooldownUntil = 0;
}
