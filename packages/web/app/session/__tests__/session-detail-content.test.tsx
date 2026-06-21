import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { SessionDetail } from '@boardsesh/shared-schema';
import SessionDetailContent from '../[sessionId]/session-detail-content';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Mock dependencies
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const mockRouterPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/app/hooks/use-session-detail', () => ({
  useSessionDetail: ({ initialData }: { initialData: unknown }) => ({
    session: initialData ?? null,
    isLoading: false,
  }),
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    transitions: { normal: '200ms ease' },
    shadows: { md: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' },
    borderRadius: { full: 9999, sm: 4 },
    colors: { amber: '#FBBF24', success: '#6B9080', successBg: '#EFF5F2', error: '#f44336', primary: '#8C4A52' },
    typography: {
      fontSize: { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24 },
      fontWeight: { normal: 400, medium: 500, semibold: 600, bold: 700 },
    },
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 16: 64 },
    neutral: { 100: '#F3F4F6', 200: '#E5E7EB', 300: '#D1D5DB', 400: '#9CA3AF', 500: '#6B7280' },
    opacity: { subtle: 0.6 },
  },
}));

vi.mock('@/app/lib/grade-colors', () => ({
  formatVGrade: (g: string | null | undefined) => g ?? null,
  formatGrade: (g: string | null | undefined) => g ?? null,
  getSoftGradeColor: () => '#888',
  getSoftVGradeColor: () => '#888',
  getSoftGradeColorByFormat: () => '#888',
  getGradeTintColor: () => null,
  getGradeColorWithOpacity: () => '#888',
  getGradeTextColor: () => '#000',
  isLightColor: () => false,
  getSoftFontGradeColor: () => '#888',
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/lib/share-utils', () => ({
  shareWithFallback: vi.fn(),
}));

vi.mock('@/app/hooks/use-board-details-map', () => ({
  useBoardDetailsMap: () => ({
    boardDetailsByClimb: {},
    defaultBoardDetails: {
      board_name: 'kilter',
      layout_id: 1,
      size_id: 1,
      set_ids: [1],
      boardWidth: 100,
      boardHeight: 200,
      images_to_holds: {},
      holdsData: [],
      edge_left: 0,
      edge_right: 100,
      edge_bottom: 0,
      edge_top: 200,
    },
    unsupportedClimbs: new Set(),
    upsizedClimbs: new Set(),
  }),
}));

vi.mock('@/app/components/board-renderer/board-renderer', () => ({
  default: () => <div data-testid="board-renderer" />,
}));

vi.mock('@/app/components/board-page/angle-selector', () => ({
  default: () => <div data-testid="angle-selector" />,
}));

