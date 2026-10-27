import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { Text } from '../Text';
import type { PlayerButtonsPreviewBoard } from '../player-buttons/PlayerButtonsPreview';
import type { MiniPlayerButtonId, MiniPlayerButtonsLayout } from '../../lib/mini-player-buttons';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import {
  ACCESSORY_GROUP_GAP,
  ACCESSORY_LABEL_TRAILING_PADDING,
  ACCESSORY_LEADING_INSET,
  ACCESSORY_PLATTER_THUMBNAIL_SIZE,
  ACCESSORY_THUMBNAIL_GAP,
  ACCESSORY_TRAILING_INSET,
  miniPlayerSlotCount,
  resolveMiniPlayerControls,
  type MiniPlayerControls,
} from './mini-player-controls';

/** Tall enough for both bars and their captions; fixed so a native form can host it. */
export const MINI_PLAYER_PREVIEW_HEIGHT = 124;

/**
 * The widths the preview stands for: a 375pt iPhone's 343pt bar, and an iPad in
 * portrait. The slot counts come from the real `miniPlayerSlotCount`.
 */
export const PREVIEW_PHONE_ROW_WIDTH = 343;
export const PREVIEW_WIDE_ROW_WIDTH = 995;
const WIDTH_BESIDE_NAME =
  ACCESSORY_LEADING_INSET +
  ACCESSORY_PLATTER_THUMBNAIL_SIZE +
  ACCESSORY_THUMBNAIL_GAP +
  ACCESSORY_LABEL_TRAILING_PADDING +
  ACCESSORY_TRAILING_INSET;

const BUTTON_ICONS: Record<MiniPlayerButtonId, IconName> = {
  next: 'skip.next',
  previous: 'skip.previous',
  mirror: 'mirror',
  favorite: 'favorite',
  queue: 'queue',
  share: 'share',
  angle: 'angle',
};
const TRANSPORT: readonly MiniPlayerButtonId[] = ['previous', 'next'];
const ICON_SIZE = 18;

type MiniPlayerButtonsPreviewProps = {
  buttons: MiniPlayerButtonsLayout;
  board: PlayerButtonsPreviewBoard;
  /** An iPad or an open Duo: the bar holds every button that is on. Otherwise an iPhone's three slots. */
  wide: boolean;
};

/**
 * The bar the way the climber set it up: open on this device, and collapsed.
 * Resolved through the same `resolveMiniPlayerControls` the real bar uses, so
 * the drawing can't disagree with it. Static glyphs only: nothing here is a
 * button and no Bluetooth component is mounted. Screen readers hear one
 * sentence per bar.
 */
