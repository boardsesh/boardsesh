// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type Entry = {
  climb_uuid: string;
  angle: number;
  is_mirror: boolean;
  status: string;
  is_ascent: boolean;
  tries: number;
};

const ctrl = vi.hoisted(() => ({ board: null as { logbookByClimbAngle: Map<string, Entry[]> } | null }));

vi.mock('@boardsesh/board-react', () => ({
  useOptionalBoardLogbook: () => ctrl.board,
  logbookClimbAngleKey: (climbUuid: string, angle: number) => `${climbUuid}:${angle}`,
}));
// Stub the pure utils so the test exercises the hook's filtering/delegation, not
// the normalisation maths: the "normalised value" is just the entry's status,
// and "highest" is the first survivor.
vi.mock('../../lib/ascent-status-utils', () => ({
  normalizeAscentStatus: (entry: { status: string }) => entry.status,
  pickHighestAscentStatus: (values: string[]) => values[0] ?? null,
}));

import { useAscentStatus } from '../use-ascent-status';

const entry = (over: Partial<Entry>): Entry => ({
  climb_uuid: 'a',
  angle: 40,
  is_mirror: false,
  status: 'sent',
  is_ascent: true,
  tries: 1,
  ...over,
});

// Mirrors BoardProvider's `logbookByClimbAngle` index so the hook reads the same
// O(1) shape it does in production (keyed by `${climb_uuid}:${angle}`).
const boardFrom = (entries: Entry[]): { logbookByClimbAngle: Map<string, Entry[]> } => {
  const index = new Map<string, Entry[]>();
  for (const tick of entries) {
    const key = `${tick.climb_uuid}:${tick.angle}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(tick);
    else index.set(key, [tick]);
  }
  return { logbookByClimbAngle: index };
};

describe('useAscentStatus', () => {
  beforeEach(() => {
    ctrl.board = null;
  });

  it('returns null outside a BoardProvider', () => {
    expect(renderHook(() => useAscentStatus('a', 40)).result.current).toBeNull();
  });

  it('returns null when no ticks match the climb + angle', () => {
    ctrl.board = boardFrom([entry({ climb_uuid: 'b' }), entry({ angle: 30 })]);
    expect(renderHook(() => useAscentStatus('a', 40)).result.current).toBeNull();
  });

  it('returns the status for a matching climb + angle', () => {
    ctrl.board = boardFrom([entry({ status: 'flashed' })]);
    expect(renderHook(() => useAscentStatus('a', 40)).result.current).toBe('flashed');
  });

  it.each(['flash', 'send', 'attempt'] as const)('returns a %s entry at the current angle', (status) => {
    ctrl.board = boardFrom([entry({ status })]);
    expect(renderHook(() => useAscentStatus('a', 40)).result.current).toBe(status);
  });

  it('uses the O(1) climb-angle bucket again when the displayed climb or angle changes', () => {
    ctrl.board = boardFrom([
      entry({ climb_uuid: 'a', angle: 40, status: 'flash' }),
      entry({ climb_uuid: 'a', angle: 30, status: 'attempt' }),
      entry({ climb_uuid: 'b', angle: 30, status: 'send' }),
    ]);
    const { result, rerender } = renderHook(
      ({ climbUuid, angle }: { climbUuid: string; angle: number }) => useAscentStatus(climbUuid, angle),
      {
        initialProps: { climbUuid: 'a', angle: 40 },
      },
    );
    expect(result.current).toBe('flash');

    rerender({ climbUuid: 'a', angle: 30 });
    expect(result.current).toBe('attempt');

    rerender({ climbUuid: 'b', angle: 30 });
    expect(result.current).toBe('send');
  });

  it('filters by mirror when isMirror is provided', () => {
    ctrl.board = boardFrom([
      entry({ is_mirror: true, status: 'mirror-send' }),
      entry({ is_mirror: false, status: 'send' }),
    ]);
    expect(renderHook(() => useAscentStatus('a', 40, true)).result.current).toBe('mirror-send');
    expect(renderHook(() => useAscentStatus('a', 40, false)).result.current).toBe('send');
  });
});