vi.mock('@/app/components/collapsible-section/collapsible-section', () => ({
  default: ({
    title,
    children,
    defaultExpanded,
    sections,
  }: {
    title?: string;
    children?: React.ReactNode;
    defaultExpanded?: boolean;
    sections?: Array<{ key: string; label: string; content: React.ReactNode }>;
  }) => (
    <div data-testid="collapsible-section" data-title={title} data-expanded={defaultExpanded}>
      {children}
      {sections?.map((s) => (
        <div key={s.key} data-testid={`section-${s.key}`}>
          {s.content}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: 'v-grade',
    formatGrade: (d: string | null | undefined) => d ?? null,
    getGradeColor: () => '#888',
    loaded: true,
  }),
}));

vi.mock('@/app/lib/session-utils', () => ({
  generateSessionName: (firstTickAt: string | null, boardTypes: string[]) => {
    if (!firstTickAt) return 'Session';
    const day = new Date(firstTickAt).toLocaleDateString('en-US', { weekday: 'long' });
    const board = boardTypes[0] ? boardTypes[0].charAt(0).toUpperCase() + boardTypes[0].slice(1) : '';
    return `${day} ${board} Session`;
  },
}));

vi.mock('@/app/components/ui/confirm-popover', () => ({
  ConfirmPopover: () => null,
}));

vi.mock('@/app/components/healthkit/save-to-healthkit-button', () => ({
  default: () => null,
}));

vi.mock('@/app/components/charts/css-bar-chart', () => ({
  CssBarChart: (props: { ariaLabel?: string }) => <div data-testid="css-bar-chart" aria-label={props.ariaLabel} />,
}));

vi.mock('@/app/components/charts/session-grade-bars', () => ({
  buildSessionGradeBars: () => [],
  SESSION_GRADE_LEGEND: [
    { label: 'Flash', color: '#6B908099' },
    { label: 'Send', color: '#B8524C99' },
    { label: 'Attempt', color: '#D1D5DB99' },
  ],
}));

vi.mock('@/app/components/social/vote-button', () => ({
  default: ({
    entityType,
    entityId,
    initialUpvotes,
  }: {
    entityType: string;
    entityId: string;
    initialUpvotes?: number;
  }) => (
    <div
      data-testid="vote-button"
      data-entity-type={entityType}
      data-entity-id={entityId}
      data-initial-upvotes={initialUpvotes ?? 0}
    />
  ),
}));

vi.mock('@/app/components/social/vote-summary-context', () => ({
  VoteSummaryProvider: ({ children }: { children: React.ReactNode }) => children,
  useVoteSummaryContext: () => null,
}));

vi.mock('@/app/components/social/comment-section', () => ({
  default: ({ entityType, entityId, title }: { entityType: string; entityId: string; title?: string }) => (
    <div
      data-testid="comment-section"
      data-entity-type={entityType}
      data-entity-id={entityId}
      data-title={title ?? ''}
    />
  ),
}));

// Mock ClimbsList to render a testable placeholder with climb data
vi.mock('@/app/components/board-page/climbs-list', () => ({
  default: (props: {
    climbs: Array<{ uuid: string; name: string }>;
    renderItemExtra?: (climb: { uuid: string; name: string }) => React.ReactNode;
    boardDetails?: unknown;
    boardDetailsByClimb?: unknown;
    unsupportedClimbs?: unknown;
    upsizedClimbs?: unknown;
    isFetching?: boolean;
    hasMore?: boolean;
    onClimbSelect?: (climb: { uuid: string; name: string }) => void;
    onLoadMore?: unknown;
    hideEndMessage?: boolean;
    showBottomSpacer?: boolean;
  }) => (
    <div data-testid="climbs-list">
      {props.climbs.map((climb) => (
        <div
          key={climb.uuid}
          data-testid="climb-item"
          data-climb-name={climb.name}
          onClick={() => props.onClimbSelect?.(climb)}
        >
          {climb.name}
          {props.renderItemExtra?.(climb)}
        </div>
      ))}
    </div>
  ),
}));

// Mock graphql-queue to expose a controllable useOptionalQueueActions for the
// click-handler tests below. The default export returns null (no provider),
// matching production behavior on /session/[sessionId] standalone pages.
const mockSetCurrentClimb = vi.fn();
let mockQueueActions: { setCurrentClimb: typeof mockSetCurrentClimb } | null = null;
let mockSessionDataValue: { isPersistentSessionActive: boolean } | null = null;
vi.mock('@/app/components/graphql-queue', () => ({
  useOptionalQueueActions: () => mockQueueActions,
  useOptionalSessionData: () => mockSessionDataValue,
}));

vi.mock('@/app/components/climb-actions/favorites-batch-context', () => ({
  FavoritesProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/app/components/climb-actions/playlists-batch-context', () => ({
  PlaylistsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/app/hooks/use-climb-actions-data', () => ({
  useClimbActionsData: () => ({
    favoritesProviderProps: {},
    playlistsProviderProps: {},
  }),
}));

vi.mock('@/app/hooks/use-my-boards', () => ({
  useMyBoards: () => ({ boards: [], isLoading: false }),
}));

vi.mock('@/app/hooks/use-delete-tick', () => ({
  useDeleteTick: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock('@/app/lib/board-config-for-playlist', () => ({
  getBoardDetailsForPlaylist: () => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: [1],
    boardWidth: 100,
    boardHeight: 200,
  }),
  getDefaultAngleForBoard: () => 40,
  getUserBoardDetails: () => null,
}));

vi.mock('@/app/components/board-renderer/util', () => ({
  convertLitUpHoldsStringToMap: () => [{}],
}));

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: 'session-1',
    sessionType: 'party',
    sessionName: null,
    ownerUserId: 'user-1',
    participants: [
      {
        userId: 'user-1',
        displayName: 'Test User',
        avatarUrl: null,
        sends: 5,
        flashes: 2,
        attempts: 3,
      },
    ],
    totalSends: 5,
    totalFlashes: 2,
    totalAttempts: 3,
    tickCount: 8,
    gradeDistribution: [{ grade: 'V5', flash: 2, send: 3, attempt: 3 }],
    boardTypes: ['kilter'],
    hardestGrade: 'V5',
    firstTickAt: '2024-01-15T10:00:00.000Z',
    lastTickAt: '2024-01-15T12:00:00.000Z',
    durationMinutes: 120,
    goal: null,
    ticks: [
      {
        uuid: 'tick-1',
        userId: 'user-1',
        climbUuid: 'climb-1',
        climbName: 'Test Climb',
        boardType: 'kilter',
        layoutId: 1,
        angle: 40,
        status: 'send',
        attemptCount: 1,
        difficulty: 20,
        difficultyName: 'V5',
        quality: 3,
        isMirror: false,
        isBenchmark: false,
        isNoMatch: false,
        comment: null,
        frames: 'abc',
        setterUsername: 'setter1',
        climbedAt: '2024-01-15T10:30:00.000Z',
        upvotes: 3,
      },
    ],
    upvotes: 5,
    downvotes: 1,
    voteScore: 4,
    commentCount: 2,
    ...overrides,
  };
}

describe('SessionDetailContent', () => {
  it('shows "not found" when session is null', () => {
    render(<SessionDetailContent session={null} />);
    expect(screen.getByText('Session Not Found')).toBeTruthy();
  });

  it('renders session stats', () => {
    render(<SessionDetailContent session={makeSession()} />);
    // totalSends (5) minus totalFlashes (2) = 3 sends
    expect(screen.getByText('3 sends')).toBeTruthy();
    expect(screen.getByText('2 flashes')).toBeTruthy();
    expect(screen.getByText('3 attempts')).toBeTruthy();
    expect(screen.getByText('8 climbs')).toBeTruthy();
  });

  it('renders ClimbsList with converted climbs', () => {
    render(<SessionDetailContent session={makeSession()} />);
    expect(screen.getByTestId('climbs-list')).toBeTruthy();
    expect(screen.getByText('Test Climb')).toBeTruthy();
    expect(screen.getByText('Climbs (1)')).toBeTruthy();
  });

  it('updates rendered climbs when session prop changes without remount', () => {
    const first = makeSession();
    const second = makeSession({
      tickCount: 2,
      totalSends: 6,
      ticks: [
        first.ticks[0],
        {
          uuid: 'tick-2',
          userId: 'user-1',
          climbUuid: 'climb-2',
          climbName: 'Second Climb',
          boardType: 'kilter',
          layoutId: 1,
          angle: 40,
          status: 'send',
          attemptCount: 2,
          difficulty: 21,
          difficultyName: 'V6',
          quality: 3,
          isMirror: false,
          isBenchmark: false,
          isNoMatch: false,
          comment: null,
          frames: 'def',
          setterUsername: 'setter2',
          climbedAt: '2024-01-15T10:45:00.000Z',
          upvotes: 1,
        },
      ],
    });

    const { rerender } = render(<SessionDetailContent session={first} />);
    expect(screen.getByText('Climbs (1)')).toBeTruthy();

    rerender(<SessionDetailContent session={second} />);
    expect(screen.getByText('Climbs (2)')).toBeTruthy();
    expect(screen.getByText('Second Climb')).toBeTruthy();
  });

  it('renders session-level VoteButton with session entity type', () => {
    render(<SessionDetailContent session={makeSession()} />);
    const voteButtons = screen.getAllByTestId('vote-button');
    const sessionVote = voteButtons.find((el) => el.getAttribute('data-entity-type') === 'session');
    expect(sessionVote).toBeTruthy();
    expect(sessionVote!.getAttribute('data-entity-id')).toBe('session-1');
  });

  it('renders session-level CommentSection collapsed by default', () => {
    render(<SessionDetailContent session={makeSession()} />);
    // Session comments should be collapsed by default
    const commentSections = screen.queryAllByTestId('comment-section');
    const sessionComment = commentSections.find((el) => el.getAttribute('data-entity-type') === 'session');
    expect(sessionComment).toBeFalsy();
  });

  it('expands session-level CommentSection when comment button is clicked', () => {
    render(<SessionDetailContent session={makeSession()} />);

    fireEvent.click(screen.getByTestId('session-comment-toggle'));

    // After clicking, the session comment section should be visible
    const commentSections = screen.getAllByTestId('comment-section');
    const sessionComment = commentSections.find((el) => el.getAttribute('data-entity-type') === 'session');
    expect(sessionComment).toBeTruthy();
    expect(sessionComment!.getAttribute('data-entity-id')).toBe('session-1');
  });

  it('renders comment toggle button on each tick', () => {
    render(<SessionDetailContent session={makeSession()} />);
    // Each tick should have a comment toggle button (tick comments are collapsed by default)
    const commentButtons = screen
      .getAllByRole('button')
      .filter((el) => el.querySelector('[data-testid="ChatBubbleOutlineOutlinedIcon"]'));
    // At least one comment toggle for the tick (plus one for session-level)
    expect(commentButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('shows session name when available', () => {
    render(<SessionDetailContent session={makeSession({ sessionName: 'Evening Crush' })} />);
    expect(screen.getByText('Evening Crush')).toBeTruthy();
  });

  it('generates title from day and board type when no session name', () => {
    // 2024-01-15 is a Monday, boardTypes is ['kilter']
    render(<SessionDetailContent session={makeSession()} />);
    expect(screen.getByText('Monday Kilter Session')).toBeTruthy();
  });

  it('shows goal when available', () => {
    render(<SessionDetailContent session={makeSession({ goal: 'Send V7' })} />);
    expect(screen.getByText(/Send V7/)).toBeTruthy();
  });

  it('renders grade distribution chart', () => {
    render(<SessionDetailContent session={makeSession()} />);
    expect(screen.getByTestId('css-bar-chart')).toBeTruthy();
    expect(screen.getByText('Grade Distribution')).toBeTruthy();
  });

  it('hides grade chart when distribution is empty', () => {
    render(<SessionDetailContent session={makeSession({ gradeDistribution: [] })} />);
    expect(screen.queryByTestId('css-bar-chart')).toBeNull();
  });

  it('shows back button linking to home', () => {
    render(<SessionDetailContent session={makeSession()} />);
    const links = screen.getAllByRole('link');
    const backLink = links.find((l) => l.getAttribute('href') === '/');
    expect(backLink).toBeTruthy();
  });

  it('shows board type chips', () => {
    render(<SessionDetailContent session={makeSession({ boardTypes: ['kilter', 'tension'] })} />);
    expect(screen.getByText('Kilter')).toBeTruthy();
    expect(screen.getByText('Tension')).toBeTruthy();
  });

  it('shows duration in hours', () => {
    render(<SessionDetailContent session={makeSession({ durationMinutes: 120 })} />);
    expect(screen.getByText('2h')).toBeTruthy();
  });

  it('shows hardest grade', () => {
    render(<SessionDetailContent session={makeSession({ hardestGrade: 'V8' })} />);
    expect(screen.getByText('Hardest: V8')).toBeTruthy();
  });

  it('renders per-tick VoteButton with tick entity type and SSR upvotes', () => {
    render(<SessionDetailContent session={makeSession()} />);
    const voteButtons = screen.getAllByTestId('vote-button');
    const tickVote = voteButtons.find((el) => el.getAttribute('data-entity-type') === 'tick');
    expect(tickVote).toBeTruthy();
    expect(tickVote!.getAttribute('data-entity-id')).toBe('tick-1');
    expect(tickVote!.getAttribute('data-initial-upvotes')).toBe('3');
  });

  it('renders tick status details for single-user sessions', () => {
    render(<SessionDetailContent session={makeSession()} />);
    // The status chip should be rendered via renderItemExtra
    expect(screen.getByText('send')).toBeTruthy();
    // Shows descriptive attempt text instead of "1x"
    expect(screen.getByText('on 1st attempt')).toBeTruthy();
  });

  it('shows total attempts when totalAttempts exceeds attemptCount', () => {
    const session = makeSession({
      ticks: [
        {
          uuid: 'tick-1',
          userId: 'user-1',
          climbUuid: 'climb-1',
          climbName: 'Hard Climb',
          boardType: 'kilter',
          layoutId: 1,
          angle: 40,
          status: 'send',
          attemptCount: 3,
          difficulty: 20,
          difficultyName: 'V5',
          quality: 3,
          isMirror: false,
          isBenchmark: false,
          isNoMatch: false,
          comment: null,
          frames: 'abc',
          setterUsername: 'setter1',
          climbedAt: '2024-01-15T10:30:00.000Z',
          upvotes: 0,
          totalAttempts: 15,
        },
      ],
    });
    render(<SessionDetailContent session={session} />);
    expect(screen.getByText('on 3rd attempt, 15 total')).toBeTruthy();
  });

  it('does not show extra attempt text for flash status', () => {
    const session = makeSession({
      totalAttempts: 0,
      ticks: [
        {
          uuid: 'tick-1',
          userId: 'user-1',
          climbUuid: 'climb-1',
          climbName: 'Easy Climb',
          boardType: 'kilter',
          layoutId: 1,
          angle: 40,
          status: 'flash',
          attemptCount: 1,
          difficulty: 10,
          difficultyName: 'V2',
          quality: 3,
          isMirror: false,
          isBenchmark: false,
          isNoMatch: false,
          comment: null,
          frames: 'abc',
          setterUsername: 'setter1',
          climbedAt: '2024-01-15T10:30:00.000Z',
          upvotes: 0,
        },
      ],
    });
    render(<SessionDetailContent session={session} />);
    expect(screen.getByText('flash')).toBeTruthy();
    // No "on Nth attempt" or "N attempts" text should appear for flash
    expect(screen.queryByText(/on \d+\w+ attempt/)).toBeNull();
    expect(screen.queryByText(/\d+ attempts?$/)).toBeNull();
  });

  it('deduplicates climbs with same climbUuid', () => {
    const sessionWithDuplicates = makeSession({
      ticks: [
        {
          uuid: 'tick-1',
          userId: 'user-1',
          climbUuid: 'climb-1',
          climbName: 'Duplicated Climb',
          boardType: 'kilter',
          layoutId: 1,
          angle: 40,
          status: 'send',
          attemptCount: 1,
          difficulty: 20,
          difficultyName: 'V5',
          quality: 3,
          isMirror: false,
          isBenchmark: false,
          isNoMatch: false,
          comment: null,
          frames: 'abc',
          setterUsername: 'setter1',
          climbedAt: '2024-01-15T10:30:00.000Z',
          upvotes: 0,
        },
        {
          uuid: 'tick-2',
          userId: 'user-1',
          climbUuid: 'climb-1',
          climbName: 'Duplicated Climb',
          boardType: 'kilter',
          layoutId: 1,
          angle: 40,
          status: 'flash',
          attemptCount: 1,
          difficulty: 20,
          difficultyName: 'V5',
          quality: 3,
          isMirror: false,
          isBenchmark: false,
          isNoMatch: false,
          comment: null,
          frames: 'abc',
          setterUsername: 'setter1',
          climbedAt: '2024-01-15T11:00:00.000Z',
          upvotes: 0,
        },
      ],
    });
    render(<SessionDetailContent session={sessionWithDuplicates} />);
    const climbItems = screen.getAllByTestId('climb-item');
    expect(climbItems).toHaveLength(1);
  });

  it('renders per-user tick details in multi-user sessions', () => {
    const multiUserSession = makeSession({
      participants: [
        {
          userId: 'user-1',
          displayName: 'Alice',
          avatarUrl: null,
          sends: 3,
          flashes: 1,
          attempts: 1,
        },
        {
          userId: 'user-2',
          displayName: 'Bob',
          avatarUrl: null,
          sends: 2,
          flashes: 1,
          attempts: 0,
        },
      ],
      ticks: [
        {
          uuid: 'tick-1',
          userId: 'user-1',
          climbUuid: 'climb-1',
          climbName: 'Shared Climb',
          boardType: 'kilter',
          layoutId: 1,
          angle: 40,
          status: 'send',
          attemptCount: 2,
          difficulty: 20,
          difficultyName: 'V5',
          quality: 3,
          isMirror: false,
          isBenchmark: false,
          isNoMatch: false,
          comment: null,
          frames: 'abc',
          setterUsername: 'setter1',
          climbedAt: '2024-01-15T10:30:00.000Z',
          upvotes: 0,
        },
        {
          uuid: 'tick-2',
          userId: 'user-2',
          climbUuid: 'climb-1',
          climbName: 'Shared Climb',
          boardType: 'kilter',
          layoutId: 1,
          angle: 40,
          status: 'flash',
          attemptCount: 1,
          difficulty: 20,
          difficultyName: 'V5',
          quality: 3,
          isMirror: false,
          isBenchmark: false,
          isNoMatch: false,
          comment: null,
          frames: 'abc',
          setterUsername: 'setter1',
          climbedAt: '2024-01-15T10:35:00.000Z',
          upvotes: 0,
        },
      ],
    });
    render(<SessionDetailContent session={multiUserSession} />);
    // Per-user tick details should be rendered via renderItemExtra
    const voteButtons = screen.getAllByTestId('vote-button');
    const tickVotes = voteButtons.filter((el) => el.getAttribute('data-entity-type') === 'tick');
    // Two ticks for two users on the same climb
    expect(tickVotes).toHaveLength(2);
    // Participant names appear in multiple places (header, stats, tick details)
    expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Bob').length).toBeGreaterThanOrEqual(1);
  });

  it('tick comment section is hidden by default', () => {
    render(<SessionDetailContent session={makeSession()} />);
    // By default, all comment sections (both session and tick) should be collapsed
    const allCommentSections = screen.queryAllByTestId('comment-section');
    const tickCommentSections = allCommentSections.filter((el) => el.getAttribute('data-entity-type') === 'tick');
    expect(tickCommentSections).toHaveLength(0);
  });

  it('tick comment toggle button exists for each tick', () => {
    render(<SessionDetailContent session={makeSession()} />);
    // Find tick-level comment toggle buttons (ChatBubbleOutlineOutlined icons not inside the session-level area)
    const allButtons = screen.getAllByRole('button');
    const tickCommentButtons = allButtons.filter((btn) => {
      const icon = btn.querySelector('[data-testid="ChatBubbleOutlineOutlinedIcon"]');
      return !!icon;
    });
    // At least 2: one for the session-level toggle and one for the tick-level toggle
    expect(tickCommentButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('session comment section renders below the vote button row when expanded', () => {
    render(<SessionDetailContent session={makeSession()} />);

    // Expand session comments by clicking the toggle button
    const sessionCommentToggle = screen.getByTestId('session-comment-toggle');
    fireEvent.click(sessionCommentToggle);

    // Session-level CommentSection should be a sibling of the vote/comment button row, not nested inside it
    const sessionCommentSection = screen
      .getAllByTestId('comment-section')
      .find((el) => el.getAttribute('data-entity-type') === 'session');
    expect(sessionCommentSection).toBeTruthy();
    // The toggle button's parent flex row should NOT contain the comment section
    const buttonRow = sessionCommentToggle.parentElement!;
    expect(buttonRow.contains(sessionCommentSection!)).toBe(false);
  });

  it('displays comment count on session comment toggle button', () => {
    render(<SessionDetailContent session={makeSession({ commentCount: 5 })} />);
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('shows tick comment text when present', () => {
    const session = makeSession({
      ticks: [
        {
          uuid: 'tick-1',
          userId: 'user-1',
          climbUuid: 'climb-1',
          climbName: 'Commented Climb',
          boardType: 'kilter',
          layoutId: 1,
          angle: 40,
          status: 'send',
          attemptCount: 1,
          difficulty: 20,
          difficultyName: 'V5',
          quality: 3,
          isMirror: false,
          isBenchmark: false,
          isNoMatch: false,
          comment: 'Great beta!',
          frames: 'abc',
          setterUsername: 'setter1',
          climbedAt: '2024-01-15T10:30:00.000Z',
          upvotes: 0,
        },
      ],
    });
    render(<SessionDetailContent session={session} />);
    expect(screen.getByText('Great beta!')).toBeTruthy();
  });

  describe('climb click handler', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      mockSetCurrentClimb.mockReset();
      mockRouterPush.mockReset();
      mockQueueActions = null;
      // Default to solo (no party session active) — preserves today's
      // "click a session climb → sets active + navigates" behavior. Tests
      // that exercise the party fork flip this on explicitly.
      mockSessionDataValue = { isPersistentSessionActive: false };
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ url: '/kilter/1/10/1/40/view/climb-1' }),
        }),
      ) as unknown as typeof fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('calls setCurrentClimb when clicking a climb with a queue context', async () => {
      mockQueueActions = { setCurrentClimb: mockSetCurrentClimb };
      render(<SessionDetailContent session={makeSession()} />);
      fireEvent.click(screen.getByTestId('climb-item'));
      await waitFor(() => expect(mockSetCurrentClimb).toHaveBeenCalledTimes(1));
      expect(mockSetCurrentClimb.mock.calls[0][0].uuid).toBe('climb-1');
    });

    it('navigates after setting current climb when not embedded', async () => {
      mockQueueActions = { setCurrentClimb: mockSetCurrentClimb };
      render(<SessionDetailContent session={makeSession()} />);
      fireEvent.click(screen.getByTestId('climb-item'));
      await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/kilter/1/10/1/40/view/climb-1'));
    });

    it('skips navigation in embedded mode but still sets current climb', async () => {
      mockQueueActions = { setCurrentClimb: mockSetCurrentClimb };
      render(<SessionDetailContent session={makeSession()} embedded />);
      fireEvent.click(screen.getByTestId('climb-item'));
      await waitFor(() => expect(mockSetCurrentClimb).toHaveBeenCalledTimes(1));
      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('still navigates when no queue context is available (legacy fallback)', async () => {
      mockQueueActions = null;
      render(<SessionDetailContent session={makeSession()} />);
      fireEvent.click(screen.getByTestId('climb-item'));
      await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/kilter/1/10/1/40/view/climb-1'));
      expect(mockSetCurrentClimb).not.toHaveBeenCalled();
    });

    it('skips navigation when setCurrentClimb rejects validation (returns null)', async () => {
      // setCurrentClimb resolves to null when validateClimbForQueue fires the
      // snackbar — the user shouldn't land on a climb page the board can't take.
      mockSetCurrentClimb.mockResolvedValueOnce(null);
      mockQueueActions = { setCurrentClimb: mockSetCurrentClimb };
      render(<SessionDetailContent session={makeSession()} />);
      fireEvent.click(screen.getByTestId('climb-item'));
      await waitFor(() => expect(mockSetCurrentClimb).toHaveBeenCalledTimes(1));
      // Wait for the click handler's awaited promise to actually resolve, then
      // drain one more microtask so the synchronous code following the await
      // (the `if (result === null) return` early-out) has run. Deterministic —
      // no real timers involved.
      await mockSetCurrentClimb.mock.results[0]!.value;
      await Promise.resolve();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it('does NOT call setCurrentClimb in a party session, but still navigates', async () => {
      // In an active party session, clicking a session climb shouldn't yank
      // the wall away from whoever's climbing. The user still navigates to
      // the climb's board page, where they can preview or explicitly send.
      mockSessionDataValue = { isPersistentSessionActive: true };
      mockQueueActions = { setCurrentClimb: mockSetCurrentClimb };
      render(<SessionDetailContent session={makeSession()} />);
      fireEvent.click(screen.getByTestId('climb-item'));
      await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/kilter/1/10/1/40/view/climb-1'));
      expect(mockSetCurrentClimb).not.toHaveBeenCalled();
    });
  });
});