export const MiniPlayerButtonsPreview = memo(function MiniPlayerButtonsPreview({
  buttons,
  board,
  wide,
}: MiniPlayerButtonsPreviewProps) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();

  const resolve = useMemo(() => {
    const isAvailable = (buttonId: MiniPlayerButtonId): boolean => {
      if (buttonId === 'mirror') return board.supportsMirroring;
      if (buttonId === 'angle') return board.angleAvailable;
      return true;
    };
    return (slotCount: number): MiniPlayerControls =>
      resolveMiniPlayerControls({
        slotCount,
        layout: buttons,
        isAvailable,
        singleSlotShowsBulb: board.showLightbulb,
        playerPaneShowsTransport: false,
      });
  }, [buttons, board.supportsMirroring, board.angleAvailable, board.showLightbulb]);
  // The real bar's slot rule at a representative width. The group gap is wide-only, as on the bar.
  const groupGap = wide ? ACCESSORY_GROUP_GAP : 0;
  const slotCountAt = useCallback(
    (placement: 'regular' | 'inline') =>
      miniPlayerSlotCount({
        placement,
        rowWidth: wide ? PREVIEW_WIDE_ROW_WIDTH : PREVIEW_PHONE_ROW_WIDTH,
        widthBesideName: WIDTH_BESIDE_NAME,
        wide,
        groupGap,
      }),
    [wide, groupGap],
  );
  const openControls = useMemo(() => resolve(slotCountAt('regular')), [resolve, slotCountAt]);
  const collapsedControls = useMemo(() => resolve(slotCountAt('inline')), [resolve, slotCountAt]);

  const buttonLabel = (buttonId: MiniPlayerButtonId): string =>
    buttonId === 'next' || buttonId === 'previous'
      ? t(`mobile.settings.miniPlayer.buttons.${buttonId}`)
      : t(`mobile.settings.playerButtons.buttons.${buttonId}`);
  const spoken = (controls: MiniPlayerControls): string =>
    [
      ...controls.leading.map(buttonLabel),
      ...controls.trailing.map((slot) =>
        slot === 'lightbulb'
          ? t('mobile.settings.playerButtons.fixed.boardLight')
          : t('mobile.settings.playerButtons.fixed.log'),
      ),
    ].join(', ');
  const barLabel = (shape: string, controls: MiniPlayerControls) =>
    t('mobile.settings.miniPlayer.previewLabel', { shape, buttons: spoken(controls) });

  const openCaption = t('mobile.settings.miniPlayer.open');
  const collapsedCaption = t('mobile.settings.miniPlayer.collapsed');
  const openShape = t('mobile.settings.miniPlayer.shapeOpen');
  const collapsedShape = t('mobile.settings.miniPlayer.shapeCollapsed');

  const glyph = (name: IconName, color: ColorValue) => (
    <View style={styles.slot}>
      <Icon maxFontSizeMultiplier={1} name={name} size={ICON_SIZE} color={color} />
    </View>
  );
  const bar = (caption: string, shape: string, controls: MiniPlayerControls, testID: string) => {
    const others = controls.leading.filter((buttonId) => !TRANSPORT.includes(buttonId));
    const transport = controls.leading.filter((buttonId) => TRANSPORT.includes(buttonId));
    const groups = [
      { key: 'others', slots: others.map((buttonId) => glyph(BUTTON_ICONS[buttonId], systemColors.label)) },
      { key: 'transport', slots: transport.map((buttonId) => glyph(BUTTON_ICONS[buttonId], systemColors.label)) },
      {
        key: 'trailing',
        slots: controls.trailing.map((slot) =>
          slot === 'lightbulb' ? glyph('lightbulb', systemColors.label) : glyph('tick.outline', brandColors.success),
        ),
      },
    ];
    return (
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={barLabel(shape, controls)}
        testID={testID}
        style={styles.barBlock}
      >
        <Text variant="caption2" color={systemColors.secondaryLabel} maxFontSizeMultiplier={1}>
          {caption}
        </Text>
        <View style={[styles.bar, { backgroundColor: systemColors.tertiaryFill }]}>
          <View style={[styles.thumbnail, { backgroundColor: systemColors.secondaryBackground }]} />
          <View style={[styles.name, { backgroundColor: systemColors.secondaryBackground }]} />
          {groups
            .filter((group) => group.slots.length > 0)
            .map((group, index) => (
              <View key={group.key} style={[styles.group, index > 0 ? { marginStart: groupGap } : null]}>
                {group.slots}
              </View>
            ))}
        </View>
      </View>
    );
  };

  return (
    <View
      testID="mini-player-buttons-preview"
      style={[styles.frame, { backgroundColor: systemColors.secondaryBackground }]}
    >
      {bar(openCaption, openShape, openControls, 'mini-player-preview-open')}
      {bar(collapsedCaption, collapsedShape, collapsedControls, 'mini-player-preview-collapsed')}
    </View>
  );
});

const styles = StyleSheet.create({
  frame: {
    height: MINI_PLAYER_PREVIEW_HEIGHT,
    borderRadius: borderRadius.lg,
    padding: spacing[2],
    gap: spacing[2],
    overflow: 'hidden',
  },
  barBlock: {
    gap: 2,
  },
  bar: {
    height: 36,
    borderRadius: 18,
    paddingHorizontal: spacing[2],
    flexDirection: 'row',
    alignItems: 'center',
  },
  thumbnail: {
    marginEnd: spacing[2],
    width: 24,
    height: 24,
    borderRadius: borderRadius.sm,
  },
  name: {
    flex: 1,
    marginEnd: spacing[2],
    height: 8,
    borderRadius: 4,
  },
  // Slots inside a group touch; the gap is between groups, as on the real bar.
  group: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  slot: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
