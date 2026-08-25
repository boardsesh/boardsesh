import type { ImageSourcePropType } from 'react-native';

/**
 * Board-art variants for the rendering spike (issue #2202).
 *
 * `original` is the art we ship today. `c60` / `c100` are the OkLab
 * lightness-stretched siblings written by `scripts/spike-oklab-board-art.ts`
 * — the number is the contrast amount (60% / 100% of the full stretch), which
 * stands in for the per-user "contrast amount" setting the issue asks for.
 *
 * One board config only (Grasshopper Master 8x12 with Tweeners): the spike
 * exists to be looked at, not to cover the catalogue.
 */
export type SpikeArtLevel = 'original' | 'c60' | 'c100';

export const SPIKE_ART_LEVELS: readonly SpikeArtLevel[] = ['original', 'c60', 'c100'];

export const SPIKE_ART_LABEL: Record<SpikeArtLevel, string> = {
  original: 'Art ×0',
  c60: 'Art ×0.6',
  c100: 'Art ×1',
};

export const SPIKE_BOARD_ART: Record<SpikeArtLevel, ImageSourcePropType[]> = {
  original: [
    require('../../../../web/public/images/grasshopper/product_sizes_layouts_sets/8x12-2020-engage.webp'),
    require('../../../../web/public/images/grasshopper/product_sizes_layouts_sets/8x12-2020-flow.webp'),
    require('../../../../web/public/images/grasshopper/product_sizes_layouts_sets/8x12-2020-power.webp'),
    require('../../../../web/public/images/grasshopper/product_sizes_layouts_sets/8x12-2020-gradient.webp'),
    require('../../../../web/public/images/grasshopper/product_sizes_layouts_sets/8x12-2020-tweeners-v2.webp'),
  ],
  c60: [
    require('../../../assets/spike/grasshopper/8x12-2020-engage.c60.webp'),
    require('../../../assets/spike/grasshopper/8x12-2020-flow.c60.webp'),
    require('../../../assets/spike/grasshopper/8x12-2020-power.c60.webp'),
    require('../../../assets/spike/grasshopper/8x12-2020-gradient.c60.webp'),
    require('../../../assets/spike/grasshopper/8x12-2020-tweeners-v2.c60.webp'),
  ],
  c100: [
    require('../../../assets/spike/grasshopper/8x12-2020-engage.c100.webp'),
    require('../../../assets/spike/grasshopper/8x12-2020-flow.c100.webp'),
    require('../../../assets/spike/grasshopper/8x12-2020-power.c100.webp'),
    require('../../../assets/spike/grasshopper/8x12-2020-gradient.c100.webp'),
    require('../../../assets/spike/grasshopper/8x12-2020-tweeners-v2.c100.webp'),
  ],
};
