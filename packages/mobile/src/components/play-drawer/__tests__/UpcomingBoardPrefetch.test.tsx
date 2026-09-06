// @vitest-environment jsdom
//
// The prefetch only pays off if it warms the SAME cache key the carousel will
// ask for — a mismatched width or hold style renders a second PNG nobody looks
// up, at the cost of a native render. So the props handed to the render hook
// are the contract under test here, not any pixels (this component draws none).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { BoardName } from '@boardsesh/shared-schema';

type RecordedRenderParams = {
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  filledStyle?: boolean;
  renderWidth?: number;
  backgroundVariant?: string;
  prefetch?: boolean;
};

const renderParams = vi.hoisted(() => [] as RecordedRenderParams[]);
/** The frames of every child that actually MOUNTED, in mount order. */
const mountedFrames = vi.hoisted(() => [] as string[]);

vi.mock('../../../hooks/use-native-climb-render', async () => {
  const { useEffect } = await import('react');
  return {
    useNativeClimbRender: (params: RecordedRenderParams) => {
      renderParams.push(params);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, on purpose: this is the remount probe.
      useEffect(() => {
        mountedFrames.push(params.frames);
      }, []);
      return { overlayUri: null };
    },
  };
});

const { UpcomingBoardPrefetch } = await import('../UpcomingBoardPrefetch');

const BOARD = { boardName: 'kilter' as BoardName, layoutId: 1, sizeId: 10, setIds: '26,27' };
const FIRST = 'p1100r12';
const SECOND = 'p1200r13';
const THIRD = 'p1300r12';

beforeEach(() => {
  renderParams.length = 0;
  mountedFrames.length = 0;
});

describe('UpcomingBoardPrefetch', () => {
  it('warms one render per upcoming climb, at the play board’s own cache key', () => {
    render(<UpcomingBoardPrefetch frames={[FIRST, SECOND]} {...BOARD} renderWidth={880} />);

    expect(renderParams).toHaveLength(2);
    expect(renderParams.map(({ frames }) => frames)).toEqual([FIRST, SECOND]);
    for (const params of renderParams) {
      expect(params).toMatchObject({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '26,27',
        renderWidth: 880,
        backgroundVariant: 'full',
        prefetch: true,
      });
      // Stroke-only, like the play board — a filled render is a different PNG.
      expect(params.filledStyle).toBeUndefined();
    }
  });

  it('warms nothing before the board has been measured', () => {
    render(<UpcomingBoardPrefetch frames={[FIRST, SECOND]} {...BOARD} renderWidth={undefined} />);

    expect(renderParams).toEqual([]);
  });

  it('warms nothing for an empty list', () => {
    render(<UpcomingBoardPrefetch frames={[]} {...BOARD} renderWidth={880} />);

    expect(renderParams).toEqual([]);
  });

  it('keeps the already-warmed climbs mounted when the list moves along', () => {
    const { rerender } = render(<UpcomingBoardPrefetch frames={[FIRST, SECOND, THIRD]} {...BOARD} renderWidth={880} />);
    expect(mountedFrames).toEqual([FIRST, SECOND, THIRD]);

    // The climber swiped one along: the same climbs shift down a slot and one
    // new one joins. Keyed on the frames, so only the newcomer mounts.
    const FOURTH = 'p1400r13';
    rerender(<UpcomingBoardPrefetch frames={[SECOND, THIRD, FOURTH]} {...BOARD} renderWidth={880} />);

    expect(mountedFrames).toEqual([FIRST, SECOND, THIRD, FOURTH]);
  });
});
