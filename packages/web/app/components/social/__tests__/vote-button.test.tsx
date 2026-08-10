import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import VoteButton from '../vote-button';

// --- Mocks ---

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

let mockAuthState = { token: 'test-token', isLoading: false, isAuthenticated: true, error: null };
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => mockAuthState,
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  VOTE: 'VOTE',
  GET_VOTE_SUMMARY: 'GET_VOTE_SUMMARY',
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    colors: { error: '#B8524C', success: '#6B9080' },
    typography: { fontSize: { xs: 12 } },
  },
}));

// Default: no context provided
let mockContextValue: { getVoteSummary: (id: string) => unknown } | null = null;
vi.mock('../vote-summary-context', () => ({
  useVoteSummaryContext: () => mockContextValue,
}));

// --- Helpers ---

function renderVoteButton(props: Partial<React.ComponentProps<typeof VoteButton>> = {}) {
  return render(<VoteButton entityType="climb" entityId="climb-1" {...props} />);
}

// --- Tests ---

describe('VoteButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockReset();
    mockAuthState = { token: 'test-token', isLoading: false, isAuthenticated: true, error: null };
    mockContextValue = null;
  });

  describe('fetch behavior', () => {
    it('fetches vote summary on mount when no initialUserVote or context', async () => {
      mockRequest.mockResolvedValueOnce({
        voteSummary: {
          entityType: 'climb',
          entityId: 'climb-1',
          upvotes: 5,
          downvotes: 1,
          voteScore: 4,
          userVote: 1,
        },
      });

      renderVoteButton();

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith('GET_VOTE_SUMMARY', {
          entityType: 'climb',
          entityId: 'climb-1',
        });
      });

      // After fetch, score should be 4 (5 upvotes - 1 downvote)
      await waitFor(() => {
        expect(screen.getByText('4')).toBeTruthy();
      });
    });

    it('skips fetch when initialUserVote is explicitly provided', async () => {
      renderVoteButton({ initialUserVote: 1, initialUpvotes: 3, initialDownvotes: 0 });

      // Give effect time to run
      await act(async () => {});

      expect(mockRequest).not.toHaveBeenCalled();
      // Score should be 3
      expect(screen.getByText('3')).toBeTruthy();
    });

    it('skips fetch when initialUserVote is 0 (explicitly provided)', async () => {
      renderVoteButton({ initialUserVote: 0 });

      await act(async () => {});

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('skips fetch when VoteSummaryProvider context is present', async () => {
      mockContextValue = {
        getVoteSummary: (id: string) =>
          id === 'climb-1'
            ? {
                entityType: 'climb',
                entityId: 'climb-1',
                upvotes: 2,
                downvotes: 0,
                voteScore: 2,
                userVote: 1,
              }
            : undefined,
      };

      renderVoteButton();

      await act(async () => {});

      // Should not fire individual fetch — context handles it
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('uses batch context data when available', async () => {
      mockContextValue = {
        getVoteSummary: (id: string) =>
          id === 'climb-1'
            ? {
                entityType: 'climb',
                entityId: 'climb-1',
                upvotes: 7,
                downvotes: 2,
                voteScore: 5,
                userVote: 1,
              }
            : undefined,
      };

      renderVoteButton();

      // Batch data should sync: score = 7 - 2 = 5
      await waitFor(() => {
        expect(screen.getByText('5')).toBeTruthy();
      });
    });

    it('does not fetch when user is not authenticated', async () => {
      mockAuthState = {
        token: null as unknown as string,
        isLoading: false,
        isAuthenticated: false,
        error: null,
      };

      renderVoteButton();

      await act(async () => {});

      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('race condition: hasVotedRef guard', () => {
    it('does not overwrite optimistic vote with stale fetch response', async () => {
      // Set up a slow fetch that returns userVote=0
      let resolveFetch: (value: unknown) => void;
      const fetchPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });
      mockRequest.mockImplementation((query: string) => {
        if (query === 'GET_VOTE_SUMMARY') return fetchPromise;
        // Vote mutation resolves immediately
        return Promise.resolve({
          vote: {
            entityType: 'climb',
            entityId: 'climb-1',
            upvotes: 1,
            downvotes: 0,
            voteScore: 1,
            userVote: 1,
          },
        });
      });

      renderVoteButton();

      // User clicks upvote before fetch completes
      fireEvent.click(screen.getByLabelText('Upvote'));

      // Score should optimistically be 1
      expect(screen.getByText('1')).toBeTruthy();

      // Now resolve the stale fetch with userVote=0 and score=0
      await act(async () => {
        resolveFetch!({
          voteSummary: {
            entityType: 'climb',
            entityId: 'climb-1',
            upvotes: 0,
            downvotes: 0,
            voteScore: 0,
            userVote: 0,
          },
        });
      });

      // Score should still be 1 (stale fetch should NOT have overwritten)
      expect(screen.getByText('1')).toBeTruthy();
    });
  });

  describe('wire payload: value is always +1/-1, never 0 (pins every UI transition)', () => {
    // The backend rejects any `value` that isn't +1 or -1 — un-voting is done
    // by resending the same value already on record, which the resolver
    // detects and deletes. `0` only ever exists as local "not voted" UI state
    // (see `newUserVote = 0` in vote-button.tsx) and must never reach the wire.
    // These tests exercise the full upvote -> un-vote -> downvote -> un-vote
    // sequence and assert every outgoing VOTE payload.
    function mockVoteResponse(summary: { upvotes: number; downvotes: number; voteScore: number; userVote: number }) {
      mockRequest.mockResolvedValueOnce({
        vote: { entityType: 'climb', entityId: 'climb-1', ...summary },
      });
    }

    // The vote buttons are `disabled={isLoading}`, so a second click fired while
    // the first mutation is still in flight lands on a disabled button and is
    // silently dropped. Waiting only for the request to have been *made* isn't
    // enough — wait for the button to come back before clicking again.
    async function clickWhenEnabled(label: string) {
      const button = screen.getByLabelText(label) as HTMLButtonElement;
      await waitFor(() => expect(button.disabled).toBe(false));
      fireEvent.click(button);
    }

    it('sends value: 1 on first upvote, then value: 1 again to un-vote (never 0)', async () => {
      renderVoteButton({ initialUserVote: 0, initialUpvotes: 0, initialDownvotes: 0 });

      mockVoteResponse({ upvotes: 1, downvotes: 0, voteScore: 1, userVote: 1 });
      fireEvent.click(screen.getByLabelText('Upvote'));
      await waitFor(() =>
        expect(mockRequest).toHaveBeenCalledWith('VOTE', {
          input: { entityType: 'climb', entityId: 'climb-1', value: 1 },
        }),
      );

      mockVoteResponse({ upvotes: 0, downvotes: 0, voteScore: 0, userVote: 0 });
      await clickWhenEnabled('Upvote');
      await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
      expect(mockRequest).toHaveBeenLastCalledWith('VOTE', {
        input: { entityType: 'climb', entityId: 'climb-1', value: 1 },
      });
    });

    it('sends value: -1 on downvote, then value: -1 again to un-vote (never 0)', async () => {
      renderVoteButton({ initialUserVote: 0, initialUpvotes: 0, initialDownvotes: 0 });

      mockVoteResponse({ upvotes: 0, downvotes: 1, voteScore: -1, userVote: -1 });
      fireEvent.click(screen.getByLabelText('Downvote'));
      await waitFor(() =>
        expect(mockRequest).toHaveBeenCalledWith('VOTE', {
          input: { entityType: 'climb', entityId: 'climb-1', value: -1 },
        }),
      );

      mockVoteResponse({ upvotes: 0, downvotes: 0, voteScore: 0, userVote: 0 });
      await clickWhenEnabled('Downvote');
      await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
      expect(mockRequest).toHaveBeenLastCalledWith('VOTE', {
        input: { entityType: 'climb', entityId: 'climb-1', value: -1 },
      });
    });

    it('switching from upvote to downvote sends the new literal value, not a delta', async () => {
      renderVoteButton({ initialUserVote: 1, initialUpvotes: 1, initialDownvotes: 0 });

      mockVoteResponse({ upvotes: 0, downvotes: 1, voteScore: -1, userVote: -1 });
      fireEvent.click(screen.getByLabelText('Downvote'));

      await waitFor(() =>
        expect(mockRequest).toHaveBeenCalledWith('VOTE', {
          input: { entityType: 'climb', entityId: 'climb-1', value: -1 },
        }),
      );
    });
  });

  describe('likeOnly mode', () => {
    it('shows Unlike aria-label when userVote is 1 (filled heart)', () => {
      renderVoteButton({ likeOnly: true, initialUserVote: 1, initialUpvotes: 3 });

      expect(screen.getByLabelText('Unlike')).toBeTruthy();
      expect(screen.getByText('3')).toBeTruthy();
    });

    it('shows Like aria-label when userVote is 0 (outline heart)', () => {
      renderVoteButton({ likeOnly: true, initialUserVote: 0 });

      expect(screen.getByLabelText('Like')).toBeTruthy();
    });

    it('fetches and shows filled heart from batch context', async () => {
      mockContextValue = {
        getVoteSummary: (id: string) =>
          id === 'climb-1'
            ? {
                entityType: 'climb',
                entityId: 'climb-1',
                upvotes: 5,
                downvotes: 0,
                voteScore: 5,
                userVote: 1,
              }
            : undefined,
      };

      renderVoteButton({ likeOnly: true });

      await waitFor(() => {
        expect(screen.getByLabelText('Unlike')).toBeTruthy();
        expect(screen.getByText('5')).toBeTruthy();
      });
    });
  });
});
