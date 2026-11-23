import React, { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render, waitFor } from '@testing-library/react';
import { useStoreBadgeOnScreen } from '../use-store-badge-on-screen';

/** IntersectionObserver as the hook sees it: each test moves the page by hand. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets: Element[] = [];

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
    beforeEach(() => {
      badgeBox = { top: 400, bottom: 448 };
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function boxOf(this: HTMLElement) {
        const box = this.tagName === 'HEADER' ? { top: 0, bottom: 68 } : badgeBox;
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
