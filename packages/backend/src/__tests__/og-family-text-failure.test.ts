import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OG_FAMILY_WHITE, type OgFamilyCardContent } from '@boardsesh/board-render/og-family';

const textFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock('@boardsesh/board-render/og-family', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-render/og-family')>();
  return {
    ...actual,
    renderOgFamilyTextLayers: async (content: OgFamilyCardContent) => {
      if (textFailure.enabled) throw new Error('text: invalid markup in text');
      return actual.renderOgFamilyTextLayers(content);
    },
  };
});

import { buildOgFamilyByteKey, renderOgFamilyArt, resetBoardRenderCaches } from '../services/board-render';

const content: OgFamilyCardContent = {
  slot: 'none',
  fontFamily: 'Noto Sans',
  hero: { runs: [{ text: 'Join', color: OG_FAMILY_WHITE }], maxPt: 60, wrap: true },
  rows: [],
};

describe('a family card whose text fails', () => {
  beforeEach(() => {
    textFailure.enabled = false;
    resetBoardRenderCaches();
  });

  it('rejects instead of answering a wordless card', async () => {
    textFailure.enabled = true;

    await expect(
      renderOgFamilyArt({ cacheKey: buildOgFamilyByteKey('test', 'text-fails'), art: null, content }),
    ).rejects.toThrow('invalid markup');
  });

  it('caches nothing under the key, so the next request renders the words', async () => {
    const cacheKey = buildOgFamilyByteKey('test', 'text-recovers');
    textFailure.enabled = true;
    await expect(renderOgFamilyArt({ cacheKey, art: null, content })).rejects.toThrow();

    textFailure.enabled = false;
    const recovered = await renderOgFamilyArt({ cacheKey, art: null, content });

    expect(recovered.cache).toBe('none');
  });
});
