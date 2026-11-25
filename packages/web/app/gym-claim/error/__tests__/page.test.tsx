import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GymClaimErrorPage from '@/app/(site)/gym-claim/error/page';

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog('boards', key, options),
    locale: 'en-US',
  }),
}));
const fetchGymBySlug = vi.hoisted(() => vi.fn());
vi.mock('@/app/gym/[gym_slug]/fetch-gym-by-slug', () => ({
  fetchGymBySlug,
  isGymViewable: (gym: { isPublic?: boolean; canEdit?: boolean } | null) =>
    gym !== null && (gym.isPublic === true || gym.canEdit === true),
}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'en-US' }));
vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

describe('gym claim verification error page', () => {
  it('explains superseded ownership and offers a route back after the claim expires', async () => {
    render(await GymClaimErrorPage({ searchParams: Promise.resolve({ reason: 'superseded' }) }));

    expect(
      screen.getByText(
        "This gym has a different owner now, so this link can't hand it over. Start the claim again from the gym.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/');
  });

  it('links back to the gym the claim was for when the redirect names a public one', async () => {
    fetchGymBySlug.mockResolvedValueOnce({ uuid: 'gym-1', slug: 'boulderwelt', name: 'Boulderwelt', isPublic: true });
    render(await GymClaimErrorPage({ searchParams: Promise.resolve({ reason: 'expired', gym: 'boulderwelt' }) }));

    const back = screen.getByRole('link', { name: 'Back to Boulderwelt' });
    expect(back.getAttribute('href')).toBe('/gym/boulderwelt');
    expect(fetchGymBySlug).toHaveBeenCalledWith('boulderwelt', undefined);
  });

  it('keeps only the home link for a malformed gym, a private one, or a failed lookup', async () => {
    fetchGymBySlug.mockReset();
    render(await GymClaimErrorPage({ searchParams: Promise.resolve({ reason: 'used', gym: '../admin' }) }));
    expect(fetchGymBySlug).not.toHaveBeenCalled();
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/']);
  });

  it('never fails the page when the gym lookup throws', async () => {
    fetchGymBySlug.mockRejectedValueOnce(new Error('deadline'));
    render(await GymClaimErrorPage({ searchParams: Promise.resolve({ reason: 'expired', gym: 'boulderwelt' }) }));
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/']);
  });
});
