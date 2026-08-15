import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AURORA_PROXY_SUNSET_DATE, DEPRECATED_AURORA_PROXY_EVENT } from '@/app/lib/api-deprecation';
import { GET, POST } from '../route';

vi.mock('server-only', () => ({}));

const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics.server', () => ({
  track: (...args: Parameters<typeof mockTrack>) => mockTrack(...args),
}));

const routeProps = { params: Promise.resolve({ board_name: 'kilter' }) };

function proxyRequest(): Request {
  return new Request('https://www.boardsesh.com/api/v1/kilter/proxy/login', { method: 'POST' });
}

describe('POST /api/v1/[board_name]/proxy/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockResolvedValue(undefined);
  });

  it('answers 410 Gone', async () => {
    expect((await POST(proxyRequest(), routeProps)).status).toBe(410);
  });

  it('carries the RFC 9745 Deprecation header as an sf-date', async () => {
    const deprecation = (await POST(proxyRequest(), routeProps)).headers.get('Deprecation');
    // "@" + integer epoch seconds. `Deprecation: true` is the superseded draft form.
    expect(deprecation).toMatch(/^@\d{10}$/);
  });

  it('carries the RFC 8594 Sunset header at the W-25b removal date', async () => {
    // Pinned, not derived: the PR body records this date and W-25b is scheduled on it.
    expect((await POST(proxyRequest(), routeProps)).headers.get('Sunset')).toBe('Thu, 01 Oct 2026 00:00:00 GMT');
    expect(AURORA_PROXY_SUNSET_DATE.toUTCString()).toBe('Thu, 01 Oct 2026 00:00:00 GMT');
  });

  it('sunsets after it deprecates', async () => {
    const response = await POST(proxyRequest(), routeProps);
    const deprecatedAt = Number(response.headers.get('Deprecation')!.slice(1)) * 1000;
    expect(Date.parse(response.headers.get('Sunset')!)).toBeGreaterThan(deprecatedAt);
  });

  it('answers GET the same way, so a browser hit is not a 405', async () => {
    const response = await GET(proxyRequest(), routeProps);
    expect(response.status).toBe(410);
    expect(response.headers.get('Sunset')).toBe('Thu, 01 Oct 2026 00:00:00 GMT');
  });

  it('points at human-readable context and is not cached', async () => {
    const response = await POST(proxyRequest(), routeProps);
    expect(response.headers.get('Link')).toContain('rel="deprecation"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('counts the call so W-25b reads a number instead of arguing from "no in-repo caller"', async () => {
    const request = proxyRequest();

    await POST(request, routeProps);

    // Endpoint and board only — the request body carried Aurora credentials.
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(
      DEPRECATED_AURORA_PROXY_EVENT,
      { endpoint: 'login', boardName: 'kilter' },
      { headers: request.headers },
    );
  });

  it('still answers 410 when telemetry rejects', async () => {
    mockTrack.mockRejectedValue(new Error('analytics down'));

    expect((await POST(proxyRequest(), routeProps)).status).toBe(410);
  });
});
