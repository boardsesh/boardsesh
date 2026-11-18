import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { captureKioskPageLoad } from '../kiosk-telemetry';
const consent = vi.hoisted(() => ({ granted: false }));
vi.mock('../consent', () => ({ hasAnalyticsConsent: () => consent.granted }));
vi.mock('../backend-url', () => ({ getBackendHttpUrl: () => 'https://ws.boardsesh.com' }));
vi.mock('../production-hosts', () => ({ isProductionHost: () => true }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('kiosk operational telemetry', () => {
  it('sends nothing before an explicit yes', () => {
    consent.granted = false;
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'test');
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    captureKioskPageLoad();
    expect(network).not.toHaveBeenCalled();
  });
  it('sends only the operational allowlist with a fresh event ID after yes', () => {
    consent.granted = true;
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'test');
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => ({}));
    vi.stubGlobal('fetch', fetchMock);
    captureKioskPageLoad();
    captureKioskPageLoad();
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      batch: Array<{ properties: Record<string, unknown> }>;
    };
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string) as typeof first;
    expect(Object.keys(first.batch[0].properties).sort()).toEqual(
      ['$geoip_disable', '$process_person_profile', 'distinct_id', 'environment', 'kiosk'].sort(),
    );
    expect(first.batch[0].properties.$process_person_profile).toBe(false);
    expect(first.batch[0].properties.distinct_id).not.toBe(second.batch[0].properties.distinct_id);
    expect(fetchMock.mock.calls[0][0]).toBe('https://ws.boardsesh.com/api/posthog/batch/');
  });
});
