import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { Text } from '../Text';
import { resolveActionBarLayout, type ActionBarSecondaryItem } from '../play-drawer/action-bar-layout';
import type { PlayerButtonId, PlayerButtonsLayout, PlayerButtonsPosition } from '../../lib/player-buttons';
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

const BUTTON_ICONS: Record<Exclude<PlayerButtonId, 'angle'>, IconName> = {
  mirror: 'mirror',
  favorite: 'favorite',
  share: 'share',
  queue: 'queue',
};
const BIG_ICON = 20;
const SMALL_ICON = 16;

type PlayerButtonsPreviewProps = {
  buttons: PlayerButtonsLayout;
  previousNext: boolean;
  position: PlayerButtonsPosition;
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
  board,
}: PlayerButtonsPreviewProps) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const layout = useMemo(
    () =>
      resolveActionBarLayout({
        supportsMirroring: board.supportsMirroring,
        isAnonymous: false,
        connectPill: false,
        inCommitMode: false,
        showLightbulb: board.showLightbulb,
        hasShare: true,
        angleAvailable: board.angleAvailable,
        buttons,
        previousNext,
      }),
    [board.supportsMirroring, board.showLightbulb, board.angleAvailable, buttons, previousNext],
  );
  const secondaryItems = layout.secondaryRow === 'commit' ? [] : layout.secondaryRow;

  const buttonLabel = (buttonId: PlayerButtonId): string => {
    switch (buttonId) {
      case 'mirror':
        return t('mobile.settings.playerButtons.buttons.mirror');
      case 'favorite':
        return t('mobile.settings.playerButtons.buttons.favorite');
      case 'angle':
        return t('mobile.settings.playerButtons.buttons.angle');
      case 'share':
        return t('mobile.settings.playerButtons.buttons.share');
      case 'queue':
        return t('mobile.settings.playerButtons.buttons.queue');
    }
  };
  // Reading order: the big row left to right, then the small row.
  const spokenButtons: string[] = [];
  if (layout.leadingSlot) spokenButtons.push(buttonLabel(layout.leadingSlot));
  if (layout.showPreviousNext) spokenButtons.push(t('mobile.settings.playerButtons.fixed.previous'));
  spokenButtons.push(t('mobile.settings.playerButtons.fixed.log'));
  if (layout.showPreviousNext) spokenButtons.push(t('mobile.settings.playerButtons.fixed.next'));
  if (layout.trailingSlot) spokenButtons.push(t('mobile.settings.playerButtons.fixed.boardLight'));
  for (const item of secondaryItems) {
    if (item !== 'spacer' && item !== 'connectPill') spokenButtons.push(buttonLabel(item));
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
        <View style={styles.bigSlot}>{layout.trailingSlot ? glyph('lightbulb', BIG_ICON) : null}</View>
      </View>
      {secondaryItems.length > 0 ? (
        <View style={styles.smallRow}>
          {secondaryItems.map((item: ActionBarSecondaryItem) => {
            switch (item) {
              case 'spacer':
                return <View key={item} style={styles.spacer} />;
              case 'angle':
                return (
                  <View key={item} style={[styles.anglePill, { borderColor: systemColors.separator }]}>
                    <Text
                      variant="caption2"
                      color={systemColors.secondaryLabel}
                      maxFontSizeMultiplier={1}
                      style={styles.angleText}
                    >
                      {board.angle}°
                    </Text>
                  </View>
                );
              case 'connectPill':
                return null;
              default:
                return (
                  <View key={item} style={styles.smallSlot}>
                    {glyph(BUTTON_ICONS[item], SMALL_ICON)}
                  </View>
                );
            }
          })}
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
  smallSlot: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spacer: {
    flex: 1,
  },
  anglePill: {
    height: 20,
    borderRadius: 10,
    paddingHorizontal: spacing[2],
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  angleText: {
    fontWeight: '600',
  },
});
