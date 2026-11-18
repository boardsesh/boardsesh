import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, render, screen } from '@testing-library/react';
import ClimbSocialSection from '../climb-social-section';

vi.mock('next-auth/react', () => ({ useSession: () => ({ status: 'unauthenticated' }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/fr/kilter/original/full/40/view/my-climb' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../comment-section', () => ({ default: () => null }));
vi.mock('../proposal-section', () => ({ default: () => <p>Public proposals</p> }));
vi.mock('../vote-button', () => ({ default: () => null }));
afterEach(cleanup);

describe('climb grade suggestion sign-in', () => {
  it('returns to the same locale and climb after sign-in', () => {
    render(<ClimbSocialSection climbUuid="my-climb" />);
    const href = screen.getByRole('link').getAttribute('href');
    const target = new URL(href ?? '', 'https://www.boardsesh.com');
    expect(target.pathname).toBe('/auth/login');
    expect(target.searchParams.get('callbackUrl')).toBe('/fr/kilter/original/full/40/view/my-climb');
  });
  it('keeps public proposals visible while signed out', () => {
    render(<ClimbSocialSection climbUuid="my-climb" boardType="kilter" angle={40} />);
    expect(screen.getByText('Public proposals')).toBeTruthy();
    expect(screen.getByRole('link')).toBeTruthy();
  });
});
