/**
 * The one HTTP path the Meta and Reddit ad clients use. Tokens travel in
 * headers or form bodies only, never in a URL, and no error message carries a
 * URL query, a header or a request body.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type Row = Record<string, unknown>;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface RequestOptions {
  label: string;
  /** Reads retry twice on 429/5xx; writes never retry, a rerun rediscovers what landed. */
  read: boolean;
  /** Secrets to scrub from any error text, whatever the source. */
  secrets: string[];
  sleep?: (milliseconds: number) => Promise<void>;
}

export function redact(text: string, secrets: string[]): string {
  let scrubbed = text;
  for (const secret of secrets) if (secret.length >= 4) scrubbed = scrubbed.split(secret).join('[redacted]');
  // Belt and braces: drop anything that looks like a bearer token or a token query parameter.
  return scrubbed
    .replace(/(access_token|refresh_token|client_secret)=[^&\s"]+/gi, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
}

function errorDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const error = (body as Row).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const detail = error as Row;
    const parts = [detail.code, detail.type, detail.message].filter(
      (part) => typeof part === 'string' || typeof part === 'number',
    );
    return parts.join(' ');
  }
  const message = (body as Row).message;
  return typeof message === 'string' ? message : '';
}

export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  options: RequestOptions,
): Promise<Row> {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      if (options.read && attempt < 2) {
        await sleep((attempt + 1) * 2000);
        continue;
      }
      throw new Error(`${options.label} failed: network error; rerun plan to see what landed`);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = undefined;
    }
    if (response.ok && body && typeof body === 'object' && !Array.isArray(body)) return body as Row;
    if (options.read && attempt < 2 && RETRYABLE.has(response.status)) {
      await sleep((attempt + 1) * 2000);
      continue;
    }
    const detail = redact(errorDetail(body), options.secrets).slice(0, 300);
    throw new Error(
      `${options.label} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}${options.read ? '' : '; rerun plan to see what landed'}`,
    );
  }
}

/** Follow a server-provided next-page URL only on the host we started from. */
export function assertSameOrigin(nextUrl: string, origin: string): string {
  const parsed = new URL(nextUrl);
  if (parsed.origin !== origin) throw new Error(`Refusing to follow a pagination link off ${origin}`);
  return nextUrl;
}
