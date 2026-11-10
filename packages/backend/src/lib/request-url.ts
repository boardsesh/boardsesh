/**
 * Reads a request target and Host the way the HTTP dispatcher does, or returns
 * null when `new URL` refuses them.
 *
 * Node's HTTP parser only checks that a target and a Host header are made of
 * legal bytes, which lets through plenty that `new URL` throws on: `GET //`,
 * `Host: x:abc`, `Host: ::1`, `Host: [::1`. An HTTP/1.0 request may have no Host
 * at all, and an empty one reaches here as `''`; both keep the `localhost` base.
 *
 * No imports: `instrument.ts` reaches this through `./sentry-sampling`, before
 * OpenTelemetry has patched anything.
 */
export function parseRequestTarget(target: string | undefined, host: string | undefined): URL | null {
  try {
    return new URL(target || '/', `http://${host || 'localhost'}`);
  } catch {
    return null;
  }
}
