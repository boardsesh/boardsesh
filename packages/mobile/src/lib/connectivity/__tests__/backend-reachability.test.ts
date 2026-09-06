import { describe, expect, it, vi } from 'vitest';
import {
  classifyProbeError,
  classifyProbeResponse,
  getHealthProbeUrl,
  nextProbeDelayMs,
  probeBackend,
  HEALTH_PROBE_TIMEOUT_MS,
} from '../backend-reachability';

const HEALTHY_BODY = JSON.stringify({ status: 'healthy', database: { reachable: true, latencyMs: 3 } });
const DB_DOWN_BODY = JSON.stringify({ status: 'unhealthy', database: { reachable: false, error: 'timeout' } });

// The classification matrix is the whole reason a health probe beats "did the
// fetch throw?": a captive portal answers 200, Cloudflare answers 503, and a
// 404 means the server is perfectly fine. Getting any of these backwards would
// blame the wrong side of the connection in the UI and in telemetry.
describe('classifyProbeResponse', () => {
  it('reads our own healthy payload as healthy', () => {
    expect(classifyProbeResponse(200, HEALTHY_BODY)).toBe('healthy');
  });

  it('reads a 200 carrying HTML as a captive portal, not a healthy backend', () => {
    expect(classifyProbeResponse(200, '<html><body>Sign in to WiFi</body></html>')).toBe('captive_portal');
  });

  it('reads a redirect off the health path as a captive portal', () => {
    expect(classifyProbeResponse(302, '')).toBe('captive_portal');
    expect(classifyProbeResponse(307, '')).toBe('captive_portal');
  });

  it('keeps a 503 whose body is not our health payload as an edge verdict', () => {
    // A proxy in front of us can answer JSON too; `database: null` is not the

    // handler's outage payload and must not blame Postgres.

    expect(classifyProbeResponse(503, JSON.stringify({ database: null }))).toBe('edge');

    expect(classifyProbeResponse(503, JSON.stringify({ error: 'upstream' }))).toBe('edge');
  });

  it('reads our 503 health body as the database being down, not the edge', () => {
    expect(classifyProbeResponse(503, DB_DOWN_BODY)).toBe('db_down');
  });

  // A proxy's own 503 page carries no health body. Calling that `db_down` would
  // put a Postgres outage in telemetry every time the edge hiccupped.
  it('reads a bodyless 503 as an edge failure', () => {
    expect(classifyProbeResponse(503, '')).toBe('edge');
    expect(classifyProbeResponse(503, 'Service Unavailable')).toBe('edge');
  });

  it.each([502, 504, 521, 500])('reads a %d as an edge failure', (status) => {
    expect(classifyProbeResponse(status, 'Bad Gateway')).toBe('edge');
  });

  // THE bug this verdict exists to prevent: the server is up, the route is just
  // not what we asked for, and failing the whole app closed over that would be a
  // self-inflicted outage.
  it.each([404, 405, 429, 401, 403])('treats a %d as the server answering', (status) => {
    expect(classifyProbeResponse(status, '{"error":"nope"}')).toBe('answered_non_health');
  });

  it('treats a 200 of some other JSON as an answer, not a portal', () => {
    expect(classifyProbeResponse(200, '{"hello":"world"}')).toBe('answered_non_health');
  });
});

describe('classifyProbeError', () => {
  it('collapses every no-answer failure to transport — the store decides who is to blame', () => {
    expect(classifyProbeError(new TypeError('Network request failed'))).toBe('transport');
    expect(classifyProbeError(new Error('java.net.UnknownHostException'))).toBe('transport');
    expect(classifyProbeError(undefined)).toBe('transport');
  });
});

describe('nextProbeDelayMs', () => {
  it('walks 5s, 10s, 20s and then holds at 30s', () => {
    const withoutJitter = (attempt: number) => nextProbeDelayMs(attempt, () => 0.5);
    expect([0, 1, 2, 3, 4, 12].map(withoutJitter)).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);
  });

  it('stays inside +/-25% of the rung, so a recovering server sees a spread rather than a herd', () => {
    expect(nextProbeDelayMs(0, () => 0)).toBe(3_750);
    expect(nextProbeDelayMs(0, () => 1)).toBe(6_250);
    for (const random of [0.1, 0.37, 0.62, 0.99]) {
      const delay = nextProbeDelayMs(1, () => random);
      expect(delay).toBeGreaterThanOrEqual(7_500);
      expect(delay).toBeLessThanOrEqual(12_500);
    }
  });

  it('clamps a nonsensical attempt to the first rung rather than producing NaN', () => {
    expect(nextProbeDelayMs(-3, () => 0.5)).toBe(5_000);
    expect(nextProbeDelayMs(0.4, () => 0.5)).toBe(5_000);
  });
});

describe('probeBackend', () => {
  it('asks /health/db unauthenticated, uncached, behind a 5s deadline', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(HEALTHY_BODY));

    await expect(probeBackend(fetchImpl as unknown as typeof fetch)).resolves.toBe('healthy');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(getHealthProbeUrl());
    expect(String(url)).toContain('/health/db');
    // Never authenticatedFetch: this runs while the backend is SUSPECTED DEAD,
    // and that path would first try to refresh a token against the same dead
    // backend. No credentials for the same reason a portal may answer it.
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('no-store');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts on its own deadline rather than hanging with the request it is diagnosing', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      );

      const verdict = probeBackend(fetchImpl as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS);

      await expect(verdict).resolves.toBe('transport');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a transport verdict instead of throwing, so no caller needs a try/catch', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('Network request failed')));

    await expect(probeBackend(fetchImpl as unknown as typeof fetch)).resolves.toBe('transport');
  });

  it('treats a body that dies mid-read as transport, not as a healthy 200', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        status: 200,
        text: () => Promise.reject(new Error('connection reset')),
      } as unknown as Response),
    );

    await expect(probeBackend(fetchImpl as unknown as typeof fetch)).resolves.toBe('transport');
  });

  it('classifies our 503 database outage end to end', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(DB_DOWN_BODY, { status: 503 })));

    await expect(probeBackend(fetchImpl as unknown as typeof fetch)).resolves.toBe('db_down');
  });
});
