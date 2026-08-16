import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import type { Gym } from '@boardsesh/shared-schema';

// #4379's acceptance criterion is "still lands AND still counts". The redirect
// tests cover "lands" and the tracker's own tests cover "counts once mounted" —
// this file covers the join nobody else touches: that `GymPage` actually mounts
// the tracker for a QR landing, and refuses to for anything else. Without it the
// whole "counts" half rests on one unasserted line of JSX.

vi.mock('server-only', () => ({}));

class NotFoundSignal extends Error {}
class RedirectSignal extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
  permanentRedirect: () => {
    throw new RedirectSignal('permanentRedirect');
  },
}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn(async () => 'en-US') }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: vi.fn(async () => undefined) }));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

const GymPage = (await import('../page')).default;
// Imported, not mocked: `page.tsx` resolves the same module instance, so element
// type identity is enough to find them in the returned tree.
const GymQrLandingTracker = (await import('../gym-qr-landing-tracker')).default;
const GymInstallCta = (await import('../gym-install-cta')).default;

function gym(slug: string, overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: `uuid-${slug}`,
    slug,
    name: 'Boulderwelt',
    isPublic: true,
    canEdit: false,
    ...overrides,
  } as unknown as Gym;
}

/**
 * Collect every element of a given component type from a rendered-but-not-mounted
 * tree. `GymPage` is an async server component, so it is awaited for its element
 * tree rather than rendered: RTL cannot mount a promise, and mounting the whole
 * page would drag in every client island just to assert one mount decision.
 */
function findAll(node: React.ReactNode, type: unknown): React.ReactElement[] {
  const found: React.ReactElement[] = [];
  const visit = (current: React.ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!React.isValidElement(current)) return;
    if (current.type === type) found.push(current);
    visit((current.props as { children?: React.ReactNode }).children);
  };
  visit(node);
  return found;
}

// `fetchGymBySlug` is wrapped in React's `cache()`, so each test uses its own slug.
const renderPage = (slug: string, searchParams: Record<string, string | string[] | undefined>) =>
  GymPage({ params: Promise.resolve({ gym_slug: slug }), searchParams: Promise.resolve(searchParams) });

beforeEach(() => {
  executeAuthenticatedGraphQL.mockReset();
});

describe('gym page QR landing', () => {
  it('mounts the scan tracker with the parsed medium for a poster landing', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('landing-poster') });

    const trackers = findAll(await renderPage('landing-poster', { src: 'qr', medium: 'poster' }), GymQrLandingTracker);

    expect(trackers).toHaveLength(1);
    expect(trackers[0]?.props).toMatchObject({ gymSlug: 'landing-poster', medium: 'poster' });
  });

  it('mounts it for a kiosk landing too', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('landing-kiosk') });

    const trackers = findAll(await renderPage('landing-kiosk', { src: 'qr', medium: 'kiosk' }), GymQrLandingTracker);

    expect(trackers[0]?.props).toMatchObject({ gymSlug: 'landing-kiosk', medium: 'kiosk' });
  });

  it('mounts nothing for an ordinary visit', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('landing-plain') });

    expect(findAll(await renderPage('landing-plain', {}), GymQrLandingTracker)).toHaveLength(0);
  });

  it('mounts nothing for a medium outside the vocabulary', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('landing-bogus') });

    expect(findAll(await renderPage('landing-bogus', { src: 'qr', medium: 'evil' }), GymQrLandingTracker)).toHaveLength(
      0,
    );
  });

  it('gives the install CTA the canonical slug, not the one in the address bar', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('landing-cta') });

    const ctas = findAll(await renderPage('landing-cta', { src: 'qr', medium: 'poster' }), GymInstallCta);

    expect(ctas).toHaveLength(1);
    expect(ctas[0]?.props).toMatchObject({ gymSlug: 'landing-cta' });
  });

  it('falls back to the URL slug when the gym has an empty slug', async () => {
    // `||`, not `??`: an empty-string slug skips the merged-twin 308 above
    // (a truthiness guard) and would otherwise name the campaign `gym-`.
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('landing-empty', { slug: '' }) });

    const ctas = findAll(await renderPage('landing-empty', {}), GymInstallCta);

    expect(ctas[0]?.props).toMatchObject({ gymSlug: 'landing-empty' });
  });
});
