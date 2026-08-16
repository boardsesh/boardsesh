import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render } from '@testing-library/react';
import React from 'react';

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

const trackerModule = await import('../gym-qr-landing-tracker');
const GymQrLandingTracker = trackerModule.default;
const { __resetReportedScansForTests } = trackerModule;

beforeEach(() => {
  trackGymFunnelEvent.mockReset();
  // The dedupe Set is module-level and outlives unmounts on purpose; without
  // this a later test reusing a slug would assert nothing and still pass.
  __resetReportedScansForTests();
  window.history.replaceState(null, '', '/gym/test');
});

describe('GymQrLandingTracker', () => {
  it('renders nothing and reports the scan once on mount', () => {
    const { container } = render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);

    expect(container.innerHTML).toBe('');
    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym QR Scanned',
      properties: { medium: 'poster', gymSlug: 'boulderwelt' },
    });
  });

  it('does not report again on a re-render with the same landing', () => {
    const { rerender } = render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);
    rerender(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);
    rerender(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
  });

  it('does not report again when the same landing remounts — a StrictMode double-invoke or a return visit', () => {
    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />).unmount();
    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
  });

  it('reports a different gym landed on from the same medium', () => {
    render(<GymQrLandingTracker gymSlug="first-gym" medium="kiosk" />);
    render(<GymQrLandingTracker gymSlug="second-gym" medium="kiosk" />);

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(2);
  });

  it('strips the attribution params so a shared link cannot re-credit the poster', () => {
    window.history.replaceState(null, '', '/gym/boulderwelt?src=qr&medium=poster&tab=boards');

    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);

    expect(window.location.search).toBe('?tab=boards');
    expect(window.location.pathname).toBe('/gym/boulderwelt');
  });

  it('still strips the params on a repeat landing it does not count', () => {
    // gym A → gym B → back to gym A on the poster URL. The event is rightly
    // deduped, but the address bar is the thing that gets shared, so it has to
    // be cleaned every time — not only on the landing that happened to be first.
    window.history.replaceState(null, '', '/gym/boulderwelt?src=qr&medium=poster');
    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />).unmount();

    window.history.replaceState(null, '', '/gym/boulderwelt?src=qr&medium=poster');
    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);

    expect(window.location.search).toBe('');
    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
  });

  it('leaves a URL that carries no attribution params alone', () => {
    window.history.replaceState(null, '', '/gym/boulderwelt?tab=boards');

    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);

    expect(window.location.search).toBe('?tab=boards');
  });
});
