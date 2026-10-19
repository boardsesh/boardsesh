import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { isMoonboardBoardName, toBoardName } from '@boardsesh/board-config';
import { scopedRouter as router } from '../../../lib/routing/scoped-navigation';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { MoreFormRN } from '../../MoreForm.rn';
import { BoardLookCarousel } from '../../board-look/BoardLookCarousel';
import { boardLookCardHeight } from '../../board-look/board-look-card-metrics';
import { useBoardPreviewClimb } from '../../../hooks/use-board-preview-climb';
import { useBoardLookSettings } from '../../../lib/board-render/use-board-look-settings';
import { countHoldMarkerOverrides, useHoldColorOverrides } from '../../../lib/hold-color-overrides';
import {
  BOARD_LOOK_SETTINGS_OPTIONS,
  drawableBoardLookOptions,
  type BoardLookOptionId,
} from '../../../lib/board-render/board-look-options';
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
import { useSprayWallsUseOwnLookSetting } from '../../../lib/spray-wall-look-preference';
import { hapticSelection } from '../../../lib/haptics';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { useBoardLightingSections } from '../board-lighting/use-board-lighting-sections';
import { useActiveBoard } from '../../../lib/graphql/use-active-board';
import { useSetting } from '../../../settings';

/**
 * "Board" — the parent. Pick a look from a rail of renders of your own board,
 * or step into one of the two things behind it; below that, what lights the
 * board and when the phone lets go of it.
 *
 * The Custom CARD and the "Custom look" ROW are deliberately different actions.
 * The card is a look change: it brings back the bundle you last tuned, the same
 * way every other card applies its own look. The row is navigation only and
 * writes nothing — its subtitle says which look you are currently on, so it
 * reads as "go and tune what you have".
 */
export function BoardLookScreen() {
  const { t } = useTranslation('common');
  const { settings, matchingOptionId, boardseshRendererAvailable, requestedMode, applyPreset, restoreCustomLook } =
    useBoardLookSettings();
  const { preview } = useBoardPreviewClimb();
  // The rail's row is pinned in POINTS by a native host (SwiftUI `frame`, Compose
  // `height`) before React Native lays anything out, so the height has to account
  // for the climber's text size — React Native scales lineHeight by the font
  // multiplier, and the old constant under-reported by 26pt at the largest sizes.
  const { fontScale } = useWindowDimensions();
  // The climber's own choices: shapes the OS fills in for Differentiate Without
  // Color are not something they customised.
  const { markerOverrides } = useHoldColorOverrides();
  const signals = useOsAccessibilitySignals();
  const { useOwnLook, setUseOwnLook } = useSprayWallsUseOwnLookSetting();
  const lightingSections = useBoardLightingSections();
  const sprayWalls = useMemo(
    () => ({
      useOwnLook,
      onUseOwnLookChange: (next: boolean) => {
        hapticSelection();
        setUseOwnLook(next);
      },
    }),
    [useOwnLook, setUseOwnLook],
  );
  // Only when the climber's active board is a MoonBoard. (The MoonBoard lighting
  // switch further down this page gates on the connected Bluetooth board
  // instead; the labels are about the board on screen, not the one on the wall.)
  const { data: activeBoard } = useActiveBoard();
  const showMoonboardGridLabels = isMoonboardBoardName(toBoardName(activeBoard?.boardType));
  const [moonboardGridLabelsEnabled, setMoonboardGridLabelsEnabled] = useSetting('moonboardGridLabels');
  const moonboardGridLabels = useMemo(
    () =>
      showMoonboardGridLabels
        ? {
            enabled: moonboardGridLabelsEnabled,
            onChange: (enabled: boolean) => {
              hapticSelection();
              setMoonboardGridLabelsEnabled(enabled);
            },
          }
        : null,
    [showMoonboardGridLabels, moonboardGridLabelsEnabled, setMoonboardGridLabelsEnabled],
  );

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
    () => drawableBoardLookOptions(BOARD_LOOK_SETTINGS_OPTIONS, boardseshRendererAvailable),
    [boardseshRendererAvailable],
  );

  const handleSelect = useCallback(
    (id: BoardLookOptionId) => {
      if (id === 'custom') {
        // Bring back what they tuned, THEN show them the knobs. Without the
        // restore, opening Custom would land them on whatever preset they were
        // on and quietly discard the look they built.
        void restoreCustomLook().finally(() => router.push('/settings/board-look/custom'));
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

  const overriddenCount = useMemo(() => countHoldMarkerOverrides(markerOverrides), [markerOverrides]);

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
      withSettingTracking(
        buildBoardLookModel({
          carousel,
          carouselHeight: boardLookCardHeight(fontScale),
          matchingOptionId,
          currentLookLabel,
          overriddenCount,
          boardseshRendererAvailable,
          requestedMode,
          t,
          onOpenCustomLook: () => router.push('/settings/board-look/custom'),
          onOpenAccessibility: () => router.push('/settings/board-look/accessibility'),
          suggestion,
          onApplySuggestion: () => suggestion && settleSuggestion(suggestion.id, true),
          onDismissSuggestion: () => suggestion && settleSuggestion(suggestion.id, false),
          sprayWalls,
          moonboardGridLabels,
          lightingSections,
        }),
        'board',
      ),
    [
      carousel,
      matchingOptionId,
      currentLookLabel,
      overriddenCount,
      boardseshRendererAvailable,
      requestedMode,
      fontScale,
      t,
      suggestion,
      settleSuggestion,
      sprayWalls,
      moonboardGridLabels,
      lightingSections,
    ],
  );

  // Compose RNHostView custom rows can measure correctly without drawing.
  // Keep preview content in the RN tree on Android.
  return Platform.OS === 'android' ? <MoreFormRN model={model} /> : <MoreForm model={model} />;
}
