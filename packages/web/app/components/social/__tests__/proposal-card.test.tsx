import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { Proposal } from '@boardsesh/shared-schema';
import ProposalCard from '../proposal-card';

// --- Mocks ---

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/kilter/original/12x12/default/40/list',
}));

vi.mock('@/app/hooks/use-is-dark-mode', () => ({
  useIsDarkMode: () => false,
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({
    token: 'test-token',
    isLoading: false,
    isAuthenticated: true,
    error: null,
  }),
}));

vi.mock('@/app/lib/graphql/operations/proposals', () => ({
  VOTE_ON_PROPOSAL: 'VOTE_ON_PROPOSAL',
  RESOLVE_PROPOSAL: 'RESOLVE_PROPOSAL',
  DELETE_PROPOSAL: 'DELETE_PROPOSAL',
}));

// Mock ClimbListItem to verify it receives the correct props
const mockClimbListItem = vi.fn();
vi.mock('@/app/components/climb-card/climb-list-item', () => ({
  default: (props: {
    climb: { uuid: string; name: string; difficulty: string; setter_username: string };
    disableSwipe?: boolean;
  }) => {
    mockClimbListItem(props);
    return (
      <div data-testid="climb-list-item-mock">
        {props.climb.name && <span data-testid="climb-name">{props.climb.name}</span>}
        {props.climb.difficulty && <span data-testid="climb-difficulty">{props.climb.difficulty}</span>}
        {props.climb.setter_username && <span data-testid="climb-setter">{props.climb.setter_username}</span>}
        {props.disableSwipe && <span data-testid="disable-swipe">true</span>}
      </div>
    );
  },
}));

// Mock board utilities
vi.mock('@/app/components/board-renderer/util', () => ({
  convertLitUpHoldsStringToMap: () => [{ 123: { state: 1 } }],
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: (params: { board_name: string }) => ({
    board_name: params.board_name,
    layout_id: 1,
    size_id: 1,
    set_ids: '1',
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 100,
    boardWidth: 100,
  }),
}));

vi.mock('@/app/lib/default-board-configs', () => ({
  getDefaultBoardConfig: () => ({ sizeId: 1, setIds: '1' }),
}));

vi.mock('../proposal-vote-bar', () => ({
  default: () => <div data-testid="proposal-vote-bar" />,
}));

const mockFeedCommentButton = vi.fn();
vi.mock('../feed-comment-button', () => ({
  default: (props: { entityType: string; entityId: string; commentCount?: number }) => {
    mockFeedCommentButton(props);
    return (
      <div
        data-testid="feed-comment-button"
        data-entity-type={props.entityType}
        data-entity-id={props.entityId}
        data-comment-count={props.commentCount ?? 0}
      />
    );
  },
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    neutral: {
      50: '#F9FAFB',
      100: '#F3F4F6',
      200: '#E5E7EB',
      300: '#D1D5DB',
      400: '#9CA3AF',
      500: '#6B7280',
      600: '#4B5563',
      800: '#1F2937',
    },
    colors: {
      primary: '#8C4A52',
      success: '#6B9080',
      error: '#B8524C',
      amber: '#FBBF24',
      purple: '#9C27B0',
    },
  },
}));

// --- Helpers ---

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    uuid: 'proposal-1',
    climbUuid: 'climb-abc123',
    boardType: 'kilter',
    angle: 40,
    proposerId: 'user-1',
    proposerDisplayName: 'Test User',
    proposerAvatarUrl: null,
    type: 'grade',
    proposedValue: 'V5',
    currentValue: 'V4',
    status: 'open',
    reason: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: '2024-01-15T10:00:00.000Z',
    weightedUpvotes: 3,
    weightedDownvotes: 0,
    requiredUpvotes: 5,
    userVote: 0,
    climbName: 'Test Boulder',
    frames: 'p123r14p456r15',
    layoutId: 1,
    climbSetterUsername: 'setter_joe',
    climbDifficulty: 'V4',
    climbQualityAverage: '3.5',
    climbAscensionistCount: 42,
    climbDifficultyError: '0.5',
    climbBenchmarkDifficulty: null,
    ...overrides,
  };
}

