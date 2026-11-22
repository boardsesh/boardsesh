import { describe, expect, it } from 'vitest';
import type { SharedValue } from 'react-native-reanimated';
import {
  clearOwnedStroke,
  releaseOwnedStroke,
  strokeSessionIsCurrent,
  type DrawStrokeSession,
} from '../draw-stroke-session';
const shared = <T>(value: T) => ({ value }) as SharedValue<T>;
const session: DrawStrokeSession = {
  id: 1,
  epoch: 3,
  generation: 4,
  enabled: true,
  tool: 'trace',
  targetId: 9,
  zoom: 8,
  isStylus: true,
  brushPt: 2,
  brushMode: 'add',
};
describe('stroke ownership across render and overlay boundaries', () => {
  it('never clears a later stroke even when both strokes start on the same coordinates', () => {
    const points = shared([10, 10, 20, 20]);
    const owner = shared(2);
    clearOwnedStroke(points, owner, 1);
    expect(points.value).toEqual([10, 10, 20, 20]);
    clearOwnedStroke(points, owner, 2);
    expect(points.value).toEqual([]);
  });
  it('unmounting an old draft overlay cannot release the active Refine contact', () => {
    const draft = shared([10, 10]);
    const draftId = shared(1);
    const active = shared(2);
    releaseOwnedStroke(draft, draftId, active, 1);
    expect(active.value).toBe(2);
    const refine = shared([20, 20]);
    releaseOwnedStroke(refine, shared(2), active, 2);
    expect(active.value).toBe(0);
  });
  it('rejects old tool, editor and loaded-draft generations', () => {
    expect(strokeSessionIsCurrent(session, 3, 'trace', 4)).toBe(true);
    expect(strokeSessionIsCurrent(session, 4, 'trace', 4)).toBe(false);
    expect(strokeSessionIsCurrent(session, 3, 'add', 4)).toBe(false);
    expect(strokeSessionIsCurrent(session, 3, 'trace', 5)).toBe(false);
  });
});
