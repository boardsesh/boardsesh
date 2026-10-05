import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countLitHolds, reportScreenshotSmokeContent, reportScreenshotSmokeError } from '../screenshot-smoke';

const SMOKE_URL = 'http://localhost:19870/smoke';

describe('screenshot smoke pings', () => {
  const fetchMock = vi.fn<(url: string) => Promise<{ ok: boolean }>>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends nothing unless the orchestrator named a smoke URL', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_SMOKE_URL', '');
    reportScreenshotSmokeContent('/home', 3);
    reportScreenshotSmokeError(new Error('boom'));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a route and its count', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_SMOKE_URL', SMOKE_URL);
    reportScreenshotSmokeContent('/home', 12);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`${SMOKE_URL}?kind=content&route=%2Fhome&count=12`);
  });

  it('reports the crash screen with a bounded, encoded message', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_SMOKE_URL', SMOKE_URL);
    reportScreenshotSmokeError(new TypeError(`bad & broken ${'x'.repeat(500)}`));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const query = new URL(fetchMock.mock.calls[0][0]).searchParams;
    expect(query.get('kind')).toBe('error');
    expect(query.get('message')).toMatch(/^TypeError: bad & broken x+$/);
    expect(query.get('message')).toHaveLength(300);
  });

  it('counts the holds a frame string lights', () => {
    expect(countLitHolds('p1083r15p1117r15p1164r12')).toBe(3);
    expect(countLitHolds('')).toBe(0);
  });
});
