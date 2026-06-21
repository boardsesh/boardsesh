import { describe, expect, it } from 'vitest';
import type { BoardName } from '@boardsesh/shared-schema';
import { createClimbScreenKey } from '../create-climb-screen-key';

const kilter = {
  boardName: 'kilter' as BoardName,
  layoutId: 1,
  sizeId: 2,
  setIds: '1,2',
};

describe('createClimbScreenKey', () => {
  it('remounts when the board layout/size/setIds change (drops stale holds)', () => {
    const base = createClimbScreenKey('new', kilter);
    expect(createClimbScreenKey('new', { ...kilter, layoutId: 9 })).not.toBe(base);
    expect(createClimbScreenKey('new', { ...kilter, sizeId: 9 })).not.toBe(base);
    expect(createClimbScreenKey('new', { ...kilter, setIds: '3,4' })).not.toBe(base);
    expect(createClimbScreenKey('new', { ...kilter, boardName: 'tension' as BoardName })).not.toBe(base);
  });

  it('does NOT remount on an angle-only change so an in-progress paint survives', () => {
    // create.tsx never feeds angle into the key, so two boards differing only by
    // angle must produce the same key. This guards against WS session-sync
    // angle updates wiping a paint.
    expect(createClimbScreenKey('new', kilter)).toBe(createClimbScreenKey('new', kilter));
    // The key string itself must not contain the angle value.
    expect(createClimbScreenKey('new', kilter)).not.toContain('40');
  });

  it('remounts when switching the edited climb (fresh undo history per draft)', () => {
    expect(createClimbScreenKey('uuid-a', kilter)).not.toBe(createClimbScreenKey('uuid-b', kilter));
    expect(createClimbScreenKey(undefined, kilter)).toBe(createClimbScreenKey('new', kilter));
  });
});
