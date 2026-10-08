// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ isPrivate: true, requestPending: true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'viewer' } } }) }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'token', isAuthenticated: true }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: vi.fn() }));
vi.mock('@/app/lib/privacy-client', () => ({ revokeWebPrivacySnapshots: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === 'sitePrivacySettings' ? { enabled: false } : { ...state, isFollowing: false },
  }),
}));
import { AccountFollowButton } from '../account-follow-button';
describe('follow state while privacy controls are disabled', () => {
  it('keeps a pending private request from appearing as approved', () => {
    render(<AccountFollowButton userId="climber" fallback={<span>legacy-follow</span>} />);
    expect(screen.queryByText('legacy-follow')).toBeNull();
    expect((screen.getByRole('button', { name: 'privacy.cancelRequest' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
