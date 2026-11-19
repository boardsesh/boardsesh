import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, render, screen } from '@testing-library/react';
import ClimbSocialSection from '../climb-social-section';

const authState = vi.hoisted(() => ({ isAuthenticated: false }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => authState }));
vi.mock('next/navigation', () => ({ usePathname: () => '/fr/kilter/original/full/40/view/my-climb' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../comment-section', () => ({ default: () => null }));
vi.mock('../proposal-section', () => ({ default: () => <p>Public proposals</p> }));
vi.mock('../vote-button', () => ({ default: () => <button>Suggest a grade</button> }));
beforeEach(() => {
  authState.isAuthenticated = false;
});
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
  it('shows the grade vote for an authenticated climber', () => {
    authState.isAuthenticated = true;
    render(<ClimbSocialSection climbUuid="my-climb" boardType="kilter" angle={40} />);
    expect(screen.getByRole('button', { name: 'Suggest a grade' })).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Public proposals')).toBeTruthy();
  });
});
