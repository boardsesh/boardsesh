import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { BoardLookCarousel } from '../../board-look/BoardLookCarousel';
import { BOARD_LOOK_CARD_HEIGHT } from '../../board-look/BoardLookPreviewCard';
import { useBoardPreviewClimb } from '../../../hooks/use-board-preview-climb';
import { useBoardLookSettings } from '../../../lib/board-render/use-board-look-settings';
import { useHoldColorOverrides } from '../../../lib/hold-color-overrides';
import { countHoldMarkerOverrides } from '../../../lib/hold-color-overrides';
import { BOARD_LOOK_SETTINGS_OPTIONS, type BoardLookOptionId } from '../../../lib/board-render/board-look-options';
import { useOsAccessibilitySignals } from '../../../hooks/use-os-accessibility-signals';
import {
  applyBoardLookSuggestion,
  pickBoardLookSuggestion,
  type BoardLookSuggestionId,
} from '../../../lib/board-render/board-look-suggestions';
import {
  ALL_BOARD_LOOK_SUGGESTIONS_DISMISSED,
  dismissBoardLookSuggestion,
  loadBoardLookSuggestionDismissals,
  type BoardLookSuggestionDismissals,
} from '../../../lib/board-render/board-look-suggestion-dismissals';
import { buildBoardLookModel } from './board-look-model';

/**
 * "Board look" — the parent. Pick a look from a rail of renders of your own
 * board, or step into one of the two things behind it.
 *
 * The Custom CARD and the "Custom look" ROW are deliberately different actions.
 * The card is a look change: it brings back the bundle you last tuned, the same
 * way every other card applies its own look. The row is navigation only and
 * writes nothing — its subtitle says which look you are currently on, so it
 * reads as "go and tune what you have".
 */
export function BoardLookScreen() {
  const { t } = useTranslation('common');
  const {
    settings,
    matchingOptionId,
    boardseshRendererAvailable,
    requestedMode,
    applyPreset,
    restoreCustomLook,
    resetBoardLook,
  } = useBoardLookSettings();
  const { preview } = useBoardPreviewClimb();
  const { overrides, shapes, brushThickness, shapeSize } = useHoldColorOverrides();
  const signals = useOsAccessibilitySignals();

  // Start fully dismissed, so a banner can never flash in during hydration and
  // then vanish. Only a real read can un-dismiss.
  const [dismissals, setDismissals] = useState<BoardLookSuggestionDismissals>(ALL_BOARD_LOOK_SUGGESTIONS_DISMISSED);
  const [dismissalsLoaded, setDismissalsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadBoardLookSuggestionDismissals().then((loaded) => {
      if (cancelled) return;
      setDismissals(loaded);
      setDismissalsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const suggestion = useMemo(
    () =>
      pickBoardLookSuggestion({
        signals,
        settings,
        boardseshRendererAvailable,
        dismissed: dismissals,
        dismissalsLoaded,
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
      }),
    [signals, settings, boardseshRendererAvailable, dismissals, dismissalsLoaded],
  );

  // Applying records the dismissal too, so an accepted suggestion cannot come
  // back — both paths end with the banner gone for good.
  const settleSuggestion = useCallback((id: BoardLookSuggestionId, apply: boolean) => {
    setDismissals((current) => ({ ...current, [id]: true }));
    void (apply ? applyBoardLookSuggestion(id) : dismissBoardLookSuggestion(id));
  }, []);

  // A build that cannot draw the Boardsesh look makes every Boardsesh card a
  // lie, so the rail collapses to the looks this build can actually render.
  const options = useMemo(
    () =>
      boardseshRendererAvailable === false
        ? BOARD_LOOK_SETTINGS_OPTIONS.filter((option) => !option.requiresBoardseshRenderer)
        : BOARD_LOOK_SETTINGS_OPTIONS,
    [boardseshRendererAvailable],
  );

  const handleSelect = useCallback(
    (id: BoardLookOptionId) => {
      if (id === 'custom') {
        // Bring back what they tuned, THEN show them the knobs. Without the
        // restore, opening Custom would land them on whatever preset they were
        // on and quietly discard the look they built.
        void restoreCustomLook().finally(() => router.push('/(tabs)/profile/board-look/custom'));
        return;
      }
      applyPreset(id);
    },
    [applyPreset, restoreCustomLook],
  );

  const currentLookLabel = useMemo(() => {
    const option = BOARD_LOOK_SETTINGS_OPTIONS.find((candidate) => candidate.id === matchingOptionId);
    return option ? t(option.labelI18nKey) : '';
  }, [matchingOptionId, t]);

  const overriddenCount = useMemo(
    () => countHoldMarkerOverrides({ colors: overrides, shapes, brushThickness, shapeSize }),
    [overrides, shapes, brushThickness, shapeSize],
  );

  const carousel = useMemo(
    () =>
      preview ? (
        <BoardLookCarousel
          options={options}
          selectedId={matchingOptionId}
          onSelect={handleSelect}
          preview={preview}
          boardseshRendererAvailable={boardseshRendererAvailable}
        />
      ) : null,
    [preview, options, matchingOptionId, handleSelect, boardseshRendererAvailable],
  );

  const model = useMemo(
    () =>
      buildBoardLookModel({
        carousel,
        carouselHeight: BOARD_LOOK_CARD_HEIGHT,
        matchingOptionId,
        currentLookLabel,
        overriddenCount,
        boardseshRendererAvailable,
        requestedMode,
        t,
        onOpenCustomLook: () => router.push('/(tabs)/profile/board-look/custom'),
        onOpenAccessibility: () => router.push('/(tabs)/profile/board-look/accessibility'),
        onResetBoardLook: resetBoardLook,
        suggestion,
        onApplySuggestion: () => suggestion && settleSuggestion(suggestion.id, true),
        onDismissSuggestion: () => suggestion && settleSuggestion(suggestion.id, false),
      }),
    [
      carousel,
      matchingOptionId,
      currentLookLabel,
      overriddenCount,
      boardseshRendererAvailable,
      requestedMode,
      t,
      resetBoardLook,
      suggestion,
      settleSuggestion,
    ],
  );

  return <MoreForm model={model} />;
}
