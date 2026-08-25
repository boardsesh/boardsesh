import type { ImageSourcePropType } from 'react-native';

/**
 * Board-art contrast variants for the rendering spike (issue #2202).
 *
 * `original` means "the art we ship", resolved through the ordinary bundled-asset
 * manifest, so it costs nothing and works for every board. `c60` / `c100` are the
 * OkLab lightness-stretched siblings written by `scripts/spike-oklab-board-art.ts`
 * — the number is the contrast amount, standing in for the per-user "contrast
 * amount" setting the issue asks for.
 *
 * Only Grasshopper has stretched art committed: it is ~920 KB for one board, and
 * the point is to judge the treatment, not to ship it. Every other board falls
 * back to its shipped art.
 */
export type SpikeArtLevel = 'original' | 'c60' | 'c100';

export const SPIKE_ART_LEVELS: readonly SpikeArtLevel[] = ['original', 'c60', 'c100'];

export const SPIKE_ART_LABEL: Record<SpikeArtLevel, string> = {
  original: 'Art ×0',
  c60: 'Art ×0.6',
  c100: 'Art ×1',
};

export const SPIKE_OKLAB_ART: Record<string, Partial<Record<SpikeArtLevel, ImageSourcePropType[]>>> = {
  'grasshopper-master': {
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
  },
};
