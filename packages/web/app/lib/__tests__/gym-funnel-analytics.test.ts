import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { gymClaimResult, gymQrScanned, GYM_FUNNEL_EVENTS } from '@boardsesh/analytics';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track: trackMock }));

const { trackGymFunnelEvent, viewerStateFrom } = await import('../gym-funnel-analytics');

beforeEach(() => {
  trackMock.mockReset();
});

describe('trackGymFunnelEvent', () => {
  it('forwards a contract payload to track() as name + properties', () => {
    trackGymFunnelEvent(gymQrScanned({ medium: 'poster', gymSlug: 'boulderwelt' }));

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith(GYM_FUNNEL_EVENTS.QrScanned, {
      medium: 'poster',
      gymSlug: 'boulderwelt',
    });
  });

  it('does not rename, reorder or drop properties on the way through', () => {
    trackGymFunnelEvent(gymClaimResult({ status: 'admin_review', gymUuid: 'gym-1' }));

    const [name, properties] = trackMock.mock.calls[0];
    expect(name).toBe('Gym Claim Result');
    expect(Object.keys(properties as Record<string, unknown>).sort()).toEqual(['gymUuid', 'status']);
  });
});

describe('viewerStateFrom', () => {
  it('maps a settled authenticated answer to signed-in', () => {
    expect(viewerStateFrom(true)).toBe('signed-in');
  });

  it('maps a settled anonymous answer to signed-out', () => {
    expect(viewerStateFrom(false)).toBe('signed-out');
  });

  it('takes a boolean, so a pre-hydration session status cannot reach it', () => {
    // The signature is the guard. Callers must resolve `loading` before they get
    // here — a helper that accepted next-auth's status would silently bucket
    // every not-yet-settled click as signed-out.
    const acceptsBooleanOnly: (isAuthenticated: boolean) => string = viewerStateFrom;
    expect(acceptsBooleanOnly(true)).toBe('signed-in');
  });
});
