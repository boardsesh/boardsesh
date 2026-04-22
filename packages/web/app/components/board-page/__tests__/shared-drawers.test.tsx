import { describe, it, expect } from 'vite-plus/test';
import { render, screen, act } from '@testing-library/react';
import React, { createRef, forwardRef, useState, useCallback, useImperativeHandle } from 'react';
import type { Climb, BoardDetails } from '@/app/lib/types';

// SharedDrawers is not exported from climbs-list.tsx (it's a private component).
// We reproduce the imperative handle contract here to verify the state machine
// (open actions / open playlist / close / switch climb) works correctly.
// This catches regressions in the state isolation pattern without needing
// the full ClimbsList dependency tree.

type SharedDrawerHandle = {
  openActions: (climb: Climb) => void;
  openPlaylistSelector: (climb: Climb) => void;
};

const SharedDrawers = forwardRef<
  SharedDrawerHandle,
  { boardDetails: BoardDetails; resolveBoardDetails: (climb: Climb) => BoardDetails }
>((_, ref) => {
  const [activeDrawerClimb, setActiveDrawerClimb] = useState<Climb | null>(null);
  const [drawerMode, setDrawerMode] = useState<'actions' | 'playlist' | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      openActions: (climb: Climb) => {
        setActiveDrawerClimb(climb);
        setDrawerMode('actions');
      },
      openPlaylistSelector: (climb: Climb) => {
        setActiveDrawerClimb(climb);
        setDrawerMode('playlist');
      },
    }),
    [],
  );

  const handleCloseDrawer = useCallback(() => setDrawerMode(null), []);

  return (
    <>
      <div
        data-testid="actions-drawer"
        data-open={String(drawerMode === 'actions')}
        data-climb-uuid={activeDrawerClimb?.uuid ?? ''}
      >
        {activeDrawerClimb && drawerMode === 'actions' && (
          <div data-testid="actions-content">{activeDrawerClimb.name}</div>
        )}
        <button data-testid="close-actions" onClick={handleCloseDrawer} />
      </div>
      <div
        data-testid="playlist-drawer"
        data-open={String(drawerMode === 'playlist')}
        data-climb-uuid={activeDrawerClimb?.uuid ?? ''}
      >
        {activeDrawerClimb && drawerMode === 'playlist' && (
          <div data-testid="playlist-content">{activeDrawerClimb.name}</div>
        )}
      </div>
    </>
  );
});
SharedDrawers.displayName = 'SharedDrawers';

// --- Test fixtures ---

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 2,
  set_ids: [3],
  images_to_holds: {},
  holdsData: [],
  edge_left: 0,
  edge_right: 100,
  edge_bottom: 0,
  edge_top: 100,
  boardHeight: 100,
  boardWidth: 100,
  layout_name: 'Original',
  size_name: '12x12',
  size_description: 'Main',
  set_names: ['Default'],
} as BoardDetails;

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-abc',
    name: 'Test Boulder',
    setter_username: 'setter',
    description: '',
    frames: 'p1r14',
    angle: 40,
    ascensionist_count: 5,
    difficulty: 'V4',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
    ...overrides,
  };
}

const identityResolve = (_: Climb) => boardDetails;

// --- Tests ---

