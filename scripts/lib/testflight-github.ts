/// <reference types="node" />

import { execFileSync } from 'node:child_process';

export const TESTFLIGHT_PREPARATION_MS = 65 * 60 * 1000;
const MAX_RETRIES = 3;
const RESPONSE_HEADERS = /HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n((?:[\w-]+:[^\r\n]*\r?\n)*)\r?\n/g;

type CommandRunner = (binary: string, argumentsList: string[]) => string;
type RetryOptions = {
  execute?: CommandRunner;
  now?: () => number;
  sleep?: (milliseconds: number) => void;
  warn?: (message: string) => void;
  deadline?: number;
};

function stream(error: unknown, name: 'stdout' | 'stderr'): string {
  if (typeof error !== 'object' || error === null || !(name in error)) return '';
  const contents: unknown = (error as Record<string, unknown>)[name];
  return typeof contents === 'string' ? contents : Buffer.isBuffer(contents) ? contents.toString('utf8') : '';
}

/** --include also prefixes each page inside gh's --paginate --slurp array. */
function response(output: string) {
  const blocks = [...output.matchAll(RESPONSE_HEADERS)];
  const last = blocks.at(-1);
  const headers = new Map<string, string>();
  for (const line of (last?.[2] ?? '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
  }
  return { status: Number(last?.[1]), headers, body: output.replace(RESPONSE_HEADERS, '') };
}

function rateLimited(error: unknown, output: ReturnType<typeof response>): boolean {
  if (output.status === 429) return true;
  if (
    output.status === 403 &&
    (output.headers.get('x-ratelimit-remaining') === '0' || output.headers.has('retry-after'))
  )
    return true;
  // GraphQL can report exhausted quota with HTTP 200. gh still exits nonzero.
  try {
    const payload: unknown = JSON.parse(output.body);
    if (typeof payload === 'object' && payload !== null && 'errors' in payload && Array.isArray(payload.errors)) {
      return (
        payload.errors.length > 0 &&
        payload.errors.every(
          (entry: unknown) =>
            typeof entry === 'object' && entry !== null && 'type' in entry && entry.type === 'RATE_LIMITED',
        )
      );
    }
  } catch {
    // Failed paginated calls may have incomplete JSON; gh's stderr still identifies the limit.
  }
  return (
    (output.status === 403 || !Number.isFinite(output.status)) &&
    /(?:^|\n)gh: [^\r\n]*(?:API rate limit exceeded|secondary rate limit|rate limit exceeded)/i.test(
      stream(error, 'stderr'),
    )
  );
}

function retryDelay(headers: Map<string, string>, attempt: number, now: number): number {
  const retryAfter = headers.get('retry-after');
  const afterMs =
    retryAfter === undefined
      ? NaN
      : /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - now;
  const reset = headers.get('x-ratelimit-reset');
  const resetMs =
    headers.get('x-ratelimit-remaining') === '0' && reset && /^\d+$/.test(reset) ? Number(reset) * 1000 - now : NaN;
  const serverDelays = [afterMs, resetMs].filter(Number.isFinite);
  return serverDelays.length > 0 ? Math.max(1000, ...serverDelays) : 60_000 * 2 ** attempt;
}

function preparationDeadline(now: number): number {
  const configured = process.env.TESTFLIGHT_PREPARATION_DEADLINE_MS;
  if (configured === undefined) return now + TESTFLIGHT_PREPARATION_MS;
  if (!/^\d+$/.test(configured) || !Number.isSafeInteger(Number(configured)))
    throw new Error('Invalid TestFlight preparation deadline.');
  return Number(configured);
}

/** Keep the synchronous CLI contract; retry only read-only GitHub API queries. */
export function createTestflightCommandRunner(options: RetryOptions = {}): CommandRunner {
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? preparationDeadline(now());
  const execute =
    options.execute ??
    ((binary, argumentsList) =>
      execFileSync(binary, argumentsList, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...(binary === 'gh' ? { timeout: Math.max(1, deadline - now()) } : {}),
      }));
  const warn = options.warn ?? ((message) => console.warn(message));
  const sleep =
    options.sleep ??
    ((milliseconds) => {
      const until = now() + milliseconds;
      const signal = new Int32Array(new SharedArrayBuffer(4));
      while (now() < until) Atomics.wait(signal, 0, 0, Math.min(60_000, until - now()));
    });
  return (binary, argumentsList) => {
    if (binary !== 'gh' || argumentsList[0] !== 'api') return execute(binary, argumentsList);
    for (let attempt = 0; ; attempt++) {
      if (now() >= deadline)
        throw new Error(
          'TestFlight preparation exceeded 65 minutes; rerun distribution with the original source_run_id.',
        );
      try {
        return response(execute(binary, ['api', '--include', ...argumentsList.slice(1)])).body;
      } catch (error) {
        const output = response(stream(error, 'stdout'));
        if (!rateLimited(error, output)) throw error;
        if (attempt === MAX_RETRIES)
          throw new Error(
            'GitHub API rate limit persisted after three retries; rerun distribution with the original source_run_id.',
          );
        const delay = retryDelay(output.headers, attempt, now());
        if (now() + delay >= deadline)
          throw new Error(
            'GitHub API rate limit reset exceeds the 65-minute preparation deadline; rerun distribution with the original source_run_id.',
          );
        warn(
          `[testflight] GitHub API rate limited; retry ${attempt + 1}/${MAX_RETRIES} in ${Math.ceil(delay / 1000)} seconds.`,
        );
        sleep(delay);
      }
    }
  };
}
