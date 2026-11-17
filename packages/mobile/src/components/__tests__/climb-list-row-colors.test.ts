import { describe, it, expect, vi } from 'vitest';

// theme/colors touches Platform/PlatformColor at import; stub for the test env.
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, PlatformColor: (name: string) => name }));

import { brandColors, brandColorsDark } from '@boardsesh/velvet-tokens';
import { selectedRowColors } from '../climb-list-row-colors';

describe('selectedRowColors', () => {
  it('mixes the light wash from the fill at 13%, with the tint as the accent bar', () => {
    // Light scheme: brandColors.primaryFill = #5B22F2 -> rgb(91, 34, 242).
    expect(selectedRowColors(brandColors, 'light')).toEqual({
      fill: 'rgba(91, 34, 242, 0.13)',
      accent: '#5B22F2',
    });
  });

  it('mixes the dark wash from the fill at 20%, and keeps the lifted tint as the accent bar', () => {
    // Dark scheme: the wash is the #7855FF FILL (rgb(120, 85, 255)), never the
    // #9784FF tint; the bar is the tint, so it stays visible on near-black.
    expect(selectedRowColors(brandColorsDark, 'dark')).toEqual({
      fill: 'rgba(120, 85, 255, 0.2)',
      accent: '#9784FF',
    });
  });

  it('produces a different wash per scheme (regression guard for the static-style bug)', () => {
    expect(selectedRowColors(brandColors, 'light').fill).not.toBe(selectedRowColors(brandColorsDark, 'dark').fill);
  });
});
