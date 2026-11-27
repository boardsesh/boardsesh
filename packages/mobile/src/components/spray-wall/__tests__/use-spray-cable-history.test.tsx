// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TNUT_CORNERS, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import { useSprayCableHistory } from '../use-spray-cable-history';

const initial: TnutLayout = {
  version: 1,
  photoKey: 'photo',
  pattern: 'grid',
  rows: 2,
  columns: 2,
  firstRowOffset: false,
  corners: DEFAULT_TNUT_CORNERS,
  holes: [],
  ledPositions: [
    { id: 'a', x: 0.2, y: 0.2 },
    { id: 'b', x: 0.8, y: 0.2 },
    { id: 'c', x: 0.8, y: 0.8 },
  ],
  wiring: { direction: 'custom', startCorner: 'tl', paths: [], skips: [], initialSkip: 0 },
};

function editor(layout = initial) {
  return renderHook(() => {
    const [current, setLayout] = useState(layout);
    const history = useSprayCableHistory(current, (update) => setLayout((previous) => ({ ...previous, ...update })));
    return { layout: current, setLayout, ...history };
  });
}

describe('cable history across other setup edits', () => {
  it('restores only the cable, preserving later hold links and moved LED coordinates', () => {
    const { result } = editor();
    act(() => result.current.change({ ...initial.wiring!, paths: [['a']] }));
    act(() =>
      result.current.setLayout((layout) => ({
        ...layout,
        holdLeds: [{ holdId: 7, ledIds: ['a'] }],
        ledPositions: layout.ledPositions!.map((led) => (led.id === 'a' ? { ...led, x: 0.3 } : led)),
      })),
    );
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.layout.wiring?.paths).toEqual([]);
    expect(result.current.layout.holdLeds).toEqual([{ holdId: 7, ledIds: ['a'] }]);
    expect(result.current.layout.ledPositions?.[0].x).toBe(0.3);
  });

  it('cannot restore half of a newly paired unit from an earlier cable snapshot', () => {
    const { result } = editor();
    act(() => result.current.change({ ...initial.wiring!, paths: [['a']] }));
    act(() => result.current.change({ ...initial.wiring!, paths: [['a', 'b']] }));
    act(() => result.current.change(result.current.layout.wiring!, 1));
    act(() => result.current.setLayout((layout) => ({ ...layout, ledGroups: [['a', 'b']] })));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.pendingSkip).toBe(0);
    act(() => result.current.undo());
    expect(result.current.layout.wiring?.paths).toEqual([['a', 'b']]);
  });

  it('starts new history when a different cable is generated, including its first position', () => {
    const { result } = editor();
    act(() => result.current.change({ ...initial.wiring!, paths: [['a']] }));
    const regenerated = { ...initial.wiring!, direction: 'horizontal' as const, paths: [['c', 'b', 'a']] };
    act(() => result.current.setLayout((layout) => ({ ...layout, wiring: regenerated })));
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.undo());
    expect(result.current.layout.wiring).toBe(regenerated);
  });

  it('keeps cable Undo through an unconfirmed placement change and its reversal', () => {
    const { result } = editor();
    act(() => result.current.change({ ...initial.wiring!, paths: [['a']] }));
    act(() => result.current.setLayout((layout) => ({ ...layout, ledPlacement: 'sides' })));
    act(() => result.current.setLayout((layout) => ({ ...layout, ledPlacement: 'center' })));
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.layout.wiring?.paths).toEqual([]);
  });

  it('preserves endpoint moves but rejects history after a strip changes membership', () => {
    const { result } = editor({
      ...initial,
      ledPlacement: 'stripe',
      ledStripes: {
        orientation: 'horizontal',
        nextStripeId: 1,
        nextLedId: 3,
        stripes: [{ id: 'stripe-0', start: { x: 0, y: 0.2 }, end: { x: 1, y: 0.2 }, ledIds: ['a', 'b'] }],
      },
    });
    act(() => result.current.change({ ...initial.wiring!, paths: [['a', 'b']] }));
    act(() =>
      result.current.setLayout((layout) => ({
        ...layout,
        ledStripes: {
          ...layout.ledStripes!,
          stripes: layout.ledStripes!.stripes.map((stripe) => ({ ...stripe, start: { x: 0.1, y: 0.2 } })),
        },
      })),
    );
    expect(result.current.canUndo).toBe(true);
    act(() =>
      result.current.setLayout((layout) => ({
        ...layout,
        ledStripes: {
          ...layout.ledStripes!,
          stripes: layout.ledStripes!.stripes.map((stripe) => ({ ...stripe, ledIds: ['a', 'b', 'c'] })),
        },
      })),
    );
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.undo());
    expect(result.current.layout.wiring?.paths).toEqual([['a', 'b']]);
  });
});
