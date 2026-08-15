import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { gymClaimResult, gymQrScanned, GYM_FUNNEL_EVENTS } from '@boardsesh/analytics';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track: trackMock }));

const { trackGymFunnelEvent, viewerStateFromSessionStatus } = await import('../gym-funnel-analytics');

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

describe('viewerStateFromSessionStatus', () => {
  it('reports an authenticated session as signed-in', () => {
    expect(viewerStateFromSessionStatus('authenticated')).toBe('signed-in');
  });

  it('reports an unauthenticated session as signed-out', () => {
    expect(viewerStateFromSessionStatus('unauthenticated')).toBe('signed-out');
  });

  it('reports a still-resolving session as signed-out rather than a third bucket', () => {
    // A click that beats hydration is the same funnel step as a signed-out one:
    // both are about to meet the auth wall.
    expect(viewerStateFromSessionStatus('loading')).toBe('signed-out');
  });
});
