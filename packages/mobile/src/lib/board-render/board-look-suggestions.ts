import { applyBoardRenderPreset } from '../board-render-presets';
import {
  requestedBoardRenderMode,
  setBoardseshRenderFieldPreference,
  type BoardRenderSettings,
} from '../board-render-settings';
import type { OsAccessibilitySignals } from '../../hooks/use-os-accessibility-signals';
import { matchingBoardLookOptionId } from './board-look-options';
import { dismissBoardLookSuggestion, type BoardLookSuggestionDismissals } from './board-look-suggestion-dismissals';

/**
 * When the phone's own accessibility settings disagree with the board look, say
 * so once and offer one tap to fix it.
 *
 * **The invariant, and the reason this module exists: a suggestion may write
 * `boardRenderSettings` only. It may NEVER write `holdColorOverrides`.**
 *
 * `cvd-palette-presets.ts` writes the four role colours through `setRoleOverride`
 * — the same store a manual colour pick writes — so applying a colour-vision
 * palette reaches the PHYSICAL BOARD'S LEDs. A greyscale phone *display* says
 * nothing about the LEDs a climber is looking at on the wall. Turning someone's
 * real board grey because their screen is grey is exactly the overreach this
 * feature exists to avoid, so the greyscale rule below suggests role glyphs —
 * a shape channel drawn on the phone — and nothing else.
 *
 * Two rules ship, and only two. Both work on BOTH platforms:
 *
 * | Rule | Signal                                                    | Suggests           |
 * | ---- | --------------------------------------------------------- | ------------------ |
 * | R1   | iOS "Increase Contrast" / Android "High contrast text"     | the `max-contrast` preset |
 * | R2   | Greyscale display (both platforms)                        | `roleGlyphs: true` |
 *
 * Deliberately NOT acted on:
 * - **Invert colours** — a glare/light-sensitivity preference, and iOS Smart
 *   Invert skips images. Both the board photo and the holds overlay are images,
 *   so no single suggestion is correct under both plain and Smart Invert.
 * - **Reduce transparency** — the veil RAISES contrast here; it is not
 *   decorative frosting. iOS-only anyway.
 * - **Bold text** — stroke weight, not glow reach.
 * - **Reduce motion** — nothing on this screen moves.
 * - **Screen reader** — says nothing about colour. It must not SUPPRESS the
 *   banner either: a VoiceOver user can also be a greyscale user.
 * - **Prefers cross-fade transitions** — no meaning here, and not querying it
 *   avoids an AppState-polling requirement.
 */

export type BoardLookSuggestionId = 'increaseContrast' | 'grayscale';

export type BoardLookSuggestion = {
  id: BoardLookSuggestionId;
  titleI18nKey: string;
  bodyI18nKey: string;
  applyI18nKey: string;
};

export type BoardLookSuggestionInputs = {
  signals: OsAccessibilitySignals;
  settings: BoardRenderSettings;
  boardseshRendererAvailable: boolean | null;
  dismissed: BoardLookSuggestionDismissals;
  dismissalsLoaded: boolean;
  platform: 'ios' | 'android' | 'web';
};

// The keys are returned as DATA, so nothing in source references them as string
// literals and the orphan checker cannot see them. One marker per key:
// i18n-keep common:mobile.more.boardLook.suggestion.increaseContrast.titleIos
// i18n-keep common:mobile.more.boardLook.suggestion.increaseContrast.titleAndroid
// i18n-keep common:mobile.more.boardLook.suggestion.increaseContrast.body
// i18n-keep common:mobile.more.boardLook.suggestion.increaseContrast.apply
// i18n-keep common:mobile.more.boardLook.suggestion.grayscale.title
// i18n-keep common:mobile.more.boardLook.suggestion.grayscale.body
// i18n-keep common:mobile.more.boardLook.suggestion.grayscale.apply
// i18n-keep common:mobile.more.boardLook.suggestion.dismiss
// i18n-keep common:mobile.more.boardLook.suggestion.dismissAccessibility
const KEY_ROOT = 'mobile.more.boardLook.suggestion';

