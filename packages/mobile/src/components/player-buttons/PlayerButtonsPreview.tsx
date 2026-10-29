import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { resolveActionBarLayout } from '../play-drawer/action-bar-layout';
import type {
  PlayerBoardControl,
  PlayerButtonId,
  PlayerButtonsLayout,
  PlayerButtonsPosition,
} from '../../lib/player-buttons';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

/** What the preview needs to know about the board it stands for. */
export type PlayerButtonsPreviewBoard = {
  supportsMirroring: boolean;
  /** The board's angle can change, so the angle pill shows. */
  angleAvailable: boolean;
  angle: number;
  /** A Bluetooth transport exists, so Board light shows. */
  showLightbulb: boolean;
};

/** A Kilter-style board at 40°, for Settings before a board is picked. */
export const FALLBACK_PREVIEW_BOARD: PlayerButtonsPreviewBoard = Object.freeze({
  supportsMirroring: false,
  angleAvailable: true,
  angle: 40,
  showLightbulb: true,
});

/** Fixed, so the native Settings form can host it (`MoreCustomRow` needs a height). */
export const PLAYER_BUTTONS_PREVIEW_HEIGHT = 132;

const BUTTON_ICONS: Record<PlayerButtonId, IconName> = {
  mirror: 'mirror',
  favorite: 'favorite',
  queue: 'queue',
  share: 'share',
  angle: 'angle',
};
const BIG_ICON = 20;
const SMALL_ICON = 16;

type PlayerButtonsPreviewProps = {
  buttons: PlayerButtonsLayout;
  previousNext: boolean;
  position: PlayerButtonsPosition;
  /** The wall button under the top row, or the bulb in its last slot. */
  boardControl?: PlayerBoardControl;
  board: PlayerButtonsPreviewBoard;
};

/**
 * A small, static drawing of the player's bar as the climber has set it up,
 * with the board above or below it. Resolved through the same
 * `resolveActionBarLayout` the player uses, so it can't drift from the real
 * bar. Plain icons only: nothing here is a button, and no Bluetooth component
 * is mounted. Screen readers hear one sentence for the whole drawing.
 */