describe('ProposalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockReset();
  });

  describe('ClimbListItem integration', () => {
    it('renders ClimbListItem component', () => {
      render(<ProposalCard proposal={makeProposal()} />);
      expect(screen.getByTestId('climb-list-item-mock')).toBeTruthy();
    });

    it('passes disableSwipe prop to ClimbListItem', () => {
      render(<ProposalCard proposal={makeProposal()} />);
      expect(screen.getByTestId('disable-swipe')).toBeTruthy();
      expect(mockClimbListItem).toHaveBeenCalledWith(expect.objectContaining({ disableSwipe: true }));
    });

    it('constructs climb data from proposal fields', () => {
      render(
        <ProposalCard
          proposal={makeProposal({
            climbName: 'My Boulder',
            climbSetterUsername: 'alice',
            climbDifficulty: 'V6',
          })}
        />,
      );

      expect(mockClimbListItem).toHaveBeenCalledWith(
        expect.objectContaining({
          climb: expect.objectContaining({
            uuid: 'climb-abc123',
            name: 'My Boulder',
            setter_username: 'alice',
            difficulty: 'V6',
          }),
        }),
      );
    });

    it('passes climb quality and stats from proposal', () => {
      render(
        <ProposalCard
          proposal={makeProposal({
            climbQualityAverage: '4.2',
            climbAscensionistCount: 100,
            climbDifficultyError: '0.3',
          })}
        />,
      );

      expect(mockClimbListItem).toHaveBeenCalledWith(
        expect.objectContaining({
          climb: expect.objectContaining({
            quality_average: '4.2',
            ascensionist_count: 100,
            difficulty_error: '0.3',
          }),
        }),
      );
    });

    it('passes boardDetails with correct board_name', () => {
      render(<ProposalCard proposal={makeProposal({ boardType: 'kilter' })} />);

      expect(mockClimbListItem).toHaveBeenCalledWith(
        expect.objectContaining({
          boardDetails: expect.objectContaining({
            board_name: 'kilter',
          }),
        }),
      );
    });

    it('does not render ClimbListItem when climbName and frames are null', () => {
      render(<ProposalCard proposal={makeProposal({ climbName: null, frames: null })} />);
      expect(screen.queryByTestId('climb-list-item-mock')).toBeNull();
    });

    it('does not render ClimbListItem when layoutId is null', () => {
      render(<ProposalCard proposal={makeProposal({ layoutId: null })} />);
      expect(screen.queryByTestId('climb-list-item-mock')).toBeNull();
    });

    it('renders ClimbListItem when angle is null (classic proposals)', () => {
      render(<ProposalCard proposal={makeProposal({ angle: null })} />);
      expect(screen.getByTestId('climb-list-item-mock')).toBeTruthy();
      // Should use 0 as fallback angle
      expect(mockClimbListItem).toHaveBeenCalledWith(
        expect.objectContaining({
          climb: expect.objectContaining({ angle: 0 }),
        }),
      );
    });

    it('handles missing optional climb fields gracefully', () => {
      render(
        <ProposalCard
          proposal={makeProposal({
            climbSetterUsername: null,
            climbDifficulty: null,
            climbQualityAverage: null,
            climbAscensionistCount: null,
            climbDifficultyError: null,
            climbBenchmarkDifficulty: null,
          })}
        />,
      );

      expect(mockClimbListItem).toHaveBeenCalledWith(
        expect.objectContaining({
          climb: expect.objectContaining({
            setter_username: '',
            difficulty: '',
            quality_average: '0',
            ascensionist_count: 0,
            difficulty_error: '0',
            benchmark_difficulty: null,
          }),
        }),
      );
    });
  });

  describe('Basic rendering', () => {
    it('renders the card with data-testid', () => {
      render(<ProposalCard proposal={makeProposal()} />);
      expect(screen.getByTestId('proposal-card')).toBeTruthy();
    });

    it('displays proposer name', () => {
      render(<ProposalCard proposal={makeProposal({ proposerDisplayName: 'Alice' })} />);
      expect(screen.getByText('Alice')).toBeTruthy();
    });

    it('displays type chip', () => {
      render(<ProposalCard proposal={makeProposal({ type: 'grade' })} />);
      expect(screen.getByText('Grade')).toBeTruthy();
    });

    it('displays value change chips', () => {
      render(<ProposalCard proposal={makeProposal({ currentValue: 'V3', proposedValue: 'V5' })} />);
      expect(screen.getByText('V3')).toBeTruthy();
      expect(screen.getByText('V5')).toBeTruthy();
    });

    it('displays reason when provided', () => {
      render(<ProposalCard proposal={makeProposal({ reason: 'Feels way harder' })} />);
      expect(screen.getByText(/Feels way harder/)).toBeTruthy();
    });

    it('does not display reason when not provided', () => {
      render(<ProposalCard proposal={makeProposal({ reason: null })} />);
      expect(screen.queryByText(/Feels/)).toBeNull();
    });

    it('displays timestamp', () => {
      render(<ProposalCard proposal={makeProposal()} />);
      // Date formatted as locale date string
      expect(screen.getByText(/2024/)).toBeTruthy();
    });

    it('renders vote bar', () => {
      render(<ProposalCard proposal={makeProposal()} />);
      expect(screen.getByTestId('proposal-vote-bar')).toBeTruthy();
    });
  });

  describe('Voting', () => {
    it('updates proposal state after successful vote', async () => {
      const updatedProposal = makeProposal({ userVote: 1, weightedUpvotes: 4 });
      mockRequest.mockResolvedValueOnce({ voteOnProposal: updatedProposal });

      const onUpdate = vi.fn();
      render(<ProposalCard proposal={makeProposal()} onUpdate={onUpdate} />);

      // Click the upvote button (Support)
      const supportButton = screen.getByRole('button', { name: /support/i });
      fireEvent.click(supportButton);

      await waitFor(() => {
        expect(onUpdate).toHaveBeenCalledWith(updatedProposal);
      });
    });
  });

  describe('Admin actions', () => {
    it('shows approve/reject buttons for admin', () => {
      render(<ProposalCard proposal={makeProposal()} isAdminOrLeader />);
      expect(screen.getByText('Approve')).toBeTruthy();
      expect(screen.getByText('Reject')).toBeTruthy();
    });

    it('does not show approve/reject buttons for non-admin', () => {
      render(<ProposalCard proposal={makeProposal()} />);
      expect(screen.queryByText('Approve')).toBeNull();
      expect(screen.queryByText('Reject')).toBeNull();
    });

    it('shows delete button for approved proposals when admin', () => {
      render(<ProposalCard proposal={makeProposal({ status: 'approved' })} isAdminOrLeader />);
      expect(screen.getByText('Delete Proposal')).toBeTruthy();
    });

    it('does not show vote buttons for non-open proposals', () => {
      render(<ProposalCard proposal={makeProposal({ status: 'approved' })} />);
      expect(screen.queryByRole('button', { name: /support/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /oppose/i })).toBeNull();
    });
  });

  describe('Comments', () => {
    it('renders FeedCommentButton with proposal entity type', () => {
      render(<ProposalCard proposal={makeProposal()} />);

      const commentButton = screen.getByTestId('feed-comment-button');
      expect(commentButton.getAttribute('data-entity-type')).toBe('proposal');
      expect(commentButton.getAttribute('data-entity-id')).toBe('proposal-1');
    });

    it('passes correct entity id from local proposal state', () => {
      render(<ProposalCard proposal={makeProposal({ uuid: 'custom-uuid' })} />);

      const commentButton = screen.getByTestId('feed-comment-button');
      expect(commentButton.getAttribute('data-entity-id')).toBe('custom-uuid');
    });
  });

  describe('Preview updates with vote', () => {
    it('preserves climb data when proposal updates after vote', async () => {
      const originalProposal = makeProposal({
        climbName: 'Original Climb',
        frames: 'p1r14',
        layoutId: 1,
      });
      const updatedProposal = {
        ...originalProposal,
        userVote: 1,
        weightedUpvotes: 4,
      };
      mockRequest.mockResolvedValueOnce({ voteOnProposal: updatedProposal });

      render(<ProposalCard proposal={originalProposal} />);

      // Click vote
      fireEvent.click(screen.getByRole('button', { name: /support/i }));

      await waitFor(() => {
        // The climb list item should still show the climb name after the vote update
        expect(screen.getByTestId('climb-name').textContent).toBe('Original Climb');
      });
    });
  });
});
