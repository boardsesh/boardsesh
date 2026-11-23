import React, { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render, waitFor } from '@testing-library/react';
import { useStoreBadgeOnScreen } from '../use-store-badge-on-screen';

/** IntersectionObserver as the hook sees it: each test moves the page by hand. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(target: Element): void {
    const index = this.targets.indexOf(target);
    if (index >= 0) this.targets.splice(index, 1);
  }

  disconnect(): void {
    this.targets.length = 0;
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** The browser's report for one badge. A `display: none` badge has an empty box at 0,0. */
  report(target: Element, position: { isIntersecting: boolean; top: number; bottom: number }): void {
    const entry = {
      target,
      isIntersecting: position.isIntersecting,
      boundingClientRect: { top: position.top, bottom: position.bottom, height: position.bottom - position.top },
    } as unknown as IntersectionObserverEntry;
    act(() => this.callback([entry], this as unknown as IntersectionObserver));
  }
}

/** ResizeObserver on the header: a test fires it after changing the header's box. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  fire(): void {
    act(() => this.callback([], this as unknown as ResizeObserver));
  }
}

/** The real MutationObserver, with a record of which ones were disconnected. */
const RealMutationObserver = globalThis.MutationObserver;
class TrackedMutationObserver extends RealMutationObserver {
  static instances: TrackedMutationObserver[] = [];
  disconnected = false;

  constructor(callback: MutationCallback) {
    super(callback);
    TrackedMutationObserver.instances.push(this);
  }

  disconnect(): void {
    this.disconnected = true;
    super.disconnect();
  }
}

function badgeObserver(): FakeIntersectionObserver {
  const observer = FakeIntersectionObserver.instances.at(-1);
  if (!observer) throw new Error('no IntersectionObserver was created');
  return observer;
}

const ON_SCREEN = { isIntersecting: true, top: 400, bottom: 448 };
const SCROLLED_AWAY = { isIntersecting: false, top: -200, bottom: -152 };
const NO_BOX = { isIntersecting: false, top: 0, bottom: 0 };

/** The header, with the hook's answer written where a test can read it. */
function Header() {
  const headerRef = useRef<HTMLElement>(null);
  const onScreen = useStoreBadgeOnScreen(headerRef);
  return (
    <header ref={headerRef} data-answer={onScreen === null ? 'unknown' : String(onScreen)}>
      {/* A badge in the header is not the page's own: never counted. */}
      <a data-store-badge="ios" href="https://apps.apple.com/">
        header badge
      </a>
    </header>
  );
}

function answer(): string | null {
  return document.querySelector('header')?.getAttribute('data-answer') ?? null;
}

