import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SeshSettingsDrawer from '../sesh-settings-drawer';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

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
const mockDeactivateSession = vi.fn();
let mockAngle: number | undefined = 40;
let mockBoardDetails: Record<string, unknown> | null = { board_name: 'kilter' };
let mockSessionDetail: Record<string, unknown> | null = {
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
    deactivateSession: mockDeactivateSession,
  }),
  usePersistentSessionState: () => ({
    activeSession: mockActiveSession,
    session: mockSession,
    users: [],
  }),
  usePersistentSessionActions: () => ({
    deactivateSession: mockDeactivateSession,
  }),
}));

vi.mock('@/app/components/queue-control/queue-bridge-context', () => ({
  useQueueBridgeBoardInfo: () => ({
    boardDetails: mockBoardDetails,
    angle: mockAngle,
  }),
}));

const mockClearClimbSessionCookie = vi.fn();
vi.mock('@/app/lib/climb-session-cookie', () => ({
  clearClimbSessionCookie: (...args: unknown[]) => mockClearClimbSessionCookie(...args),
}));

vi.mock('@/app/hooks/use-session-detail', () => ({
  useSessionDetail: () => ({
    session: mockSessionDetail,
    isLoading: false,
    isError: false,
    updateSession: { mutateAsync: vi.fn(), isPending: false },
    addUser: { mutateAsync: vi.fn(), isPending: false },
    removeUser: { mutateAsync: vi.fn(), isPending: false },
  }),
  SESSION_DETAIL_QUERY_KEY: (id: string) => ['sessionDetail', id],
}));

vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: ({
    open,
    children,
    title,
    placement,
  }: {
    open: boolean;
    children: React.ReactNode;
    title: React.ReactNode;
    placement: string;
  }) =>
    open ? (
      <div data-testid="swipeable-drawer" data-placement={placement}>
        <div data-testid="drawer-title">{title}</div>
        {children}
      </div>
    ) : null,
}));

