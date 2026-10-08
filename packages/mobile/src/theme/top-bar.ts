import { glassSize } from './layout';
import type { UiVariant } from './resolve-ui-variant';

/**
 * The one visual spec for every top-bar and header button: SheetTopBar, the
 * native stack header's actions (HeaderActionButtons / useHeaderActions), and the
 * hand-built sheet headers (tick, queue, logbook, session). Resolved per UI
 * variant with `topBarFor(variant)`. The table in
 * docs/ai-design-guidelines.md, "Top-bar buttons", says the same thing in words.
 *
 * Labels use the `label` text variant (iOS 17/22, M3 labelLarge 14/20/500).
 */
export type TopBarSpec = {
  /** Side of a glyph button's hit target: close, back, more. */
  iconTarget: number;
  /** Glyph size inside it. */
  glyphSize: number;
  /**
   * A navigation glyph's colour (close, back, minimise): the label colour on
   * both; M3 draws a top app bar's navigation icon in onSurface.
   */
  navigationGlyphColor: 'label' | 'secondaryLabel';
  /**
   * An action glyph's colour (more, edit, help, history): the label colour on
   * Liquid Glass, onSurfaceVariant on Material (which the Material theme
   * resolves `secondaryLabel` to), as M3 draws trailing app bar actions.
   */
  actionGlyphColor: 'label' | 'secondaryLabel';
  /**
   * A glyph button on chrome we draw ourselves sits in a `systemColors.fill`
   * circle, the iOS 26 sheet close. M3 standard icon buttons have no fill.
   */
  glyphFilled: boolean;
  /**
   * The glyph button's own frame inside a native header. UIKit draws the iOS 26
   * glass around a custom bar view, so the frame stays small and a hit slop makes
   * up the rest of `iconTarget`. Material's top app bar draws nothing, so its
   * frame is the whole target.
   */
  nativeBarGlyphFrame: number;
  /**
   * Dynamic Type cap for a bar label. UIKit bar items don't scale with the text
   * size, so iOS holds them at 1; Android's top app bar does, a little.
   */
  labelMaxFontScale: number;
  /**
   * A `confirm` trailing action (Save, Done, Send: it finishes the surface) is a
   * ✓ in a brand circle the size of the leading close, as iOS 26's own sheets and
   * editors draw it. Material keeps a text action: an M3 full-screen dialog's
   * confirm is the word "Save".
   */
  confirmGlyph: boolean;
  /** A prominent `forward` action in a sheet is a filled brand capsule. */
  prominentFilled: boolean;
  /** Height of that capsule. */
  confirmHeight: number;
  /** Horizontal padding inside that capsule. */
  confirmPaddingHorizontal: number;
  /** Weight of a prominent label. */
  prominentFontWeight: '500' | '600';
  /** A disabled action's opacity. */
  disabledOpacity: number;
  /**
   * Material dims a disabled action in onSurface (the label colour) whatever its
   * colour was. iOS keeps the colour and only dims it.
   */
  disabledInLabelColor: boolean;
};

export const topBarByVariant: Record<UiVariant, TopBarSpec> = {
  liquidGlass: {
    iconTarget: 44,
    glyphSize: 17,
    navigationGlyphColor: 'label',
    actionGlyphColor: 'label',
    glyphFilled: true,
    nativeBarGlyphFrame: glassSize.mini,
    labelMaxFontScale: 1,
    confirmGlyph: true,
    prominentFilled: true,
    confirmHeight: 36,
    confirmPaddingHorizontal: 14,
    prominentFontWeight: '600',
    disabledOpacity: 0.4,
    disabledInLabelColor: false,
  },
  material: {
    iconTarget: 48,
    glyphSize: 24,
    navigationGlyphColor: 'label',
    actionGlyphColor: 'secondaryLabel',
    glyphFilled: false,
    nativeBarGlyphFrame: 48,
    labelMaxFontScale: 1.2,
    confirmGlyph: false,
    prominentFilled: false,
    confirmHeight: 48,
    confirmPaddingHorizontal: 12,
    prominentFontWeight: '500',
    disabledOpacity: 0.38,
    disabledInLabelColor: true,
  },
};

/**
 * The spec for a variant. Falls back to Liquid Glass, the default variant, for a
 * theme that carries none (a partial test theme, the pre-provider error screen).
 */
export function topBarFor(variant: UiVariant | undefined): TopBarSpec {
  return (variant != null ? topBarByVariant[variant] : undefined) ?? topBarByVariant.liquidGlass;
}
