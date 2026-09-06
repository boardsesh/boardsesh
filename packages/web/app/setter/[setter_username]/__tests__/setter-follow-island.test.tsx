import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';

const graphqlRequest = vi.hoisted(() => vi.fn());
const sessionState = vi.hoisted(() => ({
  value: { data: { authToken: 'token' }, status: 'authenticated' } as { data: unknown; status: string },
}));

vi.mock('next-auth/react', () => ({ useSession: () => sessionState.value }));
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
});
