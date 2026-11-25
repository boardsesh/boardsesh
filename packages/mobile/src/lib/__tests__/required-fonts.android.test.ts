import { expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => {
  throw new Error('Icon font unavailable');
});

import { loadRequiredFonts } from '../required-fonts.android';

it('allows Android launch without loading an icon font', async () => {
  await expect(loadRequiredFonts()).resolves.toBeUndefined();
});
