// @vitest-environment jsdom
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const prewarmed = vi.hoisted(() => ({ frames: [] as string[] }));
vi.mock('../ClimbListThumbnail', () => ({
  ClimbListThumbnailPrewarm: ({ frames }: { frames: string }) => {
    prewarmed.frames.push(frames);
    return null;
  },
}));

import { ClimbListThumbnailPrewarmWindow, createVisibleRowsStore } from '../ClimbListScrollAhead';

const climbs = Array.from({ length: 200 }, (_climb, index) => ({ uuid: `c${index}`, frames: `f${index}` }));

/** Which climbs the window warms with rows 100–107 on screen. */
function warmedAround(climbsPerRow: number | undefined): number[] {
  prewarmed.frames.length = 0;
  const store = createVisibleRowsStore();
  store.set(100, 107);
  render(
    createElement(ClimbListThumbnailPrewarmWindow, {
      store,
      climbs,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 2,
      setIds: '3',
      climbsPerRow,
    }),
  );
  return prewarmed.frames.map((frames) => Number(frames.slice(1)));
}

describe('ClimbListThumbnailPrewarmWindow', () => {
  it('warms 12 climbs above and 24 (plus a step) below in one column', () => {
    const warmed = warmedAround(undefined);
    expect(Math.min(...warmed)).toBe(100 - 12);
    expect(Math.max(...warmed)).toBe(104 + 4 + 24);
    expect(warmed).not.toContain(100);
  });

  it('warms twice as many climbs in two columns, the same distance down the screen', () => {
    const warmed = warmedAround(2);
    expect(Math.min(...warmed)).toBe(100 - 24);
    expect(Math.max(...warmed)).toBe(104 + 4 + 48);
    expect(warmed).toHaveLength(24 + 4 + 48);
  });
});
