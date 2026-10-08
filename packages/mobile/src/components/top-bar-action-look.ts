// How a top-bar trailing action looks: a sheet's Cancel or confirm (SheetTopBar)
// and a native header's (HeaderActionButtons). One pure resolver so the two can't
// drift. See docs/ai-design-guidelines.md, "Top-bar buttons".
import type { ColorValue } from 'react-native';
import type { IconName } from './icon-map';
import type { TopBarSpec } from '../theme/top-bar';

/**
 * What a trailing action does, which decides how it looks on iOS 26.
 *
 * - `confirm` saves or commits the climber's own edit: Save, Add, Create, a Done
 *   that commits a value (an angle, a crop). A ✓ in a brand circle on Liquid
 *   Glass, the word on Material. A destructive commit (End session) is never a
 *   ✓: it is the word, in the error colour.
 * - `send` sends or reports something to someone else: Submit, Send, Report,
 *   Claim. Prominent text on both; a word says where it goes better than a glyph.
 * - `forward` moves on, applies, or closes a confirmation: Next, Skip, Apply,
 *   "Show 12 climbs", Try again, the Done after a report went through. Text.
 *
 * A Done with nothing to commit is no trailing action at all: the leading X.
 */
export type TopBarTrailingKind = 'confirm' | 'send' | 'forward';

/**
 * The kind an action falls to when its caller names none: `confirm` when it is
 * `prominent` (the surface's main action, which usually finishes it), `forward`
 * otherwise. Every caller on main names its kind; this is for the ones that
 * don't yet (#6240's create drawer passes `prominent` and gets the ✓).
 */
export function resolveTrailingKind({
  kind,
  prominent,
}: {
  kind?: TopBarTrailingKind;
  prominent?: boolean;
}): TopBarTrailingKind {
  return kind ?? (prominent ? 'confirm' : 'forward');
}

export type TopBarActionLookInput = {
  /** `confirm` or `forward`; see TopBarTrailingKind. Leading text actions omit it. */
  kind?: TopBarTrailingKind;
  /** Replaces the ✓ of a `confirm` glyph (a lock on a locked save). */
  icon?: IconName;
  prominent?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /**
   * `sheet`: chrome we draw, where a confirm is the ✓ circle and a prominent text
   * action a filled capsule on Liquid Glass. `nativeHeader`: inside UIKit's glass
   * capsule (iOS before 26, Material), so nothing filled: a capsule or circle in
   * a capsule reads wrong; the confirm is brand semibold text there.
   * `standaloneBarItem`: an iOS 26 bar item that hides UIKit's shared glass and
   * draws its own shape, standing in for a native prominent item while it saves
   * or beside an accessory; filled like `sheet`, so idle and loading match.
   */
  surface: 'sheet' | 'nativeHeader' | 'standaloneBarItem';
};

export type TopBarActionColors = {
  label: ColorValue;
  primary: ColorValue;
  onPrimary: ColorValue;
  error: ColorValue;
};

export type TopBarActionLook = {
  /**
   * Draw this glyph in a filled circle instead of the label: the iOS 26 confirm.
   * The label is still the spoken name.
   */
  glyph: IconName | undefined;
  /** Draw a filled shape (the circle, or the forward capsule) behind the content. */
  filled: boolean;
  /** The fill's colour, when filled. */
  fillColor: ColorValue | undefined;
  /** The label's or glyph's colour, and the spinner's. */
  labelColor: ColorValue;
  /** Set only on a prominent text action; otherwise the `label` text variant's weight stands. */
  fontWeight: '500' | '600' | undefined;
  /** 1, or the dimmed opacity while disabled. Goes on the fill when filled, else on the label. */
  opacity: number;
};

export function resolveTopBarActionLook(
  spec: TopBarSpec,
  colors: TopBarActionColors,
  { kind, icon, prominent = false, destructive = false, disabled = false, surface }: TopBarActionLookInput,
): TopBarActionLook {
  const accent = destructive ? colors.error : colors.primary;
  const opacity = disabled ? spec.disabledOpacity : 1;
  const drawsShapes = surface !== 'nativeHeader';
  // No red ✓: a destructive commit is the word in the error colour.
  if (kind === 'confirm' && spec.confirmGlyph && !destructive && drawsShapes) {
    return {
      glyph: icon ?? 'confirm',
      filled: true,
      fillColor: accent,
      labelColor: colors.onPrimary,
      fontWeight: undefined,
      opacity,
    };
  }
  // The surface's main action: prominent, any confirm, any send.
  const emphasised = prominent || kind === 'confirm' || kind === 'send';
  // A destructive action is never filled: error text, as iOS draws End.
  const filled = emphasised && !destructive && spec.prominentFilled && drawsShapes;
  // The brand colour is for the surface's main action (and red for a destructive
  // one); every other bar action is in the label colour.
  const enabledColor = filled ? colors.onPrimary : emphasised || destructive ? accent : colors.label;
  const labelColor = disabled && spec.disabledInLabelColor && !filled ? colors.label : enabledColor;
  return {
    glyph: undefined,
    filled,
    fillColor: filled ? accent : undefined,
    labelColor,
    fontWeight: emphasised ? spec.prominentFontWeight : undefined,
    opacity,
  };
}
