// The orchestrator starts Metro with --clear (see expo-web-start-command.ts),
// so every prewarm is a full cold bundle. 120s covers a typical machine;
// override for slower/loaded hosts where the cold compile runs longer.
const READY_TIMEOUT_OVERRIDE = Number(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.BOARDSESH_EXPO_WEB_READY_TIMEOUT_MS,
);
export const DEFAULT_EXPO_WEB_READY_TIMEOUT_MS =
  Number.isFinite(READY_TIMEOUT_OVERRIDE) && READY_TIMEOUT_OVERRIDE > 0 ? READY_TIMEOUT_OVERRIDE : 120_000;

const DEFAULT_RETRY_INTERVAL_MS = 500;
const EXPO_WEB_SHELL_PATH = '/app';

type FetchResponse = Pick<Response, 'arrayBuffer' | 'ok' | 'status' | 'statusText' | 'text'>;

export type ExpoWebFetch = (url: string, init: RequestInit) => Promise<FetchResponse>;

type PrewarmExpoWebOptions = {
  origin: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
  fetchImpl?: ExpoWebFetch;
  isProcessRunning?: () => boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

class FatalExpoWebReadinessError extends Error {}

export type ExpoWebPrewarmResult = {
  shellUrl: string;
  bundleUrl: string;
};

function decodeHtmlAttribute(attribute: string): string {
  return attribute
    .replaceAll('&amp;', '&')
    .replaceAll('&#38;', '&')
    .replaceAll('&#x26;', '&')
    .replaceAll('&#X26;', '&');
}

/**
 * Return Expo Router's web entry bundle from the generated shell. Metro emits
 * one external entry script for this page; fetching it is what triggers the
 * expensive cold production-mode bundle.
 */
export function extractExpoWebEntryBundleSource(html: string): string | null {
  const scriptSourcePattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/giu;

  for (const match of html.matchAll(scriptSourcePattern)) {
    const source = decodeHtmlAttribute(match[2]);
    if (source.includes('entry.bundle') && source.includes('platform=web')) {
      return source;
    }
  }

  return null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function createDeadlineSignal(deadlineMs: number, now: () => number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const remainingMs = Math.max(1, deadlineMs - now());
  const timeoutId = setTimeout(() => controller.abort(), remainingMs);

  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timeoutId),
  };
}

async function fetchBeforeDeadline<Result>(
  fetchImpl: ExpoWebFetch,
  url: string,
  deadlineMs: number,
  now: () => number,
  consume: (response: FetchResponse) => Promise<Result>,
): Promise<Result> {
  const deadlineSignal = createDeadlineSignal(deadlineMs, now);
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: deadlineSignal.signal,
    });
    return await consume(response);
  } finally {
    deadlineSignal.dispose();
  }
}

/**
 * Wait for Expo's HTML shell and fully consume its generated entry bundle.
 * Next must not start before this resolves: otherwise its external rewrite
 * accepts `/app` while Metro is still offline or compiling and returns a 500.
 */
export async function prewarmExpoWeb({
  origin,
  timeoutMs = DEFAULT_EXPO_WEB_READY_TIMEOUT_MS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  fetchImpl = fetch,
  isProcessRunning = () => true,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: PrewarmExpoWebOptions): Promise<ExpoWebPrewarmResult> {
  if (timeoutMs <= 0) throw new Error('Expo web readiness timeout must be greater than zero');

  const normalizedOrigin = origin.replace(/\/$/u, '');
  const shellUrl = `${normalizedOrigin}${EXPO_WEB_SHELL_PATH}`;
  const deadlineMs = now() + timeoutMs;
  let lastFailure = 'Expo has not accepted a connection yet';

  while (now() < deadlineMs) {
    if (!isProcessRunning()) {
      throw new Error(`Expo web exited before its browser bundle was ready. Check the Metro output above.`);
    }

    try {
      const shellResult = await fetchBeforeDeadline(fetchImpl, shellUrl, deadlineMs, now, async (response) => ({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        html: response.ok ? await response.text() : null,
      }));
      if (!shellResult.ok) {
        lastFailure = `shell request returned ${shellResult.status} ${shellResult.statusText}`.trim();
      } else {
        const entryBundleSource = extractExpoWebEntryBundleSource(shellResult.html ?? '');
        if (!entryBundleSource) {
          throw new FatalExpoWebReadinessError(
            `Expo web returned HTML at ${shellUrl}, but it did not contain the Expo Router web entry bundle.`,
          );
        }

        const bundleUrl = new URL(entryBundleSource, `${normalizedOrigin}/`).toString();
        await fetchBeforeDeadline(fetchImpl, bundleUrl, deadlineMs, now, async (response) => {
          if (!response.ok) {
            throw new FatalExpoWebReadinessError(
              `Expo web entry bundle returned ${response.status} ${response.statusText}. Check the Metro output above.`,
            );
          }

          // Metro can stream a large bundle. Consume the body before starting
          // Next so a late transform or socket failure cannot leak through the
          // external rewrite as an Internal Server Error.
          await response.arrayBuffer();
        });
        return { shellUrl, bundleUrl };
      }
    } catch (error) {
      if (error instanceof FatalExpoWebReadinessError) {
        throw error;
      }

      lastFailure = describeError(error);
      if (!isProcessRunning()) {
        throw new Error(
          `Expo web exited before its browser bundle was ready. Last failure: ${lastFailure}. Check the Metro output above.`,
        );
      }
    }

    const remainingMs = deadlineMs - now();
    if (remainingMs > 0) {
      await sleep(Math.min(retryIntervalMs, remainingMs));
    }
  }

  throw new Error(
    `Expo web did not become ready at ${shellUrl} within ${timeoutMs}ms. Last failure: ${lastFailure}. ` +
      `Check the Metro output above and retry once the underlying error is fixed.`,
  );
}
