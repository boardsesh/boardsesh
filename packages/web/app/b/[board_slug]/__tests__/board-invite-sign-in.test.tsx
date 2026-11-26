// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('server-only', () => ({}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children),
}));
vi.mock('@/app/components/marketing/store-install-buttons', () => ({
  default: ({ placement, appearance, labels }: { placement: string; appearance?: string; labels: { ios: string } }) =>
    createElement('div', {
      'data-store-placement': placement,
      'data-appearance': appearance ?? 'brand',
      'data-ios-label': labels.ios,
    }),
}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('@/app/lib/store-button-labels.server', () => ({
  getStoreButtonLabels: async () => ({
    ios: 'Download on the App Store',
    android: 'Get it on Google Play',
    update: 'Update',
    locale: 'en-US',
  }),
}));

const { default: BoardInviteSignIn } = await import('../board-invite-sign-in');

describe('board invite sign-in', () => {
  it('offers the app stores under the sign-in, with the server-translated labels', async () => {
    const page = await BoardInviteSignIn({ boardName: 'Friends Garage', returnPath: '/b/friends-garage?invite=x' });
    const { container } = render(page);
    expect(screen.getByText('boardShareLink.appHint')).toBeTruthy();
    const stores = container.querySelector('[data-store-placement="board-invite"]');
    expect(stores?.getAttribute('data-ios-label')).toBe('Download on the App Store');
    // Sign in stays the one filled button.
    expect(stores?.getAttribute('data-appearance')).toBe('plain');
  });
});
