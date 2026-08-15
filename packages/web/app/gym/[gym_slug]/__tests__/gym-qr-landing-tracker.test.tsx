import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render } from '@testing-library/react';
import React from 'react';

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

const GymQrLandingTracker = (await import('../gym-qr-landing-tracker')).default;

// The once-per-document guard is module-level state that deliberately survives
// unmounts, so every test uses a slug of its own rather than resetting it.
beforeEach(() => {
  trackGymFunnelEvent.mockReset();
  window.history.replaceState(null, '', '/gym/test');
});

describe('GymQrLandingTracker', () => {
  it('renders nothing and reports the scan once on mount', () => {
    const { container } = render(<GymQrLandingTracker gymSlug="mount-once" medium="poster" />);

    expect(container.innerHTML).toBe('');
    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym QR Scanned',
      properties: { medium: 'poster', gymSlug: 'mount-once' },
    });
  });

  it('does not report again on a re-render with the same landing', () => {
    const { rerender } = render(<GymQrLandingTracker gymSlug="rerender" medium="poster" />);
    rerender(<GymQrLandingTracker gymSlug="rerender" medium="poster" />);
    rerender(<GymQrLandingTracker gymSlug="rerender" medium="poster" />);

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
  });

  it('does not report again when the same landing remounts — a StrictMode double-invoke or a return visit', () => {
    render(<GymQrLandingTracker gymSlug="remount" medium="poster" />).unmount();
    render(<GymQrLandingTracker gymSlug="remount" medium="poster" />);

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
  });

  it('reports a different gym landed on from the same medium', () => {
    render(<GymQrLandingTracker gymSlug="first-gym" medium="kiosk" />);
    render(<GymQrLandingTracker gymSlug="second-gym" medium="kiosk" />);

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(2);
  });

  it('strips the attribution params so a shared link cannot re-credit the poster', () => {
    window.history.replaceState(null, '', '/gym/strip?src=qr&medium=poster&tab=boards');

    render(<GymQrLandingTracker gymSlug="strip" medium="poster" />);

    expect(window.location.search).toBe('?tab=boards');
    expect(window.location.pathname).toBe('/gym/strip');
  });

  it('leaves a URL that carries no attribution params alone', () => {
    window.history.replaceState(null, '', '/gym/no-params?tab=boards');

    render(<GymQrLandingTracker gymSlug="no-params" medium="poster" />);

    expect(window.location.search).toBe('?tab=boards');
  });
});
