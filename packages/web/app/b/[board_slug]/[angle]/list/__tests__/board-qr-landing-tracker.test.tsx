import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render } from '@testing-library/react';
import React from 'react';
import { __resetBoardQrLandingForTests, captureBoardQrLandingMedium } from '@/app/lib/board-qr-landing';

const track = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track }));

// The real provider settles after hydration; each test says where consent stands.
const consentState = vi.hoisted(() => ({ granted: true }));
vi.mock('@/app/components/consent/consent-provider', () => ({
  useConsent: () => ({ granted: consentState.granted }),
}));

const trackerModule = await import('../board-qr-landing-tracker');
const BoardQrLandingTracker = trackerModule.default;
const { __resetReportedBoardQrLandingsForTests } = trackerModule;

const WALL_PATH = '/b/garage-wall/40/list';
const WALL_UUID = 'ab12cd34ef56ab12cd34ef56ab12cd34';

/** The address-bar cleanup waits one task (see the component), so tests run the timers. */
function flushStrip(): void {
  vi.runOnlyPendingTimers();
}

beforeEach(() => {
  vi.useFakeTimers();
  track.mockReset();
  consentState.granted = true;
  // Both the dedupe Set and the remembered landing are module-level and outlive
  // unmounts on purpose; without this a later test reusing a path would assert
  // nothing and still pass.
  __resetReportedBoardQrLandingsForTests();
  __resetBoardQrLandingForTests();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BoardQrLandingTracker', () => {
  it('renders nothing and reports a poster scan once, naming the board type and nothing else', () => {
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board&wall=${WALL_UUID}`);

    const { container } = render(<BoardQrLandingTracker boardType="spray" />);

    expect(container.innerHTML).toBe('');
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('Board QR Scanned', { medium: 'board', surface: 'web', boardType: 'spray' });
  });

  it('counts the kiosk screen code on a catalogue board too', () => {
    window.history.replaceState(null, '', '/b/the-kilter/40/list?src=qr&medium=kiosk');

    render(<BoardQrLandingTracker boardType="kilter" />);

    expect(track).toHaveBeenCalledWith('Board QR Scanned', { medium: 'kiosk', surface: 'web', boardType: 'kilter' });
  });

  it('reports nothing for a plain visit', () => {
    window.history.replaceState(null, '', `${WALL_PATH}?wall=${WALL_UUID}`);

    render(<BoardQrLandingTracker boardType="spray" />);
    flushStrip();

    expect(track).not.toHaveBeenCalled();
    expect(window.location.search).toBe(`?wall=${WALL_UUID}`);
  });

  it.each([
    ['an unknown medium', '?src=qr&medium=flyer'],
    ['a source that is not qr', '?src=email&medium=board'],
    ['a repeated medium', '?src=qr&medium=board&medium=kiosk'],
    ['a medium with no source', '?medium=board'],
    // The gym poster's medium: no board code prints it, so it is not a board scan.
    ['the gym poster medium', '?src=qr&medium=poster'],
  ])('reports nothing for %s, and leaves the URL as it came', (_case, search) => {
    window.history.replaceState(null, '', `${WALL_PATH}${search}`);

    render(<BoardQrLandingTracker boardType="spray" />);
    flushStrip();

    expect(track).not.toHaveBeenCalled();
    expect(window.location.search).toBe(search);
  });

  it('does not report again on a re-render of the same landing', () => {
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board`);

    const { rerender } = render(<BoardQrLandingTracker boardType="spray" />);
    rerender(<BoardQrLandingTracker boardType="spray" />);
    rerender(<BoardQrLandingTracker boardType="spray" />);

    expect(track).toHaveBeenCalledTimes(1);
  });

  it('does not report again when the same landing remounts — a StrictMode double-invoke or a return visit', () => {
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board`);

    render(<BoardQrLandingTracker boardType="spray" />).unmount();
    render(<BoardQrLandingTracker boardType="spray" />);

    expect(track).toHaveBeenCalledTimes(1);
  });

  it('reports a different board landed on from the same medium', () => {
    window.history.replaceState(null, '', '/b/first-wall/40/list?src=qr&medium=board');
    render(<BoardQrLandingTracker boardType="spray" />).unmount();

    window.history.replaceState(null, '', '/b/second-wall/35/list?src=qr&medium=board');
    render(<BoardQrLandingTracker boardType="spray" />);

    expect(track).toHaveBeenCalledTimes(2);
  });

  it('strips the attribution pair but keeps the wall capability, which a reload needs', () => {
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board&wall=${WALL_UUID}#climbs`);

    render(<BoardQrLandingTracker boardType="spray" />);
    flushStrip();

    expect(window.location.pathname).toBe(WALL_PATH);
    expect(window.location.search).toBe(`?wall=${WALL_UUID}`);
    expect(window.location.hash).toBe('#climbs');
  });

  it('counts at once but leaves the address bar until the next task', () => {
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board`);

    render(<BoardQrLandingTracker boardType="spray" />);

    // Counted at once, cleaned on the next task.
    expect(track).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?src=qr&medium=board');
    flushStrip();
    expect(window.location.search).toBe('');
  });

  it('still strips the params on a repeat landing it does not count', () => {
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board`);
    render(<BoardQrLandingTracker boardType="spray" />).unmount();

    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board`);
    render(<BoardQrLandingTracker boardType="spray" />);
    flushStrip();

    expect(window.location.search).toBe('');
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('waits for consent to settle, then counts the scan even though the strip already ran', () => {
    // A cold scan hydrates before the session and the region lookup answer, and
    // `track()` drops anything sent before then. Counting on mount lost them all.
    consentState.granted = false;
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board&wall=${WALL_UUID}`);

    const { rerender } = render(<BoardQrLandingTracker boardType="spray" />);
    flushStrip();

    expect(track).not.toHaveBeenCalled();
    expect(window.location.search).toBe(`?wall=${WALL_UUID}`);

    consentState.granted = true;
    rerender(<BoardQrLandingTracker boardType="spray" />);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('Board QR Scanned', { medium: 'board', surface: 'web', boardType: 'spray' });
  });

  it('does not count a scan whose page was left before consent settled, and counts it on return', () => {
    // By design (see the component): the landing belongs to its pathname.
    consentState.granted = false;
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board`);
    render(<BoardQrLandingTracker boardType="spray" />).unmount();

    window.history.replaceState(null, '', '/b/the-kilter/40/list');
    consentState.granted = true;
    render(<BoardQrLandingTracker boardType="kilter" />).unmount();

    expect(track).not.toHaveBeenCalled();

    window.history.replaceState(null, '', WALL_PATH);
    render(<BoardQrLandingTracker boardType="spray" />);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('Board QR Scanned', { medium: 'board', surface: 'web', boardType: 'spray' });
  });

  it('sends once even when the board type prop changes after the scan was sent', () => {
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board`);

    const { rerender } = render(<BoardQrLandingTracker boardType="spray" />);
    rerender(<BoardQrLandingTracker boardType={null} />);
    rerender(<BoardQrLandingTracker boardType="kilter" />);

    expect(track).toHaveBeenCalledTimes(1);
  });

  it('sends the board type current when consent settles', () => {
    consentState.granted = false;
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board`);

    const { rerender } = render(<BoardQrLandingTracker boardType={null} />);
    rerender(<BoardQrLandingTracker boardType="spray" />);
    consentState.granted = true;
    rerender(<BoardQrLandingTracker boardType="spray" />);

    expect(track).toHaveBeenCalledWith('Board QR Scanned', { medium: 'board', surface: 'web', boardType: 'spray' });
  });

  it('counts nothing without consent, and still cleans the address bar', () => {
    consentState.granted = false;
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board`);

    render(<BoardQrLandingTracker boardType="spray" />);
    flushStrip();

    expect(track).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('leaves the medium readable after the strip, for the store buttons that render after it', () => {
    window.history.replaceState(null, '', `${WALL_PATH}?src=qr&medium=board&wall=${WALL_UUID}`);

    render(<BoardQrLandingTracker boardType="spray" />);
    flushStrip();

    expect(window.location.search).toBe(`?wall=${WALL_UUID}`);
    expect(captureBoardQrLandingMedium()).toBe('board');
  });
});
