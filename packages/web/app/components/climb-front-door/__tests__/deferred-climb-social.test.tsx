// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BrowserSession, useOptionalBrowserSession } from '@/app/components/providers/session-provider';

/**
 * The comments section's queries used to run on every climb page view,
 * Googlebot's included. `DeferredClimbSocial` holds them back: signed out,
 * nothing loads until "Show comments" is tapped; signed in, the section mounts
 * once its row is near the screen.
 *
 * The mocked section module records when it is first imported, so "nothing
 * loads" means the chunk itself, not only its queries.
 */

const browserSession = vi.hoisted(() => ({ current: undefined as ReturnType<typeof useOptionalBrowserSession> }));
vi.mock('@/app/components/providers/session-provider', () => ({
  useOptionalBrowserSession: () => browserSession.current,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/fr/kilter/original/12x12-square/screw_bolt/40/view/my-climb',
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, { href: string; children: React.ReactNode }>(function MockLink(
    { href, children, ...rest },
    ref,
  ) {
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    );
  }),
}));

const socialModule = vi.hoisted(() => ({ imported: 0 }));
vi.mock('@/app/components/social/climb-social-section', () => {
  socialModule.imported += 1;
  return { default: ({ climbUuid }: { climbUuid: string }) => <p>Discussion for {climbUuid}</p> };
});

type ObserverRecord = { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; target?: Element };
const observers: ObserverRecord[] = [];

class FakeIntersectionObserver {
  private readonly record: ObserverRecord;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.record = { callback, options };
    observers.push(this.record);
  }
  observe(target: Element) {
    this.record.target = target;
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}

const DeferredClimbSocial = (await import('../deferred-climb-social')).default;

const LABELS = { heading: 'Comments and grade votes', signIn: 'Sign in to join in', show: 'Show comments' };

const update = async () => null;
const SIGNED_IN = {
  status: 'authenticated',
  data: { user: { id: 'climber' }, expires: '2099-01-01T00:00:00Z' } as BrowserSession,
  update,
} as const;
const SIGNED_OUT = { status: 'unauthenticated', data: null, update } as const;

/** The root layout's session, as the page sees it after the session read. */
function renderRow(session: typeof SIGNED_IN | typeof SIGNED_OUT = SIGNED_OUT) {
  browserSession.current = session;
  return render(
    <DeferredClimbSocial climbUuid="my-climb" boardType="kilter" angle={40} boardName="kilter" labels={LABELS} />,
  );
}

beforeEach(() => {
  browserSession.current = undefined;
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DeferredClimbSocial, signed out', () => {
  it('server-renders one row: the heading, a sign-in link back to this climb, and the button', () => {
    // No provider at all: a server render with no session read behind it.
    const html = renderToString(
      <DeferredClimbSocial climbUuid="my-climb" boardType="kilter" angle={40} boardName="kilter" labels={LABELS} />,
    );
    const page = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');

    expect(page.querySelector('h2')?.textContent).toBe('Comments and grade votes');
    const signIn = page.querySelector('a');
    const target = new URL(signIn?.getAttribute('href') ?? '', 'https://www.boardsesh.com');
    expect(signIn?.textContent).toBe('Sign in to join in');
    expect(target.pathname).toBe('/auth/login');
    expect(target.searchParams.get('callbackUrl')).toBe('/fr/kilter/original/12x12-square/screw_bolt/40/view/my-climb');
    expect(page.querySelector('button')?.textContent).toBe('Show comments');
    expect(html).not.toContain('Discussion for');
  });

  it('loads nothing until "Show comments" is tapped, then mounts the section and moves focus to it', async () => {
    const importsBefore = socialModule.imported;
    renderRow();

    // Even scrolled right to it, a signed-out reader's row stays a row.
    expect(observers).toHaveLength(0);
    expect(socialModule.imported).toBe(importsBefore);
    expect(screen.queryByText(/Discussion for/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show comments' }));

    expect(await screen.findByText('Discussion for my-climb')).toBeTruthy();
    expect(socialModule.imported).toBe(importsBefore + 1);
    expect(screen.queryByRole('button', { name: 'Show comments' })).toBeNull();
    expect(document.activeElement?.contains(screen.getByText('Discussion for my-climb'))).toBe(true);
  });
});

describe('DeferredClimbSocial, signed in', () => {
  it('mounts the section once the row is within 600px of the screen', async () => {
    renderRow(SIGNED_IN);

    expect(screen.queryByRole('link', { name: 'Sign in to join in' })).toBeNull();
    expect(observers).toHaveLength(1);
    expect(observers[0].options?.rootMargin).toBe('600px 0px');
    expect(observers[0].target).toBe(screen.getByTestId('climb-social-row'));
    expect(screen.queryByText(/Discussion for/)).toBeNull();

    act(() => {
      observers[0].callback(
        [{ isIntersecting: true, target: observers[0].target } as unknown as IntersectionObserverEntry],
        observers[0] as unknown as IntersectionObserver,
      );
    });

    expect(await screen.findByText('Discussion for my-climb')).toBeTruthy();
    // Opened by scrolling, not by a tap: focus stays where the reader is.
    expect(document.activeElement).toBe(document.body);
  });
});
