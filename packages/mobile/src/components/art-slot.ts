import { spacing } from '../theme/tokens';

/**
 * The two art slots a row can lead with, in points. `regular` is a board at the
 * size Home and the picker list it (44×56, a portrait 4:5-ish box that fits every
 * catalogue board and a phone-shot spray wall); `compact` is the same shape one
 * step down for denser lists (36×44).
 *
 * `ArtRow` takes the slot's width (the art sets the row's height, so an icon or a
 * square playlist tile never stretches a row), `BoardThumbnail` fills the whole
 * slot, and `InsetGroupedList` insets its separators to the text that follows it.
 */
export const ART_SLOTS = {
  compact: { width: 36, height: 44 },
  regular: { width: 44, height: 56 },
} as const;

export type ArtSize = keyof typeof ART_SLOTS;

/** Row gutter and the gap between the art and the text, shared by every inset-grouped row. */
export const ROW_GUTTER = spacing[4];
export const ROW_ART_GAP = spacing[3];

/** Where a row's text starts: the gutter, the art slot, then the gap. Separators inset to it. */
export function artRowTextStart(size: ArtSize): number {
  return ROW_GUTTER + ART_SLOTS[size].width + ROW_ART_GAP;
}
