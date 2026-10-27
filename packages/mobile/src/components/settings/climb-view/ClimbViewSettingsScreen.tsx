import { useMemo } from 'react';
import { Platform } from 'react-native';
import { boardSupportsMirroring } from '@boardsesh/play-view';
import { MoreForm } from '../../MoreForm';
import { MoreFormRN } from '../../MoreForm.rn';
import {
  FALLBACK_PREVIEW_BOARD,
  PLAYER_BUTTONS_PREVIEW_HEIGHT,
  PlayerButtonsPreview,
  type PlayerButtonsPreviewBoard,
} from '../../player-buttons/PlayerButtonsPreview';
import { useActiveBoard } from '../../../lib/graphql/use-active-board';
import { hapticSelection } from '../../../lib/haptics';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { usePlayDrawerSectionControls } from '../use-play-drawer-section-controls';
import { useMiniPlayerButtonControls } from '../use-mini-player-button-controls';
import { usePlayerButtonControls } from '../use-player-button-controls';
import { buildClimbViewModel } from './climb-view-model';

export function ClimbViewSettingsScreen() {
  const { settingsSection: belowTheClimb } = usePlayDrawerSectionControls();
  const playerButtons = usePlayerButtonControls();
  const {
    title: miniPlayerTitle,
    settingsFooter: miniPlayerSettingsFooter,
    controls: miniPlayerControls,
    onVisibleChange: onMiniPlayerVisibleChange,
    restoreDefaultsLabel: miniPlayerRestoreLabel,
    canRestoreDefaults: canRestoreMiniPlayer,
    restoreDefaults: restoreMiniPlayer,
  } = useMiniPlayerButtonControls();
  // The preview draws the bar for the board the climber has picked: Mirror only
  // where it mirrors, the angle pill only where the angle can change. Before a
  // board is picked it draws a Kilter-style bar.
  const { data: activeBoard } = useActiveBoard();
  const previewBoard = useMemo<PlayerButtonsPreviewBoard>(
    () =>
      activeBoard
        ? {
            supportsMirroring: boardSupportsMirroring(activeBoard.boardType, activeBoard.layoutId),
            angleAvailable: activeBoard.isAngleAdjustable,
            angle: activeBoard.angle,
            showLightbulb: true,
          }
        : FALLBACK_PREVIEW_BOARD,
    [activeBoard],
  );
  const preview = useMemo(
    () => (
      <PlayerButtonsPreview
        buttons={playerButtons.buttons}
        previousNext={playerButtons.previousNext}
        position={playerButtons.position}
        board={previewBoard}
      />
    ),
    [playerButtons.buttons, playerButtons.previousNext, playerButtons.position, previewBoard],
  );

  const model = useMemo(
    () =>
      withSettingTracking(
        buildClimbViewModel({
          buttons: {
            title: playerButtons.title,
            settingsFooter: playerButtons.settingsFooter,
            positionLabel: playerButtons.positionLabel,
            positionFooter: playerButtons.positionFooter,
            positionOptions: playerButtons.positionOptions,
            position: playerButtons.position,
            onPositionChange: playerButtons.onPositionChange,
            previousNextLabel: playerButtons.previousNextLabel,
            previousNextDescription: playerButtons.previousNextDescription,
            previousNext: playerButtons.previousNext,
            onPreviousNextChange: (enabled) => {
              hapticSelection();
              playerButtons.onPreviousNextChange(enabled);
            },
            wallBadgeLabel: playerButtons.wallBadgeLabel,
            wallBadgeDescription: playerButtons.wallBadgeDescription,
            wallBadge: playerButtons.wallBadge,
            onWallBadgeChange: (enabled) => {
              hapticSelection();
              playerButtons.onWallBadgeChange(enabled);
            },
            controls: playerButtons.controls,
            onVisibleChange: (buttonId, visible) => {
              hapticSelection();
              playerButtons.onVisibleChange(buttonId, visible);
            },
            restoreDefaultsLabel: playerButtons.restoreDefaultsLabel,
            canRestoreDefaults: playerButtons.canRestoreDefaults,
            onRestoreDefaults: playerButtons.restoreDefaults,
            preview,
            previewHeight: PLAYER_BUTTONS_PREVIEW_HEIGHT,
          },
          miniPlayer: {
            title: miniPlayerTitle,
            settingsFooter: miniPlayerSettingsFooter,
            controls: miniPlayerControls,
            onVisibleChange: (buttonId, visible) => {
              hapticSelection();
              onMiniPlayerVisibleChange(buttonId, visible);
            },
            restoreDefaultsLabel: miniPlayerRestoreLabel,
            canRestoreDefaults: canRestoreMiniPlayer,
            onRestoreDefaults: restoreMiniPlayer,
          },
          belowTheClimb,
        }),
        'climbView',
      ),
    [
      playerButtons,
      miniPlayerTitle,
      miniPlayerSettingsFooter,
      miniPlayerControls,
      onMiniPlayerVisibleChange,
      miniPlayerRestoreLabel,
      canRestoreMiniPlayer,
      restoreMiniPlayer,
      preview,
      belowTheClimb,
    ],
  );

  // Compose RNHostView custom rows can measure correctly without drawing.
  // Keep preview content in the RN tree on Android.
  return Platform.OS === 'android' ? <MoreFormRN model={model} /> : <MoreForm model={model} />;
}
