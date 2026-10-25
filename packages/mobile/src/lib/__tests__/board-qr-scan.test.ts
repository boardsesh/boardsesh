import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_BOARD_TYPES, SHARED_EVENTS } from '@boardsesh/analytics';
import { grantAnalyticsForTest, grantedConsent } from '../../../test/consent-fixture';
import { AUTH_CONVERSION_WAIT_MS } from '../consent-bound-analytics';
import { updateConsentState } from '../consent-state';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics', () => ({ track: analytics.track }));
// The real runner, counted: each one opens its own consent subscription.
const runners = vi.hoisted(() => ({ created: 0 }));
vi.mock('../consent-bound-analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../consent-bound-analytics')>();
  return {
    ...actual,
    createConsentBoundAnalyticsRunner: (...args: Parameters<typeof actual.createConsentBoundAnalyticsRunner>) => {
      runners.created += 1;
      return actual.createConsentBoundAnalyticsRunner(...args);
    },
  };
});

const {
  BOARD_QR_SCAN_DEDUPE_MS,
  boardQrScanMedium,
  recentBoardQrScanCountForTests,
  resetBoardQrScansForTests,
  trackBoardQrScan,
} = await import('../board-qr-scan');

const LANDING = '/b/garage-spray';

describe('boardQrScanMedium', () => {
  it.each(['board', 'kiosk'] as const)('reads a %s scan', (medium) => {
    expect(boardQrScanMedium({ src: 'qr', medium })).toBe(medium);
  });

  // The strict www parser: every ambiguity is "not a scan".
  it.each([
    ['no params', {}],
    ['src alone', { src: 'qr' }],
    ['medium alone', { medium: 'board' }],
    ['another src', { src: 'email', medium: 'board' }],
    ['an upper-case src', { src: 'QR', medium: 'board' }],
    ['an unknown medium', { src: 'qr', medium: 'flyer' }],
    // The gym poster's medium: no board code prints it.
    ['the gym poster medium', { src: 'qr', medium: 'poster' }],
    ['a repeated medium', { src: 'qr', medium: ['board', 'kiosk'] }],
    ['a repeated src', { src: ['qr', 'qr'], medium: 'board' }],
  ])('is not a scan with %s', (_label, params) => {
    expect(boardQrScanMedium(params)).toBeNull();
  });
});

