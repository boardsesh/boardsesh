import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

// A mutable holder so each case can pick who is looking at the page. A plain
// module-level constant would pin the whole file to one viewer.
const sessionState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: sessionState.userId ? { user: { id: sessionState.userId } } : null,
    status: sessionState.userId ? 'authenticated' : 'unauthenticated',
  }),
}));

const authTokenState = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({
    token: authTokenState.isAuthenticated ? 'test-token' : null,
    isAuthenticated: authTokenState.isAuthenticated,
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  FOLLOW_GYM: 'FOLLOW_GYM',
  UNFOLLOW_GYM: 'UNFOLLOW_GYM',
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: vi.fn() }),
}));

vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent: vi.fn() }));

const GymFollowButton = (await import('../gym-follow-button')).default;

const OWNER_ID = 'owner-1';

beforeEach(() => {
  sessionState.userId = null;
  authTokenState.isAuthenticated = true;
});

describe('GymFollowButton visibility', () => {
  it('hides itself from the gym owner — you do not follow your own gym', () => {
    sessionState.userId = OWNER_ID;

    const { container } = render(<GymFollowButton gymUuid="gym-1" ownerId={OWNER_ID} isFollowedByMe={false} />);

    expect(container.innerHTML).toBe('');
  });

  it('shows for any other signed-in climber', () => {
    sessionState.userId = 'someone-else';

    render(<GymFollowButton gymUuid="gym-1" ownerId={OWNER_ID} isFollowedByMe={false} />);

    expect(screen.getByRole('button', { name: 'Follow' })).toBeTruthy();
  });

  it('shows Following when the viewer already follows the gym', () => {
    sessionState.userId = 'someone-else';

    render(<GymFollowButton gymUuid="gym-1" ownerId={OWNER_ID} isFollowedByMe />);

    expect(screen.getByRole('button', { name: 'Following' })).toBeTruthy();
  });

  it('renders nothing for a signed-out visitor, who has nothing to follow with', () => {
    authTokenState.isAuthenticated = false;

    const { container } = render(<GymFollowButton gymUuid="gym-1" ownerId={OWNER_ID} isFollowedByMe={false} />);

    expect(container.innerHTML).toBe('');
  });

  it('still renders while the session is settling, even for the owner', () => {
    // `useSession()` starts at null on every load. The owner check is a hide,
    // not a show, so a null session must not hide the button from everyone —
    // it resolves to the owner's own id a round-trip later.
    sessionState.userId = null;

    render(<GymFollowButton gymUuid="gym-1" ownerId={OWNER_ID} isFollowedByMe={false} />);

    expect(screen.getByRole('button', { name: 'Follow' })).toBeTruthy();
  });
});
