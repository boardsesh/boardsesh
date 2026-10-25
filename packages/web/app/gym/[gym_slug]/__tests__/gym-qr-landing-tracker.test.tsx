import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render } from '@testing-library/react';
import React from 'react';

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

// The real provider settles after hydration; each test says where consent stands.
const consentState = vi.hoisted(() => ({ granted: true }));
vi.mock('@/app/components/consent/consent-provider', () => ({
  useConsent: () => ({ granted: consentState.granted }),
}));

const trackerModule = await import('../gym-qr-landing-tracker');
const GymQrLandingTracker = trackerModule.default;
const { __resetReportedScansForTests } = trackerModule;

/** The address-bar cleanup waits one task (see the component), so tests run the timers. */
function flushStrip(): void {
  vi.runOnlyPendingTimers();
}

beforeEach(() => {
  vi.useFakeTimers();
  trackGymFunnelEvent.mockReset();
  consentState.granted = true;
  // The dedupe Set is module-level and outlives unmounts on purpose; without
  // this a later test reusing a slug would assert nothing and still pass.
  __resetReportedScansForTests();
  window.history.replaceState(null, '', '/gym/test');
});

afterEach(() => {
  vi.useRealTimers();
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
    flushStrip();

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
    flushStrip();

    expect(window.location.search).toBe('');
    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
  });

  it('waits for consent to settle, then reports the scan once', () => {
    // A poster scan hydrates before the session and the region lookup answer,
    // and `track()` drops anything sent before then. Counting on mount lost it.
    consentState.granted = false;
    window.history.replaceState(null, '', '/gym/boulderwelt?src=qr&medium=poster');

    const { rerender } = render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);
    flushStrip();

    expect(trackGymFunnelEvent).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');

    consentState.granted = true;
    rerender(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);
    rerender(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym QR Scanned',
      properties: { medium: 'poster', gymSlug: 'boulderwelt' },
    });
  });

  it('does not count a scan whose page was left before consent settled, and a re-scan still counts', () => {
    // Unlike the board tracker, a return visit cannot recover it: the page mounts
    // this tracker only when the server saw the QR pair, and the stripped URL a
    // climber comes back on has none (gym-page-qr-landing.test.tsx pins that).
    consentState.granted = false;
    window.history.replaceState(null, '', '/gym/boulderwelt?src=qr&medium=poster');
    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />).unmount();

    consentState.granted = true;

    expect(trackGymFunnelEvent).not.toHaveBeenCalled();

    // The lost attempt was never marked reported, so scanning the poster again counts.
    window.history.replaceState(null, '', '/gym/boulderwelt?src=qr&medium=poster');
    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
  });

  it('leaves a URL that carries no attribution params alone', () => {
    window.history.replaceState(null, '', '/gym/boulderwelt?tab=boards');

    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);
    flushStrip();

    expect(window.location.search).toBe('?tab=boards');
  });

  it('counts at once but leaves the address bar until the next task', () => {
    // Next patches `history.replaceState` in the root router's own mount effect,
    // which runs after this one on the hydration commit; a native call made here
    // would leave the router holding the pair. So the strip waits a task.
    window.history.replaceState(null, '', '/gym/boulderwelt?src=qr&medium=poster&tab=boards');

    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />);

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?src=qr&medium=poster&tab=boards');
    flushStrip();
    expect(window.location.search).toBe('?tab=boards');
  });

  it('drops the pending strip when it unmounts first', () => {
    window.history.replaceState(null, '', '/gym/boulderwelt?src=qr&medium=poster');

    render(<GymQrLandingTracker gymSlug="boulderwelt" medium="poster" />).unmount();
    window.history.replaceState(null, '', '/gyms?src=qr&medium=poster');
    flushStrip();

    // The next page's URL is not this tracker's to rewrite.
    expect(window.location.search).toBe('?src=qr&medium=poster');
  });
});
