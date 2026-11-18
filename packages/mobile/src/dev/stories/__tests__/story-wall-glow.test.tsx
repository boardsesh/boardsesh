// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STORY_BOARD, STORY_CLIMBS } from '../../fixtures/climbs';
import { useStoryWallGlow } from '../use-story-wall-glow';

// The store shots' driving wall button frosts from the climb's lit holds; with
// no input it fell back to flat amber.
describe('useStoryWallGlow', () => {
  it("builds the driving frost from the story climb's lit holds", () => {
    const climb = STORY_CLIMBS[0];
    const { result } = renderHook(() => useStoryWallGlow({ board: STORY_BOARD, climb, mirrored: false, shown: true }));
    expect(result.current).not.toBeNull();
    expect(result.current?.holds.length).toBeGreaterThan(0);
    expect(result.current?.key.startsWith(`${climb.uuid}|`)).toBe(true);
  });

  it('builds nothing when the button is not frosted', () => {
    const { result } = renderHook(() =>
      useStoryWallGlow({ board: STORY_BOARD, climb: STORY_CLIMBS[0], mirrored: false, shown: false }),
    );
    expect(result.current).toBeNull();
  });
});
