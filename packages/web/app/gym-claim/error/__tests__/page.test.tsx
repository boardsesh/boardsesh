import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GymClaimErrorPage from '../page';

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({
    t: (key: string) => tFromCatalog('boards', key),
    locale: 'en-US',
  }),
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
});
