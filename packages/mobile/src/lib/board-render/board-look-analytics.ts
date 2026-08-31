// Thin wrappers around the shared board-look / board-render events, so the
// carousel and the onboarding step stay free of property-key bookkeeping.
//
// The invariant these hold, mirroring onboarding-analytics.ts: every
// `boardLookStepShown` resolves to exactly ONE `boardLookStepResolved` — saved,
// customized, or skipped, including the involuntary unmount. A step that fired
// Shown and nothing else would read in the funnel as a climber who never
// arrived, rather than one who backed out.

import {
  boardLookStepResolved,
  boardLookStepShown,
  boardRenderPresetApplied,
  boardRenderSettingsChanged,
  buildBoardRenderTelemetryProps,
  type BoardRenderContext,
  type BoardRenderEffectiveSettings,
  type BoardRenderPresetSurface,
  type BoardLookStepOutcome,
} from '@boardsesh/analytics';
import { track } from '../analytics';
import type { BoardLookOptionId } from './board-look-options';

/** The board identity a board-render event is about. */
export type BoardLookAnalyticsContext = Omit<BoardRenderContext, 'presetId' | 'paletteId'>;

/**
 * A card was applied.
 *
 * `effective` must be the settings the choice PRODUCES, not the ones it
 * replaced — the shared contract reads this event as "the common props now
 * carry a preset_id", so resolving it before the write would file the apply
 * under the previous look.
 *
 * Classic is not a preset, so it reports as a mode change instead; that is the
 * distinction `board-look-options` deliberately hides from the UI and has to
 * un-hide here, because the two events measure different things.
 */
export function trackBoardLookApplied(
  optionId: BoardLookOptionId,
  effective: BoardRenderEffectiveSettings,
  context: BoardLookAnalyticsContext,
  surface: BoardRenderPresetSurface,
): void {
  if (optionId === 'classic') {
    const { name, properties } = boardRenderSettingsChanged({
      ...buildBoardRenderTelemetryProps(effective, context),
      field: 'mode',
      value: 'classic',
    });
    track(name, properties);
    return;
  }

  const { name, properties } = boardRenderPresetApplied({
    // 'custom' lands the climber on the plain Boardsesh bundle before the Board
    // look screen opens, so that is genuinely the preset that was applied.
    ...buildBoardRenderTelemetryProps(effective, {
      ...context,
      presetId: optionId === 'custom' ? 'boardsesh' : optionId,
    }),
    surface,
  });
  track(name, properties);
}

export function trackBoardLookStepShown(
  effective: BoardRenderEffectiveSettings,
  context: BoardLookAnalyticsContext,
  optionsShown: number,
): void {
  const { name, properties } = boardLookStepShown({
    ...buildBoardRenderTelemetryProps(effective, context),
    options_shown: optionsShown,
  });
  track(name, properties);
}

export function trackBoardLookStepResolved(
  effective: BoardRenderEffectiveSettings,
  context: BoardLookAnalyticsContext,
  resolution: {
    outcome: BoardLookStepOutcome;
    selectedOption: BoardLookOptionId | null;
    cardsViewed: number;
    msToResolve: number;
  },
): void {
  const { name, properties } = boardLookStepResolved({
    ...buildBoardRenderTelemetryProps(effective, context),
    outcome: resolution.outcome,
    selected_option: resolution.selectedOption,
    cards_viewed: resolution.cardsViewed,
    ms_to_resolve: resolution.msToResolve,
  });
  track(name, properties);
}
