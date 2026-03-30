import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

const mockPush = vi.fn();
const mockReplace = vi.fn();
let mockPathname = '/kilter/1/10/1,2/40/list';
let mockActiveSession: Record<string, unknown> | null = {
  sessionId: 'session-123',
  boardPath: '/kilter/1/10/1,2/40/list',
  sessionName: 'Test Session',
};
let mockSession: Record<string, unknown> | null = {
  name: 'Morning Sesh',
  goal: 'Send V5',
  startedAt: new Date(Date.now() - 30 * 60000).toISOString(),
};
const mockEndSessionWithSummary = vi.fn();
let mockAngle: number | undefined = 40;
let mockBoardDetails: Record<string, unknown> | null = { board_name: 'kilter' };
let mockSessionDetail: Record<string, unknown> | null = {
  sessionDetail: {
    sessionId: 'session-123',
    sessionType: 'party',
    sessionName: 'Morning Sesh',
    participants: [],
    totalSends: 0,
    totalFlashes: 0,
    totalAttempts: 0,
    tickCount: 0,
    gradeDistribution: [],
    boardTypes: [],
    hardestGrade: null,
    durationMinutes: 30,
    goal: 'Send V5',
    ticks: [],
    upvotes: 0,
    downvotes: 0,
    voteScore: 0,
    commentCount: 0,
    firstTickAt: new Date().toISOString(),
    lastTickAt: new Date().toISOString(),
  },
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  usePathname: () => mockPathname,
}));

vi.mock('@/app/components/persistent-session/persistent-session-context', () => ({
  usePersistentSession: () => ({
    activeSession: mockActiveSession,
    session: mockSession,
    users: [],
    endSessionWithSummary: mockEndSessionWithSummary,
    liveSessionStats: null,
  }),
}));

vi.mock('@/app/components/queue-control/queue-bridge-context', () => ({
  useQueueBridgeBoardInfo: () => ({
    boardDetails: mockBoardDetails,
    angle: mockAngle,
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: null }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: mockSessionDetail,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: ({
    open,
    children,
    title,
    placement,
    footer,
  }: {
    open: boolean;
    children: React.ReactNode;
    title: string;
    placement: string;
    footer: React.ReactNode;
  }) =>
    open ? (
      <div data-testid="swipeable-drawer" data-title={title} data-placement={placement}>
        {children}
        {footer}
      </div>
    ) : null,
}));

vi.mock('@/app/components/board-page/angle-selector', () => ({
  default: ({ onAngleChange, currentAngle }: { onAngleChange: (angle: number) => void; currentAngle: number }) => (
    <div data-testid="angle-selector">
      <span>Current: {currentAngle}</span>
      <button data-testid="change-angle-45" onClick={() => onAngleChange(45)}>Set 45</button>
      <button data-testid="change-angle-20" onClick={() => onAngleChange(20)}>Set 20</button>
    </div>
  ),
}));

vi.mock('@/app/session/[sessionId]/session-detail-content', () => ({
  default: () => <div data-testid="session-detail-content" />,
}));

import SeshSettingsDrawer from '../sesh-settings-drawer';

describe('SeshSettingsDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/kilter/1/10/1,2/40/list';
    mockActiveSession = {
      sessionId: 'session-123',
      boardPath: '/kilter/1/10/1,2/40/list',
      sessionName: 'Test Session',
    };
    mockSession = {
      name: 'Morning Sesh',
      goal: 'Send V5',
      startedAt: new Date(Date.now() - 30 * 60000).toISOString(),
    };
    mockAngle = 40;
    mockBoardDetails = { board_name: 'kilter' };
    mockSessionDetail = {
      sessionDetail: {
        sessionId: 'session-123',
        sessionType: 'party',
        sessionName: 'Morning Sesh',
        participants: [],
        totalSends: 0,
        totalFlashes: 0,
        totalAttempts: 0,
        tickCount: 0,
        gradeDistribution: [],
        boardTypes: [],
        hardestGrade: null,
        durationMinutes: 30,
        goal: 'Send V5',
        ticks: [],
        upvotes: 0,
        downvotes: 0,
        voteScore: 0,
        commentCount: 0,
        firstTickAt: new Date().toISOString(),
        lastTickAt: new Date().toISOString(),
      },
    };
  });

  it('renders nothing when activeSession is null', () => {
    mockActiveSession = null;
    const { container } = render(
      <SeshSettingsDrawer open={true} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders drawer title', () => {
    render(<SeshSettingsDrawer open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId('swipeable-drawer').getAttribute('data-title')).toBe('Session Overview');
  });

  it('renders session detail content', () => {
    render(<SeshSettingsDrawer open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId('session-detail-content')).toBeTruthy();
  });

  it('opens as a top drawer', () => {
    render(<SeshSettingsDrawer open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId('swipeable-drawer').getAttribute('data-placement')).toBe('top');
  });

  it('shows angle selector when boardDetails and angle exist', () => {
    render(<SeshSettingsDrawer open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId('angle-selector')).toBeTruthy();
  });

  it('hides angle selector when boardDetails is null', () => {
    mockBoardDetails = null;
    render(<SeshSettingsDrawer open={true} onClose={vi.fn()} />);
    expect(screen.queryByTestId('angle-selector')).toBeNull();
  });

  describe('handleAngleChange', () => {
    it('replaces angle in long-form route preserving trailing segments', () => {
      mockPathname = '/kilter/1/10/1,2/40/list';
      mockAngle = 40;
      render(<SeshSettingsDrawer open={true} onClose={vi.fn()} />);

      fireEvent.click(screen.getByTestId('change-angle-45'));
      expect(mockPush).toHaveBeenCalledWith('/kilter/1/10/1,2/45/list');
    });

    it('replaces angle in slug-based route preserving trailing segments', () => {
      mockPathname = '/b/my-board/40/play/some-uuid';
      mockAngle = 40;
      render(<SeshSettingsDrawer open={true} onClose={vi.fn()} />);

      fireEvent.click(screen.getByTestId('change-angle-45'));
      expect(mockPush).toHaveBeenCalledWith('/b/my-board/45/play/some-uuid');
    });

    it('replaces angle in slug-based route with /list suffix', () => {
      mockPathname = '/b/my-board/40/list';
      mockAngle = 40;
      render(<SeshSettingsDrawer open={true} onClose={vi.fn()} />);

      fireEvent.click(screen.getByTestId('change-angle-20'));
      expect(mockPush).toHaveBeenCalledWith('/b/my-board/20/list');
    });

    it('does not navigate when angle is undefined', () => {
      mockAngle = undefined;
      render(<SeshSettingsDrawer open={true} onClose={vi.fn()} />);
      // Angle selector is hidden when angle is undefined, so no button to click
      expect(screen.queryByTestId('angle-selector')).toBeNull();
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe('handleStopSession', () => {
    it('calls endSessionWithSummary and onClose', () => {
      const onClose = vi.fn();
      render(<SeshSettingsDrawer open={true} onClose={onClose} />);

      fireEvent.click(screen.getByText('Stop Session'));
      expect(mockEndSessionWithSummary).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });
});
