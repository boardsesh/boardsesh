import { describe, it, expect, vi } from 'vitest';

// The module pulls in preference-store → AsyncStorage at import time; mock it so
// the suite loads under Vitest (the native module isn't resolvable here).
vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
    },
  };
});

import { createClimbDraftKey } from '../create-climb-draft-store';

describe('createClimbDraftKey', () => {
  const base = { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '10', angle: 40 };

  it('includes every board dimension in the key', () => {
    expect(createClimbDraftKey(base)).toBe('kilter:1:2:10:40');
  });

  it('distinguishes hold sets at the same layout/size/angle', () => {
    // Kilter/Tension share a layout/size/angle across "original" vs "commercial"
    // (bolt-on) sets. The key must differ so one set's draft never restores hold
    // IDs that don't exist in the other set.
    const original = createClimbDraftKey({ ...base, setIds: '10' });
    const commercial = createClimbDraftKey({ ...base, setIds: '11' });
    expect(original).not.toBe(commercial);
  });

  it('distinguishes board, layout, size, and angle', () => {
    expect(createClimbDraftKey({ ...base, boardName: 'tension' })).not.toBe(createClimbDraftKey(base));
    expect(createClimbDraftKey({ ...base, layoutId: 99 })).not.toBe(createClimbDraftKey(base));
    expect(createClimbDraftKey({ ...base, sizeId: 99 })).not.toBe(createClimbDraftKey(base));
    expect(createClimbDraftKey({ ...base, angle: 25 })).not.toBe(createClimbDraftKey(base));
  });
});
