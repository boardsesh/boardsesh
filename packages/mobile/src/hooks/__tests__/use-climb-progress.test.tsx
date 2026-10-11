// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';
import { ClimbProgressContext } from '../../lib/climb-progress-context';
import { createClimbProgressStore } from '../../lib/climb-progress-store';
import { useClimbProgress } from '../use-climb-progress';

const tick = (overrides: Partial<LogbookEntry> = {}): LogbookEntry => ({
  uuid: 'tick1',
  climb_uuid: 'climb1',
  angle: 40,
  is_mirror: false,
  tries: 2,
  quality: null,
  difficulty: null,
  comment: '',
  climbed_at: '2026-10-10T12:00:00Z',
  is_ascent: true,
  status: 'send',
  upvotes: 0,
  downvotes: 0,
  commentCount: 0,
  ...overrides,
});

describe('useClimbProgress', () => {
  it('filters old holds before deriving counts, recency and both directions', () => {
    const store = createClimbProgressStore(0, () => 0);
    store.publish('kilter', [
      tick({ uuid: 'old', status: 'flash', climb_revision: 1 }),
      tick({ climb_revision: 2 }),
      tick({ uuid: 'mirror', status: 'attempt', is_ascent: false, tries: 4, is_mirror: true, climb_revision: 2 }),
    ]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClimbProgressContext.Provider value={store}>{children}</ClimbProgressContext.Provider>
    );
    const { result } = renderHook(() => useClimbProgress('kilter', 'climb1', 40, 2), { wrapper });
    expect(result.current).toMatchObject({
      status: 'send',
      outcome: { kind: 'send', sendCount: 1 },
      originalStatus: 'send',
      mirrorStatus: 'attempt',
    });
  });
  it('updates only the subscribed climb bucket', () => {
    const store = createClimbProgressStore(0, () => 0);
    const first = tick();
    const second = tick({ uuid: 'tick2', climb_uuid: 'climb2' });
    store.publish('kilter', [first, second]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClimbProgressContext.Provider value={store}>{children}</ClimbProgressContext.Provider>
    );
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useClimbProgress('kilter', 'climb1', 40);
      },
      { wrapper },
    );
    const previous = result.current;
    const before = renders;
    act(() => store.publish('kilter', [first, { ...second, tries: 3 }]));
    expect(renders).toBe(before);
    expect(result.current).toBe(previous);
    act(() => store.publish('kilter', [first, tick({ uuid: 'repeat' }), second]));
    expect(result.current?.outcome).toEqual({ kind: 'send', sendCount: 2 });
  });
  it('does not confuse board or angle and keeps the empty snapshot stable', () => {
    const store = createClimbProgressStore(0, () => 0);
    store.publish('tension', [tick()]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClimbProgressContext.Provider value={store}>{children}</ClimbProgressContext.Provider>
    );
    const { result } = renderHook(() => useClimbProgress('kilter', 'climb1', 40), { wrapper });
    expect(result.current).toBeNull();
  });
});
