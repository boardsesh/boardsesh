import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';

const graphqlRequest = vi.hoisted(() => vi.fn());
const sessionState = vi.hoisted(() => ({
  value: { data: {}, status: 'authenticated' } as { data: unknown; status: string },
}));
/**
 * The token comes from `useWsAuthToken`, the same hook `FollowButton` writes
 * with — NOT off the session, which never carries one.
 */
const wsAuthState = vi.hoisted(() => ({ token: 'token' as string | null }));

vi.mock('next-auth/react', () => ({ useSession: () => sessionState.value }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: (enabled = true) => ({
    token: enabled ? wsAuthState.token : null,
    isAuthenticated: enabled && wsAuthState.token !== null,
    isLoading: false,
    error: null,
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: graphqlRequest }) }));
vi.mock('@/app/components/ui/follow-button', () => ({ default: () => <button type="button">follow</button> }));

const SetterFollowIsland = (await import('../setter-follow-island')).default;

describe('the setter follow island', () => {
  it('renders the server count first, then the live one the follow-state fetch returns', async () => {
    // The response the island already makes carries `followerCount`, and it
    // used to be discarded — so a signed-in viewer read the server snapshot
    // until they themselves followed or unfollowed somebody.
    graphqlRequest.mockResolvedValue({ setterProfile: { isFollowedByMe: true, followerCount: 42 } });

    render(<SetterFollowIsland username="marco" initialFollowerCount={3} />);

    // Server-resolved prop, in the very first render — this is the half that
    // has to stay in the crawlable HTML.
    expect(screen.getByText(/^3/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/^42/)).toBeTruthy());
  });

  it('keeps the server count and shows no button when the profile read fails', async () => {
    graphqlRequest.mockRejectedValue(new Error('offline'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<SetterFollowIsland username="marco" initialFollowerCount={7} />);

    await waitFor(() => expect(consoleError).toHaveBeenCalled());

    // No button, because the failed read cannot say whether this viewer already
    // follows. It used to fall back to "Follow", and a follower who clicked it
    // moved the count to 8 without changing anything on the server.
    expect(screen.queryByRole('button')).toBeNull();
    // The count is a server-resolved prop, so it survives the failure whole.
    expect(screen.getByText(/^7/)).toBeTruthy();
    consoleError.mockRestore();
  });

  it("drops the previous viewer's follow state when the token changes", async () => {
    // Sign out and back in as somebody else and this effect re-runs. Without
    // the reset the button keeps rendering the LAST viewer's answer, and
    // "Following" shown to a stranger is the expensive direction: the toggle
    // sends UNFOLLOW from that state and takes the count down.
    graphqlRequest.mockResolvedValue({ setterProfile: { isFollowedByMe: true, followerCount: 42 } });
    wsAuthState.token = 'token-viewer-a';

    const { rerender } = render(<SetterFollowIsland username="marco" initialFollowerCount={3} />);
    await waitFor(() => expect(screen.getByRole('button')).toBeTruthy());

    // Viewer B's read never resolves, so anything on screen is left over from A.
    graphqlRequest.mockReturnValue(new Promise(() => {}));
    wsAuthState.token = 'token-viewer-b';
    rerender(<SetterFollowIsland username="marco" initialFollowerCount={3} />);

    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });
});
