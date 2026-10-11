// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { LogbookEntry } from '@boardsesh/board-react';

const logbook = vi.hoisted(() => ({ entries: [] as LogbookEntry[] }));
vi.mock('@boardsesh/board-react', () => ({
  logbookClimbAngleKey: (climbUuid: string, angle: number) => `${climbUuid}:${angle}`,
  useOptionalBoardLogbook: () => ({ logbookByClimbAngle: new Map([['climb:40', logbook.entries]]) }),
}));

import { useClimbProgress } from '../use-climb-progress';

function tick(status: 'send' | 'attempt', climbRevision: number): LogbookEntry {
  return {
    uuid: `tick-${climbRevision}`,
    climb_uuid: 'climb',
    angle: 40,
    is_mirror: false,
    tries: 2,
    is_ascent: status === 'send',
    status,
    climbed_at: '2026-10-01T12:00:00',
    climb_revision: climbRevision,
  } as LogbookEntry;
}

describe('useClimbProgress current holds', () => {
  beforeEach(() => { logbook.entries = []; });

  it('omits progress when all ticks precede the current holds', () => {
    logbook.entries = [tick('send', 1)];
    expect(renderHook(() => useClimbProgress('climb', 40, 2)).result.current).toBeNull();
  });

  it('shows a current attempt instead of a send on old holds', () => {
    logbook.entries = [tick('send', 1), tick('attempt', 2)];
    expect(renderHook(() => useClimbProgress('climb', 40, 2)).result.current?.outcome).toEqual({ kind: 'attempt', tries: 2 });
  });

  it('recomputes when the holds revision changes without a new bucket', () => {
    logbook.entries = [tick('send', 1)];
    const { result, rerender } = renderHook(({ revision }) => useClimbProgress('climb', 40, revision), { initialProps: { revision: 1 } });
    expect(result.current?.outcome.kind).toBe('send');
    rerender({ revision: 2 });
    expect(result.current).toBeNull();
  });
});
