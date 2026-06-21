// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// colors.ts touches Platform/PlatformColor at import; Android skips the iOS branch.
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, PlatformColor: (name: string) => name }));

import { blendOpaque, withAlpha } from '../colors';

describe('withAlpha', () => {
  it('emits rgba() for hex input', () => {
    expect(withAlpha('#8C4A52', 0.15)).toBe('rgba(140, 74, 82, 0.15)');
  });

  it('returns non-hex input unchanged', () => {
    expect(withAlpha('rgba(1, 2, 3, 0.4)', 0.2)).toBe('rgba(1, 2, 3, 0.4)');
  });
});

describe('blendOpaque', () => {
  it('composites foreground over background at alpha as opaque hex', () => {
    // 15% of pure red over white → light pink, fully opaque.
    expect(blendOpaque('#FF0000', '#FFFFFF', 0.15)).toBe('#ffd9d9');
  });

  it('alpha 0 returns the background, alpha 1 returns the foreground', () => {
    expect(blendOpaque('#123456', '#ffffff', 0)).toBe('#ffffff');
    expect(blendOpaque('#123456', '#ffffff', 1)).toBe('#123456');
  });

  it('expands 3-digit hex before blending', () => {
    expect(blendOpaque('#000', '#fff', 0.5)).toBe('#808080');
  });

  it('returns the background unchanged when an input is not hex', () => {
    expect(blendOpaque('rgba(0,0,0,1)', '#1F1A1B', 0.2)).toBe('#1F1A1B');
  });
});