export const PlayerButtonsPreview = memo(function PlayerButtonsPreview({
  buttons,
  previousNext,
  position,
  boardControl = 'wallButton',
  board,
}: PlayerButtonsPreviewProps) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const layout = useMemo(
    () =>
      resolveActionBarLayout({
        supportsMirroring: board.supportsMirroring,
        isAnonymous: false,
        commitButton: null,
        workoutOutcome: false,
        showLightbulb: board.showLightbulb,
        hasWall: board.showLightbulb,
        hasShare: true,
        angleAvailable: board.angleAvailable,
        buttons,
        previousNext,
        boardControl,
      }),
    [board.supportsMirroring, board.showLightbulb, board.angleAvailable, buttons, previousNext, boardControl],
  );

  const buttonLabel = (buttonId: PlayerButtonId): string => {
    switch (buttonId) {
      case 'mirror':
        return t('mobile.settings.playerButtons.buttons.mirror');
      case 'favorite':
        return t('mobile.settings.playerButtons.buttons.favorite');
      case 'queue':
        return t('mobile.settings.playerButtons.buttons.queue');
      case 'share':
        return t('mobile.settings.playerButtons.buttons.share');
      case 'angle':
        return t('mobile.settings.playerButtons.buttons.angle');
    }
  };
  // Reading order: the big row left to right, then the wall button under it.
  const spokenButtons: string[] = [];
  if (layout.leadingSlot) spokenButtons.push(buttonLabel(layout.leadingSlot));
  if (layout.showPreviousNext) spokenButtons.push(t('mobile.settings.playerButtons.fixed.previous'));
  spokenButtons.push(t('mobile.settings.playerButtons.fixed.log'));
  if (layout.showPreviousNext) spokenButtons.push(t('mobile.settings.playerButtons.fixed.next'));
  if (layout.trailingSlot === 'lightbulb') spokenButtons.push(t('mobile.settings.playerButtons.fixed.boardLight'));
  else if (layout.trailingSlot) spokenButtons.push(buttonLabel(layout.trailingSlot));
  const smallRow = typeof layout.secondaryRow === 'string' ? [] : layout.secondaryRow;
  for (const item of smallRow) {
    if (item === 'wallControl') spokenButtons.push(t('mobile.settings.playerButtons.fixed.boardLight'));
    else if (item !== 'spacer') spokenButtons.push(buttonLabel(item));
  }
  const summary = t('mobile.settings.playerButtons.previewLabel', {
    position:
      position === 'above'
        ? t('mobile.settings.playerButtons.position.above')
        : t('mobile.settings.playerButtons.position.below'),
    buttons: spokenButtons.join(', '),
  });

  const glyph = (name: IconName, size: number) => (
    <Icon maxFontSizeMultiplier={1} name={name} size={size} color={systemColors.label} />
  );
  const bar = (
    <View style={styles.bar}>
      <View style={styles.bigRow}>
        <View style={styles.bigSlot}>
          {layout.leadingSlot ? glyph(BUTTON_ICONS[layout.leadingSlot], BIG_ICON) : null}
        </View>
        <View style={styles.bigSlot}>{layout.showPreviousNext ? glyph('skip.previous', BIG_ICON) : null}</View>
        <View style={styles.bigSlot}>
          <Icon maxFontSizeMultiplier={1} name="tick.outline" size={BIG_ICON + 4} color={brandColors.success} />
        </View>
        <View style={styles.bigSlot}>{layout.showPreviousNext ? glyph('skip.next', BIG_ICON) : null}</View>
        <View style={styles.bigSlot}>
          {layout.trailingSlot === 'lightbulb' ? (
            <Icon maxFontSizeMultiplier={1} name="lightbulb" size={BIG_ICON} color={brandColors.primary} />
          ) : layout.trailingSlot ? (
            glyph(BUTTON_ICONS[layout.trailingSlot], BIG_ICON)
          ) : null}
        </View>
      </View>
      {/* The second row: the wall button as the full-width capsule it is, or with
          the bulb chosen, the other buttons small on either side. It folds away
          with no wall to light. */}
      {smallRow.length > 0 ? (
        <View style={styles.smallRow}>
          {smallRow.map((item, index) =>
            item === 'wallControl' ? (
              <View key={item} style={[styles.wallControl, { backgroundColor: systemColors.tertiaryFill }]}>
                <Icon maxFontSizeMultiplier={1} name="lightbulb" size={SMALL_ICON - 4} color={brandColors.primary} />
              </View>
            ) : item === 'spacer' ? (
              <View key={`spacer-${index}`} style={styles.spacer} />
            ) : (
              <View key={item}>{glyph(BUTTON_ICONS[item], SMALL_ICON)}</View>
            ),
          )}
        </View>
      ) : null}
    </View>
  );

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
      testID="player-buttons-preview"
      style={[styles.frame, { backgroundColor: systemColors.secondaryBackground }]}
    >
      {position === 'above' ? bar : null}
      {/* The board: it grows into whatever the bar leaves, so switching the small row off shows the room it gives back. */}
      <View style={[styles.board, { backgroundColor: systemColors.tertiaryFill }]} />
      {position === 'below' ? bar : null}
    </View>
  );
});

const styles = StyleSheet.create({
  frame: {
    height: PLAYER_BUTTONS_PREVIEW_HEIGHT,
    borderRadius: borderRadius.lg,
    padding: spacing[2],
    gap: spacing[1],
    overflow: 'hidden',
  },
  board: {
    flex: 1,
    borderRadius: borderRadius.md,
  },
  bar: {
    gap: spacing[1],
  },
  bigRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 32,
  },
  bigSlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    height: 24,
    paddingHorizontal: spacing[2],
  },
  spacer: {
    flex: 1,
  },
  wallControl: {
    flex: 1,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