function badgeAnchor(store: 'ios' | 'android' = 'ios') {
  return (
    <a data-store-badge={store} href={`https://example.test/${store}`}>
      {store} badge
    </a>
  );
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  FakeResizeObserver.instances = [];
  TrackedMutationObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useStoreBadgeOnScreen', () => {
  it('answers yes while a badge in <main> is on screen', () => {
    render(
      <>
        <Header />
        <main>{badgeAnchor()}</main>
      </>,
    );
    const badge = document.querySelector('main a[data-store-badge]') as Element;
    expect(badgeObserver().targets).toEqual([badge]);

    badgeObserver().report(badge, ON_SCREEN);

    expect(answer()).toBe('true');
  });

  it('answers no once the badge has scrolled away, and yes again when it is back', () => {
    render(
      <>
        <Header />
        <main>{badgeAnchor()}</main>
      </>,
    );
    const badge = document.querySelector('main a[data-store-badge]') as Element;
    badgeObserver().report(badge, ON_SCREEN);

    badgeObserver().report(badge, SCROLLED_AWAY);
    expect(answer()).toBe('false');

    badgeObserver().report(badge, ON_SCREEN);
    expect(answer()).toBe('true');
  });

  it('answers no on a page with no badge, and ignores a badge outside <main>', async () => {
    render(
      <>
        <Header />
        <main>
          <p>Nothing to install here.</p>
        </main>
      </>,
    );

    await waitFor(() => expect(answer()).toBe('false'));
    expect(badgeObserver().targets).toEqual([]);
  });

  it('picks up a badge that streams in after mount, and lets go of one that leaves', async () => {
    function Page({ withBadge }: { withBadge: boolean }) {
      return (
        <>
          <Header />
          <main>{withBadge ? <section>{badgeAnchor('android')}</section> : null}</main>
        </>
      );
    }
    const { rerender } = render(<Page withBadge={false} />);
    await waitFor(() => expect(answer()).toBe('false'));

    rerender(<Page withBadge />);
    const badge = await waitFor(() => {
      const arrived = document.querySelector('main a[data-store-badge]');
      expect(badgeObserver().targets).toContain(arrived);
      return arrived as Element;
    });
    badgeObserver().report(badge, ON_SCREEN);
    expect(answer()).toBe('true');

    // The page moves on (a client-side navigation): the badge goes, the answer follows.
    rerender(<Page withBadge={false} />);
    await waitFor(() => expect(answer()).toBe('false'));
    expect(badgeObserver().targets).toEqual([]);
  });

  it('never counts a display:none badge, even while a visible one is off screen', () => {
    render(
      <>
        <Header />
        <main>
          {/* The laptop-only QR card's badge on a phone, then the hero's own. */}
          <div style={{ display: 'none' }}>{badgeAnchor('android')}</div>
          {badgeAnchor('ios')}
        </main>
      </>,
    );
    const [hiddenBadge, heroBadge] = [...document.querySelectorAll('main a[data-store-badge]')];

    badgeObserver().report(hiddenBadge, NO_BOX);
    badgeObserver().report(heroBadge, SCROLLED_AWAY);
    expect(answer()).toBe('false');

    // Even a report that says "intersecting" does not count an empty box.
    badgeObserver().report(hiddenBadge, { ...NO_BOX, isIntersecting: true });
    expect(answer()).toBe('false');

    badgeObserver().report(heroBadge, ON_SCREEN);
    expect(answer()).toBe('true');
  });

  describe('with real boxes', () => {
    // jsdom lays nothing out, so give the header and the badges the boxes a phone would.
    let badgeBox = { top: 400, bottom: 448 };
    let headerBottom = 68;
    beforeEach(() => {
      badgeBox = { top: 400, bottom: 448 };
      headerBottom = 68;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function boxOf(this: HTMLElement) {
        const box = this.tagName === 'HEADER' ? { top: 0, bottom: headerBottom } : badgeBox;
        return { ...box, left: 0, right: 160, width: 160, height: box.bottom - box.top, x: 0, y: box.top } as DOMRect;
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('measures below the fixed header, so a badge under the header counts as gone', () => {
      render(
        <>
          <Header />
          <main>{badgeAnchor()}</main>
        </>,
      );

      expect(badgeObserver().options.rootMargin).toBe('-68px 0px 0px 0px');
    });

    it('answers for a badge that arrives on screen at once, before the observer reports', async () => {
      // A client-side navigation to the home page: the hero badge is already in view.
      function Page({ withBadge }: { withBadge: boolean }) {
        return (
          <>
            <Header />
            <main>{withBadge ? badgeAnchor() : null}</main>
          </>
        );
      }
      const { rerender } = render(<Page withBadge={false} />);
      await waitFor(() => expect(answer()).toBe('false'));

      rerender(<Page withBadge />);

      await waitFor(() => expect(answer()).toBe('true'));
    });

    it('follows the header when it grows or shrinks (rotation, the URL bar)', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      render(
        <>
          <Header />
          <main>{badgeAnchor()}</main>
        </>,
      );
      const badge = document.querySelector('main a[data-store-badge]') as Element;
      const firstObserver = badgeObserver();
      const [headerWatcher] = FakeResizeObserver.instances;
      expect(headerWatcher.targets).toEqual([document.querySelector('header')]);

      headerBottom = 92;
      headerWatcher.fire();

      expect(firstObserver.disconnected).toBe(true);
      expect(badgeObserver()).not.toBe(firstObserver);
      expect(badgeObserver().options.rootMargin).toBe('-92px 0px 0px 0px');
      expect(badgeObserver().targets).toEqual([badge]);

      // The new observer's reports are the ones that count.
      badgeObserver().report(badge, SCROLLED_AWAY);
      expect(answer()).toBe('false');
    });

    it('keeps the observer when the header keeps its height', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      render(
        <>
          <Header />
          <main>{badgeAnchor()}</main>
        </>,
      );
      const firstObserver = badgeObserver();

      FakeResizeObserver.instances[0].fire();

      expect(badgeObserver()).toBe(firstObserver);
      expect(firstObserver.disconnected).toBe(false);
    });

    it('re-measures on a window resize where ResizeObserver is missing', () => {
      vi.stubGlobal('ResizeObserver', undefined);
      render(
        <>
          <Header />
          <main>{badgeAnchor()}</main>
        </>,
      );

      headerBottom = 56;
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });

      expect(badgeObserver().options.rootMargin).toBe('-56px 0px 0px 0px');
    });

    it('does not count a badge that arrives already under the header', async () => {
      badgeBox = { top: 10, bottom: 58 };
      render(
        <>
          <Header />
          <main>{badgeAnchor()}</main>
        </>,
      );

      await waitFor(() => expect(answer()).toBe('false'));
    });
  });

  it('disconnects every observer on unmount, and ignores a report that arrives late', () => {
    vi.stubGlobal('MutationObserver', TrackedMutationObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(
      <>
        <Header />
        <main>{badgeAnchor()}</main>
      </>,
    );
    const badge = document.querySelector('main a[data-store-badge]') as Element;
    const intersection = badgeObserver();
    const [mutations] = TrackedMutationObserver.instances;
    const [resize] = FakeResizeObserver.instances;

    unmount();

    expect(intersection.disconnected).toBe(true);
    expect(mutations.disconnected).toBe(true);
    expect(resize.disconnected).toBe(true);

    // A report the browser had already queued when the observer was disconnected.
    expect(() => intersection.report(badge, ON_SCREEN)).not.toThrow();
    expect(() => resize.fire()).not.toThrow();
    expect(FakeIntersectionObserver.instances).toEqual([intersection]);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('answers no where IntersectionObserver is missing, so the header keeps its link', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(
      <>
        <Header />
        <main>{badgeAnchor()}</main>
      </>,
    );

    await waitFor(() => expect(answer()).toBe('false'));
  });
});
