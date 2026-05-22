import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import AngleSelector from '../angle-selector';
import type { BoardDetails } from '@/app/lib/types';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

const mockPush = vi.fn();
let mockPathname = '/kilter/1/10/1,2/40/list';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: mockPush, replace: vi.fn() }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('@/app/hooks/use-is-dark-mode', () => ({
  useIsDarkMode: () => false,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
}));

const mockSetSessionBoardPath = vi.fn();
const mockActiveSession: { current: unknown | null } = { current: null };

vi.mock('../../persistent-session', () => ({
  usePersistentSession: () => ({
    activeSession: mockActiveSession.current,
    setSessionBoardPath: mockSetSessionBoardPath,
  }),
}));

vi.mock('../../swipeable-drawer/swipeable-drawer', () => ({
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="angle-drawer">{children}</div> : null,
}));

vi.mock('../../climb-card/drawer-climb-header', () => ({
  default: () => null,
}));

vi.mock('../angle-selector.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 2,
  set_ids: [1, 2],
  layout_name: 'Original',
  size_name: '12x12',
  size_description: 'Home',
  set_names: ['Bolt-On'],
} as unknown as BoardDetails;

describe('AngleSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/kilter/1/10/1,2/40/list';
    mockActiveSession.current = null;
    window.history.replaceState({}, '', '/');
  });

  it('replaces the angle segment in the URL when a new angle is picked', () => {
    render(<AngleSelector boardName="kilter" boardDetails={boardDetails} currentAngle={40} currentClimb={null} />);

    fireEvent.click(screen.getByRole('button', { name: /40/ }));
    fireEvent.click(screen.getByText('45°'));

    expect(mockPush).toHaveBeenCalledWith('/kilter/1/10/1,2/45/list');
  });

  it('preserves URL query string (live filter state) when changing angle', () => {
    // QueueContext writes filter state to the URL via history.replaceState,
    // which Next.js's useSearchParams() does not observe. The selector must
    // read window.location.search directly so filters aren't dropped.
    window.history.replaceState({}, '', '/kilter/1/10/1,2/40/list?minGrade=10&onlyClassics=true');

    render(<AngleSelector boardName="kilter" boardDetails={boardDetails} currentAngle={40} currentClimb={null} />);

    fireEvent.click(screen.getByRole('button', { name: /40/ }));
    fireEvent.click(screen.getByText('45°'));

    expect(mockPush).toHaveBeenCalledWith('/kilter/1/10/1,2/45/list?minGrade=10&onlyClassics=true');
  });

  it('delegates to onAngleChange prop and skips URL navigation when provided', () => {
    const onAngleChange = vi.fn();
    render(
      <AngleSelector
        boardName="kilter"
        boardDetails={boardDetails}
        currentAngle={40}
        currentClimb={null}
        onAngleChange={onAngleChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /40/ }));
    fireEvent.click(screen.getByText('45°'));

    expect(onAngleChange).toHaveBeenCalledWith(45);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does not navigate when isAngleAdjustable is false', () => {
    render(
      <AngleSelector
        boardName="kilter"
        boardDetails={boardDetails}
        currentAngle={40}
        currentClimb={null}
        isAngleAdjustable={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /40/ }));
    fireEvent.click(screen.getByText('45°'));

    expect(mockPush).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Session-shared angle broadcast — pins the A3 wiring on PR #2238.
  // ---------------------------------------------------------------------

  it('broadcasts the new boardPath via setSessionBoardPath when in party mode', () => {
    mockActiveSession.current = { sessionId: 'session-1', boardPath: '/kilter/1/10/1,2/40/list' };

    render(<AngleSelector boardName="kilter" boardDetails={boardDetails} currentAngle={40} currentClimb={null} />);

    fireEvent.click(screen.getByRole('button', { name: /40/ }));
    fireEvent.click(screen.getByText('45°'));

    expect(mockPush).toHaveBeenCalledWith('/kilter/1/10/1,2/45/list');
    expect(mockSetSessionBoardPath).toHaveBeenCalledWith('/kilter/1/10/1,2/45/list');
  });

  it('does not call setSessionBoardPath in solo mode (no active session)', () => {
    mockActiveSession.current = null;

    render(<AngleSelector boardName="kilter" boardDetails={boardDetails} currentAngle={40} currentClimb={null} />);

    fireEvent.click(screen.getByRole('button', { name: /40/ }));
    fireEvent.click(screen.getByText('45°'));

    expect(mockPush).toHaveBeenCalled();
    expect(mockSetSessionBoardPath).not.toHaveBeenCalled();
  });
});
