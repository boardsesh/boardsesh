import { describe, expect, it, vi } from 'vitest';

// `theme/tokens` reaches `ios-colors`, which calls these at module load.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: () => undefined },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
}));

import { CLIMB_ROW_GUTTER, climbRowSeparatorInset } from '../climb-row-layout';
import { THUMBNAIL_WIDTH } from '../climb-list-thumbnail-metrics';

describe('climbRowSeparatorInset', () => {
  it('starts a plain row’s separator at the text column: gutter, thumbnail, gap', () => {
    expect(THUMBNAIL_WIDTH).toBe(76);
    expect(CLIMB_ROW_GUTTER).toBe(16);
    expect(climbRowSeparatorInset(true)).toBe(104);
  });

  it('starts at the gutter when the row has no thumbnail', () => {
    expect(climbRowSeparatorInset(false)).toBe(16);
  });

  // Where each real host ends up is pinned against the host itself, in
  // climb-row-separator-hosts.test.tsx. This file is the arithmetic only.
  it('adds the thumbnail and one gap to a host’s own leading inset', () => {
    expect(climbRowSeparatorInset(true, 52)).toBe(52 + 76 + 12);
    expect(climbRowSeparatorInset(true, 12)).toBe(12 + 76 + 12);
  });

  it('falls back to the host’s own leading inset without a thumbnail', () => {
    expect(climbRowSeparatorInset(false, 52)).toBe(52);
    expect(climbRowSeparatorInset(false, 12)).toBe(12);
  });

  it('measures the leading inset from the row edge, replacing the gutter rather than adding to it', () => {
    expect(climbRowSeparatorInset(true, CLIMB_ROW_GUTTER)).toBe(climbRowSeparatorInset(true));
    expect(climbRowSeparatorInset(true, 0)).toBe(88);
  });
});
