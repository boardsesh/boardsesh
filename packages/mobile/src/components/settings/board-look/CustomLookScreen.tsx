import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { useDraftNumber } from '../../../hooks/use-committed-slider-value';
import { useBoardLookSettings } from '../../../lib/board-render/use-board-look-settings';
import { buildCustomLookModel, type CustomLookModelInput } from './custom-look-model';

/**
 * "Custom look" — the knobs, on their own screen.
 *
 * These used to be revealed inline on the Board look screen, gated on a local
 * `customOpen` flag that existed because "show me the knobs" was a UI state the
 * settings themselves could not express. A route says the same thing without the
 * flag: the knobs are on screen exactly when you are on this screen.
 *
 * Every knob writes through `useBoardLookSettings`, which is the app's one
 * mirroring writer — so tuning here is remembered as the climber's custom look
 * and trying a preset afterwards stays reversible.
 */
export function CustomLookScreen() {
  const { t } = useTranslation('common');
  const { settings, effectiveRenderSettings, boardseshRendererAvailable, setMode, setBoardseshField } =
    useBoardLookSettings();

  // Local drafts, so a drag moves the thumb without writing to AsyncStorage on
  // every frame. The row's `onCommit` is the only thing that reaches the store.
  const glowReach = useDraftNumber(settings.boardsesh.glowReach);
  const plateauShare = useDraftNumber(settings.boardsesh.plateauShare);
  const veilOpacity = useDraftNumber(settings.boardsesh.veilOpacity);
  const fillOpacity = useDraftNumber(settings.boardsesh.fillOpacity);

  const draft = useMemo<CustomLookModelInput['draft']>(
    () => ({
      glowReach: { value: glowReach.draftValue, onValueChange: glowReach.setDraftValue },
      plateauShare: { value: plateauShare.draftValue, onValueChange: plateauShare.setDraftValue },
      veilOpacity: { value: veilOpacity.draftValue, onValueChange: veilOpacity.setDraftValue },
      fillOpacity: { value: fillOpacity.draftValue, onValueChange: fillOpacity.setDraftValue },
    }),
    [
      glowReach.draftValue,
      glowReach.setDraftValue,
      plateauShare.draftValue,
      plateauShare.setDraftValue,
      veilOpacity.draftValue,
      veilOpacity.setDraftValue,
      fillOpacity.draftValue,
      fillOpacity.setDraftValue,
    ],
  );

  const model = useMemo(
    () =>
      buildCustomLookModel({
        boardsesh: settings.boardsesh,
        mode: settings.mode,
        // Show the drawing they are actually getting without writing a choice on
        // their behalf — `default` is a real state, not a missing one.
        selectedMode: settings.mode === 'default' ? effectiveRenderSettings.mode : settings.mode,
        effectiveGlowFalloff: effectiveRenderSettings.glowFalloff,
        boardseshRendererAvailable,
        t,
        setMode,
        setBoardseshField,
        draft,
      }),
    [
      settings.boardsesh,
      settings.mode,
      effectiveRenderSettings.mode,
      effectiveRenderSettings.glowFalloff,
      boardseshRendererAvailable,
      t,
      setMode,
      setBoardseshField,
      draft,
    ],
  );

  return <MoreForm model={model} />;
}
