import { createTimeoutSignal } from '../abort-timeout';
import { BACKEND_URL } from '../env';

/**
 * What one `/health/db` round trip told us. Six outcomes because "the request
 * failed" is four different problems with four different owners:
 *
 *   healthy            — our handler answered 200 with its own payload. The
 *                        backend and its Postgres are both up.
 *   db_down            — our handler answered, and said Postgres is not
 *                        answering (503 with the health body). The backend
 *                        process is alive; the thing behind it is not.
 *   edge               — something in front of the backend answered with a 5xx
 *                        of its own (502/504, Cloudflare's 52x). The request
 *                        never reached a handler that could tell us anything.
 *   transport          — nothing answered at all: DNS, TLS, refused, or our own
 *                        5s deadline. Equally "the server is down" and "this
 *                        phone has no working uplink" — the store breaks that
 *                        tie by re-reading the device, never this module.
 *   captive_portal     — something answered, but it was not us: a redirect off
 *                        the health path, or a 200 carrying HTML. Hotel wifi,
 *                        a gym's sign-in page, a hijacking middlebox. A dead
 *                        uplink, not a dead server.
 *   answered_non_health— a real HTTP answer that is not our health payload
 *                        (404, 405, 429, 401, or a 200 of some other JSON). The
 *                        SERVER IS UP: whatever is wrong is about this route,
 *                        and failing the app closed over it would be a bug.
 */
export type ProbeVerdict = 'healthy' | 'db_down' | 'edge' | 'transport' | 'captive_portal' | 'answered_non_health';

/**
 * Deliberately short. The probe exists to answer "is the server there?" while a
 * climber stares at a spinner, so a slow answer is the same product outcome as
 * no answer — and the backend caches its own database check for 5s, so a
 * healthy round trip is a header exchange plus a cache read.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 5_000;

// 5s, 10s, 20s, then 30s forever. The first two rungs cover a deploy or a
// container restart (the outages that resolve on their own in under a minute);
// the flat tail keeps a long outage at two requests a minute per device instead
// of a ladder that eventually stops checking at all.
const PROBE_BACKOFF_LADDER_MS = [5_000, 10_000, 20_000, 30_000] as const;

// ±25%. Every device in a gym loses the backend at the same instant, so an
// unjittered ladder would hand the recovering server a synchronized thundering
// herd on each rung.
const PROBE_JITTER_FRACTION = 0.25;

export function getHealthProbeUrl(): string {
  return `${BACKEND_URL}/health/db`;
}

type HealthBody = { status?: unknown; database?: unknown };

/** The response body as an object, or null when it is not JSON we can read. */
function readHealthBody(bodyText: string): HealthBody | null {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as HealthBody;
  } catch {
    return null;
  }
}

/**
 * Turn one health response into a verdict. Pure, so the whole matrix is
 * testable without a network: the status alone is not enough, because a captive
 * portal answers 200 and Cloudflare answers 503.
 */
export function classifyProbeResponse(status: number, bodyText: string): ProbeVerdict {
  // A redirect off the health path is never our handler — only a portal or a
  // middlebox rewrites where this URL points.
  if (status >= 300 && status < 400) return 'captive_portal';

  const body = readHealthBody(bodyText);

  if (status === 200) {
    // 200 + HTML (or any non-JSON) is the portal signature: something served a
    // sign-in page under our URL.
    if (body === null) return 'captive_portal';
    if (body.status === 'healthy') return 'healthy';
    if (body.status === 'unhealthy') return 'db_down';
    // JSON, but not our payload. A server answered; it just was not this route.
    return 'answered_non_health';
  }

  // Our handler's own database failure carries the health body. A bare 503 from
  // a proxy in front of us carries none, and blaming Postgres for it would send
  // the wrong outage to telemetry.
  // `!= null` on purpose: a proxy that answers `{ "database": null }` is not our
  // handler either, and must stay an edge verdict.
  if (status === 503) return body?.status === 'unhealthy' || body?.database != null ? 'db_down' : 'edge';
  if (status >= 500) return 'edge';

  // Every 4xx: the server answered. Whatever is wrong is about this route or
  // this client, not about reachability, so it must never read as an outage.
  return 'answered_non_health';
}

/**
 * A probe that never got a response. DNS, TLS, connection refused, and our own
 * abort all collapse to the same fact — nothing answered — and the store, not
 * this module, decides whether the phone or the server is to blame.
 *
 * `error` is accepted and ignored so the call site reads as a classification,
 * and so splitting (say) a timeout from a refusal later needs no signature
 * change at the call site.
 */
export function classifyProbeError(error: unknown): 'transport' {
  void error;
  return 'transport';
}

/**
 * Delay before probe attempt `attempt` (0-based), jittered by ±25%. Clamped at
 * both ends: a negative or fractional attempt reads as the first rung, and
 * anything past the ladder holds at its last one.
 */
export function nextProbeDelayMs(attempt: number, random: () => number): number {
  const rung = Math.min(Math.max(Math.trunc(attempt), 0), PROBE_BACKOFF_LADDER_MS.length - 1);
  const baseDelayMs = PROBE_BACKOFF_LADDER_MS[rung];
  const jitter = (random() * 2 - 1) * PROBE_JITTER_FRACTION;
  return Math.round(baseDelayMs * (1 + jitter));
}

/**
 * One `/health/db` round trip. Never throws — every failure is a verdict.
 *
 * Deliberately NOT `authenticatedFetch`: this runs while the backend is
 * suspected dead, and `authenticatedFetch` would first try to refresh a token
 * against that same dead backend. `credentials: 'omit'` keeps the CORS
 * preflight simple and keeps a session cookie out of a request that may well be
 * answered by a captive portal.
 */
export async function probeBackend(fetchImpl: typeof fetch = fetch): Promise<ProbeVerdict> {
  try {
    const response = await fetchImpl(getHealthProbeUrl(), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: createTimeoutSignal(HEALTH_PROBE_TIMEOUT_MS),
    });
    // Read the body inside the try: a connection dropped mid-body aborts here,
    // and that is a transport failure like any other.
    const bodyText = await response.text();
    return classifyProbeResponse(response.status, bodyText);
  } catch (error) {
    return classifyProbeError(error);
  }
}
