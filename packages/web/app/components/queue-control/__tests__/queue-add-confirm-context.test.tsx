import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import {
  QueueAddConfirmProvider,
  useQueueAddConfirm,
  type AddOutcome,
} from '../queue-add-confirm-context';
import type { BoardConfig } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: [1, 2],
    angle: 40,
    ...overrides,
  };
}

function makeQueueItem(cfg: BoardConfig, uuid = 'u1'): ClimbQueueItem {
  return {
    uuid,
    addedBy: null,
    suggested: false,
    boardConfig: cfg,
    climb: {
      uuid: `climb-${uuid}`,
      setter_username: 'x',
      name: 'x',
      description: '',
      frames: '',
      angle: cfg.angle,
      ascensionist_count: 0,
      difficulty: '6A',
      quality_average: '3',
      stars: 3,
      difficulty_error: '',
      mirrored: false,
      benchmark_difficulty: null,
    },
  };
}

/**
 * Small harness exposing the confirm API and a last-outcome slot, so tests
 * can drive `gate()` imperatively.
 */
function Harness({ onReady }: { onReady: (api: NonNullable<ReturnType<typeof useQueueAddConfirm>>) => void }) {
  const api = useQueueAddConfirm();
  React.useEffect(() => {
    if (api) onReady(api);
  }, [api, onReady]);
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueueAddConfirmProvider', () => {
  let api: NonNullable<ReturnType<typeof useQueueAddConfirm>>;

  beforeEach(() => {
    render(
      <QueueAddConfirmProvider>
        <Harness onReady={(a) => { api = a; }} />
      </QueueAddConfirmProvider>,
    );
  });

  it('gate returns "allow" immediately when the queue is empty (no dialog)', async () => {
    const outcome = await api.gate(makeConfig(), []);
    expect(outcome).toBe<AddOutcome>('allow');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gate returns "allow" when the incoming config matches an accepted key with equal size', async () => {
    const queue = [makeQueueItem(makeConfig({ sizeId: 10 }))];
    const outcome = await api.gate(makeConfig({ sizeId: 10 }), queue);
    expect(outcome).toBe<AddOutcome>('allow');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gate returns "allow" when the incoming size is smaller than any accepted size', async () => {
    const queue = [makeQueueItem(makeConfig({ sizeId: 20 }))];
    const outcome = await api.gate(makeConfig({ sizeId: 10 }), queue);
    expect(outcome).toBe<AddOutcome>('allow');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the dialog for new_config and resolves with the user choice (add)', async () => {
    const queue = [makeQueueItem(makeConfig({ boardName: 'kilter' }))];
    let outcome: AddOutcome | undefined;
    await act(async () => {
      void api.gate(makeConfig({ boardName: 'tension' }), queue).then((o) => { outcome = o; });
    });
    expect(screen.getByText('This climb is on a different board')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add to current queue/i }));
    });
    expect(outcome).toBe<AddOutcome>('add');
    // MUI Dialog renders with `open=false` but unmounts only after its fade-out
    // transition. We assert the outcome resolved; the DOM teardown is MUI's
    // internal concern and not worth racing against fake timers here.
  });

  it('opens the dialog for new_config and resolves with "switch"', async () => {
    const queue = [makeQueueItem(makeConfig({ boardName: 'kilter' }))];
    let outcome: AddOutcome | undefined;
    await act(async () => {
      void api.gate(makeConfig({ boardName: 'tension' }), queue).then((o) => { outcome = o; });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Switch to that board/i }));
    });
    expect(outcome).toBe<AddOutcome>('switch');
  });

  it('opens the dialog for new_config and resolves with "cancel"', async () => {
    const queue = [makeQueueItem(makeConfig({ boardName: 'kilter' }))];
    let outcome: AddOutcome | undefined;
    await act(async () => {
      void api.gate(makeConfig({ boardName: 'tension' }), queue).then((o) => { outcome = o; });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(outcome).toBe<AddOutcome>('cancel');
  });

  it('opens the dialog for larger_size when incoming sizeId is larger than any accepted size', async () => {
    const queue = [makeQueueItem(makeConfig({ sizeId: 10 }))];
    let outcome: AddOutcome | undefined;
    await act(async () => {
      void api.gate(makeConfig({ sizeId: 99 }), queue).then((o) => { outcome = o; });
    });
    expect(screen.getByText('This climb is for a bigger board size')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add to current queue/i }));
    });
    expect(outcome).toBe<AddOutcome>('add');
  });

  it('serializes back-to-back gate() calls — only one dialog at a time, answered in order', async () => {
    const queue = [makeQueueItem(makeConfig({ boardName: 'kilter' }))];

    let outcome1: AddOutcome | undefined;
    let outcome2: AddOutcome | undefined;

    // First call: the provider has no active request yet, so this opens the
    // dialog and activeRequest becomes non-null.
    await act(async () => {
      void api.gate(makeConfig({ boardName: 'tension' }), queue).then((o) => { outcome1 = o; });
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText(/from Tension/i)).toBeTruthy();

    // Second call while the first dialog is still showing — must enqueue,
    // NOT open a second dialog.
    await act(async () => {
      void api.gate(makeConfig({ boardName: 'moonboard' }), queue).then((o) => { outcome2 = o; });
    });
    // Still only one dialog, still showing the first request (tension).
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText(/from Tension/i)).toBeTruthy();

    // Answer the first — the second then dequeues and replaces it.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add to current queue/i }));
    });
    expect(outcome1).toBe<AddOutcome>('add');

    // Second dialog now visible (still just one), body now reflects moonboard.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText(/from Moonboard/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Switch to that board/i }));
    });
    expect(outcome2).toBe<AddOutcome>('switch');
  });
});

describe('useQueueAddConfirm outside the provider', () => {
  it('returns null when no QueueAddConfirmProvider is mounted (no crash)', () => {
    const { result } = renderHook(() => useQueueAddConfirm());
    expect(result.current).toBeNull();
  });
});
