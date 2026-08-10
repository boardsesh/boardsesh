// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/queue';

const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn() }));
const haptics = vi.hoisted(() => ({ hapticLight: vi.fn() }));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: drawer.openPlayDrawer }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.hapticLight }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));

import { useOpenWallPreview } from '../use-open-wall-preview';

function makeClimb(): Climb {
  return {
    uuid: 'wall-1',
    name: 'Wax On',
    frames: '',
    setter_username: 'someone',
    angle: 40,
    ascensionist_count: 9,
    difficulty: 'V5',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  } as Climb;
}

describe('useOpenWallPreview', () => {
  beforeEach(() => {
    drawer.openPlayDrawer.mockClear();
    haptics.hapticLight.mockClear();
  });

  it('opens the climb read-only as a wall preview, with haptics', () => {
    const climb = makeClimb();
    const { result } = renderHook(() => useOpenWallPreview());
    result.current(climb);

    expect(haptics.hapticLight).toHaveBeenCalledTimes(1);
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(
      climb,
      expect.objectContaining({
        previewIsWallClimb: true,
        previewQueueItem: expect.objectContaining({ climb: expect.objectContaining({ uuid: 'wall-1' }) }),
      }),
    );
  });
});