describe('trackBoardQrScan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    analytics.track.mockClear();
    runners.created = 0;
    resetBoardQrScansForTests();
    grantAnalyticsForTest();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("sends the app's scan with the medium and the board type", () => {
    trackBoardQrScan('board', 'spray', LANDING);

    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardQrScanned, {
      medium: 'board',
      surface: 'app',
      boardType: 'spray',
    });
  });

  // docs/spray-walls.md, "Telemetry": nothing that identifies the wall. A
  // slug or a uuid handed over as the type arrives as null, and the payload
  // has no other field to carry one.
  it.each(['garage-spray', '0f8fad5b-d9cb-469f-a165-70867728950e', 'Marco’s Garage'])(
    'never sends %s, even when it is passed as the board type',
    (identifier) => {
      trackBoardQrScan('kiosk', identifier, LANDING);

      const [, properties] = analytics.track.mock.calls[0] as [string, Record<string, unknown>];
      expect(Object.keys(properties).sort()).toEqual(['boardType', 'medium', 'surface']);
      expect(properties.boardType).toBeNull();
      expect(JSON.stringify(properties)).not.toContain(identifier);
    },
  );

  it('keeps every board type it knows', () => {
    for (const boardType of ANALYTICS_BOARD_TYPES) {
      analytics.track.mockClear();
      trackBoardQrScan('board', boardType, `/b/${boardType}`);
      expect(analytics.track.mock.calls[0]?.[1]).toMatchObject({ boardType });
    }
  });

  // A signed-out cold start can reach the route twice: the consent prompt's
  // deferred destination and the sign-in replay each mount a screen.
  it('counts the same landing once across two route screens', () => {
    trackBoardQrScan('board', 'spray', LANDING, 1_000);
    trackBoardQrScan('board', 'spray', LANDING, 1_000 + BOARD_QR_SCAN_DEDUPE_MS - 1);

    expect(analytics.track).toHaveBeenCalledTimes(1);
  });

  it('counts a second scan of the same code once the window has passed', () => {
    trackBoardQrScan('board', 'spray', LANDING, 1_000);
    trackBoardQrScan('board', 'spray', LANDING, 1_000 + BOARD_QR_SCAN_DEDUPE_MS);

    expect(analytics.track).toHaveBeenCalledTimes(2);
  });

  it('forgets landings once their window has passed', () => {
    trackBoardQrScan('board', 'spray', LANDING, 1_000);
    trackBoardQrScan('board', 'kilter', '/b/the-garage', 2_000);
    expect(recentBoardQrScanCountForTests()).toBe(2);

    trackBoardQrScan('kiosk', 'kilter', '/b/another', 2_000 + BOARD_QR_SCAN_DEDUPE_MS);
    expect(recentBoardQrScanCountForTests()).toBe(1);
  });

  it('counts another board or another medium straight away', () => {
    trackBoardQrScan('board', 'spray', LANDING, 1_000);
    trackBoardQrScan('kiosk', 'spray', LANDING, 1_001);
    trackBoardQrScan('board', 'kilter', '/b/the-garage', 1_002);

    expect(analytics.track).toHaveBeenCalledTimes(3);
  });

  // A cold-start scan can open the board before the SDK is ready.
  it('waits for the SDK when consent is already given', () => {
    updateConsentState({ sdkReady: false });

    trackBoardQrScan('board', 'kilter', LANDING);
    expect(analytics.track).not.toHaveBeenCalled();

    updateConsentState({ sdkReady: true });
    expect(analytics.track).toHaveBeenCalledTimes(1);
  });

  // Each runner holds a consent subscription for up to two minutes; scans that
  // wait for the SDK share one rather than piling up.
  it('shares one waiting runner across scans while the SDK is not ready', () => {
    updateConsentState({ sdkReady: false });

    trackBoardQrScan('board', 'kilter', '/b/one');
    trackBoardQrScan('kiosk', 'kilter', '/b/two');
    trackBoardQrScan('board', 'spray', '/b/three');
    expect(runners.created).toBe(1);
    expect(analytics.track).not.toHaveBeenCalled();

    updateConsentState({ sdkReady: true });
    expect(analytics.track).toHaveBeenCalledTimes(3);
  });

  it('opens a new runner once the held one has timed out', () => {
    updateConsentState({ sdkReady: false });
    trackBoardQrScan('board', 'kilter', '/b/one');
    vi.advanceTimersByTime(AUTH_CONVERSION_WAIT_MS);

    trackBoardQrScan('board', 'kilter', '/b/two');
    expect(runners.created).toBe(2);
    updateConsentState({ sdkReady: true });
    // The first scan timed out with its runner; the second still lands.
    expect(analytics.track).toHaveBeenCalledTimes(1);
  });

  it('opens no runner at all without consent', () => {
    updateConsentState({ record: { ...grantedConsent, analytics: 'denied' }, sdkReady: false });

    trackBoardQrScan('board', 'kilter', '/b/one');
    trackBoardQrScan('board', 'kilter', '/b/two');
    expect(runners.created).toBe(0);
  });

  // A later Allow must never replay a scan made before consent.
  it('drops the scan without consent, and a later Allow does not bring it back', () => {
    updateConsentState({ record: { ...grantedConsent, analytics: 'denied' }, sdkReady: false });

    trackBoardQrScan('board', 'kilter', LANDING);
    grantAnalyticsForTest();

    expect(analytics.track).not.toHaveBeenCalled();
  });
});