/** Shared by both suggestions, so the banner's two buttons never drift apart. */
export const BOARD_LOOK_SUGGESTION_DISMISS_I18N_KEY = `${KEY_ROOT}.dismiss`;
export const BOARD_LOOK_SUGGESTION_DISMISS_ACCESSIBILITY_I18N_KEY = `${KEY_ROOT}.dismissAccessibility`;

/**
 * R1's title names the OS setting, and the setting has a different NAME on each
 * platform. Naming it exactly is what makes the banner credible rather than
 * creepy — "Increase Contrast is on" is something the climber can go and check.
 */
function increaseContrastTitleKey(platform: BoardLookSuggestionInputs['platform']): string | null {
  if (platform === 'ios') return `${KEY_ROOT}.increaseContrast.titleIos`;
  if (platform === 'android') return `${KEY_ROOT}.increaseContrast.titleAndroid`;
  return null;
}

/**
 * At most one suggestion, or `null`.
 *
 * Greyscale beats increase-contrast when both are on: it is rarer, the signal is
 * more certain (a real query on both platforms rather than one that is hardcoded
 * `false` on half of them), and role glyphs are a contrast affordance in their
 * own right — so the narrower suggestion also happens to be the stronger one.
 *
 * Nothing shows unless EVERY gate holds. In particular `'unknown'` never
 * qualifies: a rejected query is not permission to interrupt.
 */
export function pickBoardLookSuggestion(inputs: BoardLookSuggestionInputs): BoardLookSuggestion | null {
  const { signals, settings, boardseshRendererAvailable, dismissed, dismissalsLoaded } = inputs;

  if (!signals.ready) return null;
  if (!dismissalsLoaded) return null;
  // A card the installed renderer cannot draw is a lie: a library predating the
  // Aura drawing accepts its config, ignores every field and hands back a
  // classic render. `null` is "not probed yet", which is not a yes.
  if (boardseshRendererAvailable !== true) return null;
  // Never offer to flip a climber who explicitly chose Classic. They answered
  // this question already.
  if (requestedBoardRenderMode(settings) !== 'aura') return null;

  if (signals.grayscale === 'on' && !dismissed.grayscale && settings.boardsesh.roleGlyphs === false) {
    return {
      id: 'grayscale',
      titleI18nKey: `${KEY_ROOT}.grayscale.title`,
      bodyI18nKey: `${KEY_ROOT}.grayscale.body`,
      applyI18nKey: `${KEY_ROOT}.grayscale.apply`,
    };
  }

  if (signals.increaseContrast === 'on' && !dismissed.increaseContrast) {
    const titleI18nKey = increaseContrastTitleKey(inputs.platform);
    // The target condition has to be UNMET — suggesting a look the climber is
    // already on is pure noise.
    if (titleI18nKey !== null && matchingBoardLookOptionId(settings) !== 'max-contrast') {
      return {
        id: 'increaseContrast',
        titleI18nKey,
        bodyI18nKey: `${KEY_ROOT}.increaseContrast.body`,
        applyI18nKey: `${KEY_ROOT}.increaseContrast.apply`,
      };
    }
  }

  return null;
}

/**
 * Apply a suggestion, and record it as answered so it never comes back.
 *
 * This is the ONLY write path a suggestion has, and it is the invariant in code:
 * `applyBoardRenderPreset` and `setBoardseshRenderFieldPreference` both write
 * `boardRenderSettings` and nothing else. Neither branch touches
 * `holdColorOverrides`, so no suggestion can change what the wall's LEDs do.
 */
export async function applyBoardLookSuggestion(id: BoardLookSuggestionId): Promise<void> {
  if (id === 'increaseContrast') {
    await applyBoardRenderPreset('max-contrast');
  } else {
    await setBoardseshRenderFieldPreference('roleGlyphs', true);
  }
  await dismissBoardLookSuggestion(id);
}
