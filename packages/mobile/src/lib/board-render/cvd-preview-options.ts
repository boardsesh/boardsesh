import { simulateCvd } from '../cvd-simulation';

/**
 * The four cards on the colour-vision rail, as data: the climber's own board
 * drawn normally, then once through each of the three dichromacies.
 *
 * Pure — no React, no storage — so the option list, its labels and the colour
 * transforms behind it are unit-testable without a renderer.
 *
 * Uses `cvd-simulation.ts` (the GAMMA-domain simulator), not the linear-light
 * one in `color-contrast-oracle.ts`: these cards are a VISUAL preview, and the
 * gamma-domain matrices are what every web CVD simulator shows, so a climber
 * comparing our card against one of those sees the same picture. The verdict
 * line beside the rail is the opposite call — that is a contrast DECISION, so
 * it uses the linear-light oracle. Both files' headers cross-reference each
 * other; do not swap them.
 *
 * Only the holds overlay is simulated. The board photograph underneath is drawn
 * as it really is (expo-image has no colour-matrix prop and Skia is deliberately
 * not installed), which is why the UI carries `cvd.photoNote`. That is fine for
 * the question these cards answer — "can I still tell my four hold roles
 * apart?" — which is a mark-against-mark judgement, not a look at the wall.
 */

export type CvdPreviewOptionId = 'none' | 'deuteranopia' | 'protanopia' | 'tritanopia';

export type CvdPreviewOption = {
  id: CvdPreviewOptionId;
  /**
   * The `…I18nKey` suffix is load-bearing, not decoration: `check:i18n:orphans`
   * treats a property with that name as a key holder, so it records these
   * literals AND accepts the card's `t(option.titleI18nKey)` as statically
   * resolved instead of hard-failing it as an unanalyzable `t()` argument.
   */
  titleI18nKey: string;
  subtitleI18nKey: string;
  /**
   * Redraws every hold colour this card's render resolves. `undefined` on
   * `none`, which is not a simulation at all — it is the real board.
   *
   * MODULE-SCOPE CONSTANTS, never built in render: this lands on a `React.memo`'d
   * image whose overlay effect re-fires on identity change, so a fresh function
   * per render would re-render four boards on every tick.
   */
  transform?: (hex: string) => string;
  /**
   * Identity of that transform, folded into the render cache key so each
   * simulated card caches as its own PNG and cannot displace the real board's.
   * Set exactly when `transform` is.
   */
  transformKey?: string;
};

const DEUTERANOPIA_TRANSFORM = (hex: string) => simulateCvd(hex, 'deuteranopia');
const PROTANOPIA_TRANSFORM = (hex: string) => simulateCvd(hex, 'protanopia');
const TRITANOPIA_TRANSFORM = (hex: string) => simulateCvd(hex, 'tritanopia');

/**
 * Normal first, then the three dichromacies in order of how common they are —
 * deuteranopia is by far the most common, tritanopia is rare — so the two cards
 * that fit on a phone at rest are the two worth comparing.
 */
export const CVD_PREVIEW_OPTIONS: readonly CvdPreviewOption[] = Object.freeze([
  {
    id: 'none',
    titleI18nKey: 'mobile.more.accessibility.cvd.cards.none.title',
    subtitleI18nKey: 'mobile.more.accessibility.cvd.cards.none.subtitle',
  },
  {
    id: 'deuteranopia',
    titleI18nKey: 'mobile.more.accessibility.cvd.cards.deuteranopia.title',
    subtitleI18nKey: 'mobile.more.accessibility.cvd.cards.deuteranopia.subtitle',
    transform: DEUTERANOPIA_TRANSFORM,
    transformKey: 'cvd-deuteranopia',
  },
  {
    id: 'protanopia',
    titleI18nKey: 'mobile.more.accessibility.cvd.cards.protanopia.title',
    subtitleI18nKey: 'mobile.more.accessibility.cvd.cards.protanopia.subtitle',
    transform: PROTANOPIA_TRANSFORM,
    transformKey: 'cvd-protanopia',
  },
  {
    id: 'tritanopia',
    titleI18nKey: 'mobile.more.accessibility.cvd.cards.tritanopia.title',
    subtitleI18nKey: 'mobile.more.accessibility.cvd.cards.tritanopia.subtitle',
    transform: TRITANOPIA_TRANSFORM,
    transformKey: 'cvd-tritanopia',
  },
]);
