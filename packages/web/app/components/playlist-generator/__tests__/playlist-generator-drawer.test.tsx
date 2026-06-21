import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { BoardDetails } from '@/app/lib/types';
import PlaylistGeneratorDrawer from '../playlist-generator-drawer';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const trackMock = vi.fn();
vi.mock('@/app/lib/analytics', () => ({
  track: (...args: unknown[]) => trackMock(...args),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: null, isAuthenticated: false, isLoading: false, error: null }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  executeGraphQL: vi.fn(async () => ({ searchClimbs: { climbs: [], hasMore: false } })),
}));

// Minimal SwipeableDrawer mock — render children + extra slot when open so
// we can find the Generate button via role and trigger close via onClose.
vi.mock('../../swipeable-drawer/swipeable-drawer', () => ({
  default: ({
    children,
    extra,
    open,
    onClose,
  }: {
    children: React.ReactNode;
    extra?: React.ReactNode;
    open: boolean;
    onClose?: () => void;
  }) =>
    open ? (
      <div data-testid="drawer">
        {children}
        {extra}
        {onClose && (
          <button type="button" data-testid="drawer-close" onClick={onClose}>
            close-drawer
          </button>
        )}
      </div>
    ) : null,
}));

// Stub the options form — we don't drive its inputs in these tests.
vi.mock('../generator-options-form', () => ({
  __esModule: true,
  default: () => <div data-testid="options-form" />,
  getDefaultOptions: (workoutType: string, targetGrade: number) => ({
    type: workoutType,
    workoutType,
    targetGrade,
    warmUp: 'standard',
    minAscents: 5,
    minRating: 0,
    climbBias: 'any',
    mainSetClimbs: 1,
    mainSetVariability: 0,
    onlyTallClimbs: false,
    onlyWideClimbs: false,
  }),
}));

vi.mock('../grade-progression-chart', () => ({
  __esModule: true,
  default: () => <div data-testid="chart" />,
}));

vi.mock('../workout-type-selector', () => ({
  __esModule: true,
  default: ({ onSelect }: { onSelect: (type: 'volume' | 'pyramid' | 'ladder' | 'gradeFocus') => void }) => (
    <div data-testid="type-selector">
      <button type="button" onClick={() => onSelect('volume')}>
        pick-volume
      </button>
    </div>
  ),
}));

// generation-utils is real — its output is what drives the Generate button's
// enable/disable state. Stub the plan generator to a deterministic 2-slot run
// so tests don't depend on board-data tables.
vi.mock('../generation-utils', () => ({
  generateWorkoutPlan: () => [
    { grade: 18, section: 'main' as const, index: 0 },
    { grade: 18, section: 'main' as const, index: 1 },
  ],
  groupSlotsBySection: () => [
    {
      section: 'main',
      slots: [
        { grade: 18, section: 'main' as const, index: 0 },
        { grade: 18, section: 'main' as const, index: 1 },
      ],
    },
  ],
  getGradeName: () => '6b/V4',
}));

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 2],
} as unknown as BoardDetails;

function findCancelledCall() {
  return trackMock.mock.calls.find(([event]) => event === 'Workout Generator Cancelled');
}

describe('PlaylistGeneratorDrawer cancellation analytics', () => {
  beforeEach(() => {
    trackMock.mockClear();
  });

  it('fires Cancelled (stage=select, no workoutType) when dismissed from the type-select screen', async () => {
    render(
      <PlaylistGeneratorDrawer
        open
        onClose={vi.fn()}
        boardDetails={boardDetails}
        defaultAngle={40}
        onAddClimb={vi.fn(async () => {})}
        targetType="session"
      />,
    );

    // Drawer mounts in 'select' state and emits Opened. Close immediately.
    fireEvent.click(screen.getByTestId('drawer-close'));

    const call = findCancelledCall();
    expect(call).toBeDefined();
    const [, payload] = call!;
    expect(payload).toMatchObject({ targetType: 'session', stage: 'select' });
    // `workoutType` must be ABSENT (not null) so downstream dashboards
    // don't widen the property's type from WorkoutType to WorkoutType|null.
    expect(payload).not.toHaveProperty('workoutType');
  });

  it('fires Cancelled (stage=configure, workoutType=volume) when dismissed from the configure screen', async () => {
    render(
      <PlaylistGeneratorDrawer
        open
        onClose={vi.fn()}
        boardDetails={boardDetails}
        defaultAngle={40}
        onAddClimb={vi.fn(async () => {})}
        targetType="playlist"
      />,
    );

    // Pick a workout type — drawer transitions to 'configure'.
    fireEvent.click(screen.getByText('pick-volume'));

    // Dismiss.
    fireEvent.click(screen.getByTestId('drawer-close'));

    const call = findCancelledCall();
    expect(call).toBeDefined();
    const [, payload] = call!;
    expect(payload).toMatchObject({
      targetType: 'playlist',
      workoutType: 'volume',
      stage: 'configure',
    });
  });

  it('does NOT fire Cancelled after a generation run completes (even with 0 climbs saved)', async () => {
    render(
      <PlaylistGeneratorDrawer
        open
        onClose={vi.fn()}
        boardDetails={boardDetails}
        defaultAngle={40}
        onAddClimb={vi.fn(async () => {})}
        targetType="session"
      />,
    );

    // Pick a workout type → configure.
    fireEvent.click(screen.getByText('pick-volume'));

    // Click Generate (rendered via the SwipeableDrawer's `extra` slot).
    // executeGraphQL is mocked to return zero climbs, so the run will
    // complete with savedCount=0 — still a completed run, not a cancel.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    });

    await waitFor(() => {
      expect(trackMock.mock.calls.some(([event]) => event === 'Workout Generated')).toBe(true);
    });

    // No Cancelled event should ever fire on this path — neither during
    // handleGenerate's raw onClose, nor on any subsequent dismissal.
    expect(findCancelledCall()).toBeUndefined();
  });
});
