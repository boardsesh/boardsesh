import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render } from '@testing-library/react';
import React from 'react';
import type { AnalyticsBoardType } from '@boardsesh/analytics';
import { __resetQrLandingForTests, captureQrLandingMedium } from '@/app/lib/qr-landing';

const track = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track }));

// The real provider settles after hydration; each test says where consent stands.
const consentState = vi.hoisted(() => ({ granted: true }));
vi.mock('@/app/components/consent/consent-state-provider', () => ({
  useConsent: () => ({ granted: consentState.granted }),
}));

const trackerModule = await import('../qr-landing-tracker');
const QrLandingTracker = trackerModule.default;
const { __resetReportedQrLandingsForTests } = trackerModule;

/** The board-list mount, as `/b/{slug}/{angle}/list` renders it. */
function BoardQrLandingTracker({ boardType }: { boardType: AnalyticsBoardType | null }) {
  return <QrLandingTracker kind="board" boardType={boardType} />;
}

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
  __resetReportedQrLandingsForTests();
  __resetQrLandingForTests();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QrLandingTracker on a board list', () => {
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
    expect(captureQrLandingMedium('board')).toBe('board');
  });
});

describe('QrLandingTracker on a climb page', () => {
  const CLIMB_PATH = '/b/the-kilter/40/view/abc-the-climb';

  it('reports the desktop code once as a climb scan, naming the board type and nothing else', () => {
    window.history.replaceState(null, '', `${CLIMB_PATH}?src=qr&medium=desktop`);

    const { rerender } = render(<QrLandingTracker kind="climb" boardType="kilter" />);
    rerender(<QrLandingTracker kind="climb" boardType="kilter" />);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('Climb QR Scanned', { medium: 'desktop', surface: 'web', boardType: 'kilter' });
  });

  it('strips the pair from the address bar and keeps the medium for the store buttons', () => {
    window.history.replaceState(null, '', `${CLIMB_PATH}?src=qr&medium=desktop#beta`);

    render(<QrLandingTracker kind="climb" boardType="kilter" />);
    flushStrip();

    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#beta');
    expect(captureQrLandingMedium('climb')).toBe('desktop');
  });

  it.each(['?src=qr&medium=board', '?src=qr&medium=poster', '?src=qr&medium=kiosk'])(
    'counts nothing and leaves %s in place, since no climb page prints it',
    (search) => {
      window.history.replaceState(null, '', `${CLIMB_PATH}${search}`);

      render(<QrLandingTracker kind="climb" boardType="kilter" />);
      flushStrip();

      expect(track).not.toHaveBeenCalled();
      expect(window.location.search).toBe(search);
    },
  );

  it('waits for consent before counting', () => {
    consentState.granted = false;
    window.history.replaceState(null, '', `${CLIMB_PATH}?src=qr&medium=desktop`);
    const { rerender } = render(<QrLandingTracker kind="climb" boardType="moonboard" />);
    flushStrip();
    expect(track).not.toHaveBeenCalled();

    consentState.granted = true;
    rerender(<QrLandingTracker kind="climb" boardType="moonboard" />);

    expect(track).toHaveBeenCalledWith('Climb QR Scanned', {
      medium: 'desktop',
      surface: 'web',
      boardType: 'moonboard',
    });
  });
});

describe('QrLandingTracker on a board list, for its laptop code', () => {
  const LIST_PATH = '/b/the-kilter/40/list';

  /** The `/b` list mounts both: the board tracker in the page, the list tracker in the front door. */
  function BothListTrackers() {
    return (
      <>
        <QrLandingTracker kind="board" boardType="kilter" />
        <QrLandingTracker kind="list" boardType="kilter" />
      </>
    );
  }

  it('reports the desktop code once as a list scan, not as a climb or board scan', () => {
    window.history.replaceState(null, '', `${LIST_PATH}?src=qr&medium=desktop`);

    const { rerender } = render(<BothListTrackers />);
    rerender(<BothListTrackers />);
    flushStrip();

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('List QR Scanned', { medium: 'desktop', surface: 'web', boardType: 'kilter' });
    expect(window.location.search).toBe('');
    expect(captureQrLandingMedium('list')).toBe('desktop');
  });

  it('leaves a kiosk scan on the same page to the board tracker, counted once', () => {
    window.history.replaceState(null, '', `${LIST_PATH}?src=qr&medium=kiosk`);

    render(<BothListTrackers />);
    flushStrip();

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('Board QR Scanned', { medium: 'kiosk', surface: 'web', boardType: 'kilter' });
    expect(captureQrLandingMedium('list')).toBeNull();
  });
});

describe.each([
  ['setter', '/setter/jimmy%20webb', 'Setter QR Scanned'],
  ['playlist', '/playlists/5d3b1c7e-2a4f-4f0e-9d53-6f1a2b3c4d5e', 'Playlist QR Scanned'],
  ['home', '/', 'Home QR Scanned'],
] as const)('QrLandingTracker on a %s page, for its laptop code', (kind, pagePath, eventName) => {
  it('reports the desktop code once under its own name and strips the pair', () => {
    window.history.replaceState(null, '', `${pagePath}?src=qr&medium=desktop`);

    const { rerender } = render(<QrLandingTracker kind={kind} boardType="kilter" />);
    rerender(<QrLandingTracker kind={kind} boardType="kilter" />);
    flushStrip();

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(eventName, { medium: 'desktop', surface: 'web', boardType: 'kilter' });
    expect(window.location.search).toBe('');
    expect(captureQrLandingMedium(kind)).toBe('desktop');
  });

  it.each(['?src=qr&medium=poster', '?src=qr&medium=board', '?src=qr&medium=kiosk'])(
    'counts nothing for %s, which this page never prints',
    (search) => {
      window.history.replaceState(null, '', `${pagePath}${search}`);

      render(<QrLandingTracker kind={kind} boardType="kilter" />);
      flushStrip();

      expect(track).not.toHaveBeenCalled();
    },
  );
});