vi.mock('@/app/components/swipeable-drawer/swipeable-drawer.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

vi.mock('@/app/hooks/use-drawer-drag-resize', () => ({
  useDrawerDragResize: () => ({ paperRef: { current: null }, dragHandlers: {} }),
}));

vi.mock('@/app/components/board-renderer/board-renderer', () => ({
  default: () => <div data-testid="board-renderer" />,
}));

vi.mock('@/app/hooks/use-session-timer', () => ({
  useSessionTimer: () => null,
}));

vi.mock('@/app/lib/share-utils', () => ({
  shareWithFallback: vi.fn(),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/lib/session-utils', () => ({
  generateSessionName: () => 'Session overview',
}));

// Stub the shared-playlist toggle — these tests don't exercise it, and
// rendering the real component would pull in useWsAuthToken/useSession,
// which requires a SessionProvider these tests don't wire up.
vi.mock('../shared-playlist-toggle', () => ({
  default: () => null,
}));

vi.mock('qrcode.react', () => ({
  QRCodeSVG: () => null,
}));

vi.mock('@/app/components/board-page/angle-selector', () => ({
  default: () => null,
}));

vi.mock('@/app/session/[sessionId]/session-detail-content', () => ({
  default: ({
    onAngleChange,
    currentAngle,
  }: {
    onAngleChange?: (angle: number) => void;
    currentAngle?: number;
    session?: unknown;
    embedded?: boolean;
    fallbackBoardDetails?: unknown;
    inviteContent?: React.ReactNode;
    namedBoardName?: string;
  }) => (
    <div data-testid="session-detail-content">
      {onAngleChange && currentAngle != null && (
        <div data-testid="angle-controls">
          <span>Current: {currentAngle}</span>
          <button data-testid="change-angle-45" onClick={() => onAngleChange(45)}>
            Set 45
          </button>
          <button data-testid="change-angle-20" onClick={() => onAngleChange(20)}>
            Set 20
          </button>
        </div>
      )}
    </div>
  ),
}));

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
    };
  });

  it('renders nothing when activeSession is null', () => {
    mockActiveSession = null;
    const { container } = render(<SeshSettingsDrawer open onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders drawer title with session name', () => {
    render(<SeshSettingsDrawer open onClose={vi.fn()} />);
    // The title is rendered as JSX containing the session name from session.name
    expect(screen.getByTestId('drawer-title')).toBeTruthy();
    expect(screen.getByText('Morning Sesh')).toBeTruthy();
  });

  it('renders session detail content', () => {
    render(<SeshSettingsDrawer open onClose={vi.fn()} />);
    expect(screen.getByTestId('session-detail-content')).toBeTruthy();
  });

  it('opens as a bottom drawer', () => {
    render(<SeshSettingsDrawer open onClose={vi.fn()} />);
    expect(screen.getByTestId('swipeable-drawer').getAttribute('data-placement')).toBe('bottom');
  });

  it('shows angle controls when boardDetails and angle exist', () => {
    render(<SeshSettingsDrawer open onClose={vi.fn()} />);
    expect(screen.getByTestId('angle-controls')).toBeTruthy();
  });

  it('does not navigate when angle change is clicked but boardDetails is null', () => {
    mockBoardDetails = null;
    render(<SeshSettingsDrawer open onClose={vi.fn()} />);
    // When boardDetails is null, the handleAngleChange callback returns early
    fireEvent.click(screen.getByTestId('change-angle-45'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  describe('handleAngleChange', () => {
    it('replaces angle in long-form route preserving trailing segments', () => {
      mockPathname = '/kilter/1/10/1,2/40/list';
      mockAngle = 40;
      render(<SeshSettingsDrawer open onClose={vi.fn()} />);

      fireEvent.click(screen.getByTestId('change-angle-45'));
      expect(mockPush).toHaveBeenCalledWith('/kilter/1/10/1,2/45/list');
    });

    it('replaces angle in slug-based route preserving trailing segments', () => {
      mockPathname = '/b/my-board/40/play/some-uuid';
      mockAngle = 40;
      render(<SeshSettingsDrawer open onClose={vi.fn()} />);

      fireEvent.click(screen.getByTestId('change-angle-45'));
      expect(mockPush).toHaveBeenCalledWith('/b/my-board/45/play/some-uuid');
    });

    it('replaces angle in slug-based route with /list suffix', () => {
      mockPathname = '/b/my-board/40/list';
      mockAngle = 40;
      render(<SeshSettingsDrawer open onClose={vi.fn()} />);

      fireEvent.click(screen.getByTestId('change-angle-20'));
      expect(mockPush).toHaveBeenCalledWith('/b/my-board/20/list');
    });

    it('does not navigate when angle is undefined', () => {
      mockAngle = undefined;
      render(<SeshSettingsDrawer open onClose={vi.fn()} />);
      // Angle controls are hidden when angle is undefined, so no button to click
      expect(screen.queryByTestId('angle-controls')).toBeNull();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('preserves URL query string (live filter state) when changing angle', () => {
      mockPathname = '/kilter/1/10/1,2/40/list';
      mockAngle = 40;
      // Mirrors what QueueContext does via history.replaceState when the user
      // edits filters — the Next.js router never sees this, but
      // window.location.search reflects it.
      window.history.replaceState({}, '', '/kilter/1/10/1,2/40/list?minGrade=10&onlyClassics=true');
      try {
        render(<SeshSettingsDrawer open onClose={vi.fn()} />);
        fireEvent.click(screen.getByTestId('change-angle-45'));
        expect(mockPush).toHaveBeenCalledWith('/kilter/1/10/1,2/45/list?minGrade=10&onlyClassics=true');
      } finally {
        window.history.replaceState({}, '', '/');
      }
    });
  });

  describe('handleStopSession', () => {
    it('calls deactivateSession, clears cookie, but does not close the drawer', () => {
      const onClose = vi.fn();
      render(<SeshSettingsDrawer open onClose={onClose} />);

      fireEvent.click(screen.getByLabelText('Stop session'));
      expect(mockDeactivateSession).toHaveBeenCalled();
      expect(mockClearClimbSessionCookie).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('shows Dismiss button after stopping session', () => {
      render(<SeshSettingsDrawer open onClose={vi.fn()} />);

      fireEvent.click(screen.getByLabelText('Stop session'));
      expect(screen.getByLabelText('Dismiss')).toBeTruthy();
      expect(screen.queryByLabelText('Stop session')).toBeNull();
    });

    it('calls onClose when Dismiss is clicked', () => {
      const onClose = vi.fn();
      render(<SeshSettingsDrawer open onClose={onClose} />);

      fireEvent.click(screen.getByLabelText('Stop session'));
      fireEvent.click(screen.getByLabelText('Dismiss'));
      expect(onClose).toHaveBeenCalled();
    });
  });
});
