import { describe, expect, it, vi } from 'vitest';

const iconFont = vi.hoisted(() => ({ loadFont: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: { loadFont: iconFont.loadFont },
}));

import { loadRequiredFonts } from '../required-fonts';

describe('loadRequiredFonts', () => {
  it('preloads the MaterialCommunityIcons font before first app paint', async () => {
    await loadRequiredFonts();
    expect(iconFont.loadFont).toHaveBeenCalledTimes(1);
  });
});