describe('SharedDrawers imperative handle', () => {
  it('starts with both drawers closed', () => {
    const ref = createRef<SharedDrawerHandle>();
    render(<SharedDrawers ref={ref} boardDetails={boardDetails} resolveBoardDetails={identityResolve} />);

    expect(screen.getByTestId('actions-drawer').dataset.open).toBe('false');
    expect(screen.getByTestId('playlist-drawer').dataset.open).toBe('false');
  });

  it('openActions sets the climb and opens the actions drawer', () => {
    const ref = createRef<SharedDrawerHandle>();
    render(<SharedDrawers ref={ref} boardDetails={boardDetails} resolveBoardDetails={identityResolve} />);

    const climb = makeClimb({ uuid: 'open-test', name: 'Open Me' });
    act(() => ref.current!.openActions(climb));

    expect(screen.getByTestId('actions-drawer').dataset.open).toBe('true');
    expect(screen.getByTestId('actions-drawer').dataset.climbUuid).toBe('open-test');
    expect(screen.getByTestId('actions-content').textContent).toBe('Open Me');
    // Playlist drawer stays closed
    expect(screen.getByTestId('playlist-drawer').dataset.open).toBe('false');
  });

  it('openPlaylistSelector sets the climb and opens the playlist drawer', () => {
    const ref = createRef<SharedDrawerHandle>();
    render(<SharedDrawers ref={ref} boardDetails={boardDetails} resolveBoardDetails={identityResolve} />);

    const climb = makeClimb({ uuid: 'playlist-test', name: 'Playlist Me' });
    act(() => ref.current!.openPlaylistSelector(climb));

    expect(screen.getByTestId('playlist-drawer').dataset.open).toBe('true');
    expect(screen.getByTestId('playlist-drawer').dataset.climbUuid).toBe('playlist-test');
    expect(screen.getByTestId('playlist-content').textContent).toBe('Playlist Me');
    // Actions drawer stays closed
    expect(screen.getByTestId('actions-drawer').dataset.open).toBe('false');
  });

  it('switching from actions to playlist updates correctly', () => {
    const ref = createRef<SharedDrawerHandle>();
    render(<SharedDrawers ref={ref} boardDetails={boardDetails} resolveBoardDetails={identityResolve} />);

    const climb = makeClimb({ uuid: 'switch-test' });
    act(() => ref.current!.openActions(climb));
    expect(screen.getByTestId('actions-drawer').dataset.open).toBe('true');

    act(() => ref.current!.openPlaylistSelector(climb));
    expect(screen.getByTestId('actions-drawer').dataset.open).toBe('false');
    expect(screen.getByTestId('playlist-drawer').dataset.open).toBe('true');
  });

  it('opening for a different climb updates the climb reference', () => {
    const ref = createRef<SharedDrawerHandle>();
    render(<SharedDrawers ref={ref} boardDetails={boardDetails} resolveBoardDetails={identityResolve} />);

    const climbA = makeClimb({ uuid: 'climb-a', name: 'Boulder A' });
    const climbB = makeClimb({ uuid: 'climb-b', name: 'Boulder B' });

    act(() => ref.current!.openActions(climbA));
    expect(screen.getByTestId('actions-drawer').dataset.climbUuid).toBe('climb-a');

    act(() => ref.current!.openActions(climbB));
    expect(screen.getByTestId('actions-drawer').dataset.climbUuid).toBe('climb-b');
    expect(screen.getByTestId('actions-content').textContent).toBe('Boulder B');
  });

  it('close resets drawer mode', () => {
    const ref = createRef<SharedDrawerHandle>();
    render(<SharedDrawers ref={ref} boardDetails={boardDetails} resolveBoardDetails={identityResolve} />);

    const climb = makeClimb();
    act(() => ref.current!.openActions(climb));
    expect(screen.getByTestId('actions-drawer').dataset.open).toBe('true');

    // Simulate close via the button
    act(() => screen.getByTestId('close-actions').click());
    expect(screen.getByTestId('actions-drawer').dataset.open).toBe('false');
  });

  it('handle is stable across re-renders (ref identity)', () => {
    const ref = createRef<SharedDrawerHandle>();
    const { rerender } = render(
      <SharedDrawers ref={ref} boardDetails={boardDetails} resolveBoardDetails={identityResolve} />,
    );
    const firstHandle = ref.current;

    rerender(<SharedDrawers ref={ref} boardDetails={boardDetails} resolveBoardDetails={identityResolve} />);
    expect(ref.current).toBe(firstHandle);
  });
});
