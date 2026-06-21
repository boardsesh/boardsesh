import { describe, it, expect, vi } from 'vitest';

// theme/colors touches Platform/PlatformColor at import; stub for the test env.
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, PlatformColor: (name: string) => name }));

import { selectedRowColors } from '../climb-list-row-colors';

describe('selectedRowColors', () => {
  it('derives the active-row wash + accent from the light brand primary', () => {
    // Light scheme: brandColors.primary = #6D28D9 -> rgb(109, 40, 217).
    expect(selectedRowColors('#6D28D9')).toEqual({
      fill: 'rgba(109, 40, 217, 0.18)',
      accent: '#6D28D9',
    });
  });

  it('uses the lifted tint in dark so the highlight stays visible on near-black', () => {
    // Dark scheme: brandColorsDark.primary = #A78BFA -> rgb(167, 139, 250). The
    // wash/accent MUST differ from the light scheme, or dark rows lose the cue.
    expect(selectedRowColors('#A78BFA')).toEqual({
      fill: 'rgba(167, 139, 250, 0.18)',
      accent: '#A78BFA',
    });
  });

  it('produces a different wash per scheme (regression guard for the static-style bug)', () => {
    expect(selectedRowColors('#6D28D9').fill).not.toBe(selectedRowColors('#A78BFA').fill);
  });
});
