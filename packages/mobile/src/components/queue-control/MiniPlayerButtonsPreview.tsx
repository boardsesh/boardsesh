import { memo, useMemo } from 'react';
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
  PHONE_MINI_PLAYER_MAX_SLOTS,
  resolveMiniPlayerControls,
  type MiniPlayerControls,
} from './mini-player-controls';

/** Tall enough for both bars and their captions; fixed so a native form can host it. */
export const MINI_PLAYER_PREVIEW_HEIGHT = 124;

/** More slots than there are buttons: "every button fits", as on an iPad. */
const WIDE_SLOT_COUNT = 9;
const INLINE_SLOT_COUNT = 1;

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
  const openControls = useMemo(() => resolve(wide ? WIDE_SLOT_COUNT : PHONE_MINI_PLAYER_MAX_SLOTS), [resolve, wide]);
  const collapsedControls = useMemo(() => resolve(INLINE_SLOT_COUNT), [resolve]);

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

  const glyph = (name: IconName, color: ColorValue) => (
    <View style={styles.slot}>
      <Icon maxFontSizeMultiplier={1} name={name} size={ICON_SIZE} color={color} />
    </View>
  );
  const bar = (caption: string, controls: MiniPlayerControls, testID: string) => {
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
        accessibilityLabel={barLabel(caption, controls)}
        testID={testID}
        style={styles.barBlock}
      >
        <Text variant="caption2" color={systemColors.secondaryLabel} maxFontSizeMultiplier={1}>
          {caption}
        </Text>
        <View style={[styles.bar, { backgroundColor: systemColors.tertiaryFill }]}>
          <View style={[styles.thumbnail, { backgroundColor: systemColors.secondaryBackground }]} />
          <View style={[styles.name, { backgroundColor: systemColors.secondaryBackground }]} />
          {groups.map((group) =>
            group.slots.length > 0 ? (
              <View key={group.key} style={styles.group}>
                {group.slots}
              </View>
            ) : null,
          )}
        </View>
      </View>
    );
  };

  return (
    <View
      testID="mini-player-buttons-preview"
      style={[styles.frame, { backgroundColor: systemColors.secondaryBackground }]}
    >
      {bar(openCaption, openControls, 'mini-player-preview-open')}
      {bar(collapsedCaption, collapsedControls, 'mini-player-preview-collapsed')}
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
    gap: spacing[2],
  },
  thumbnail: {
    width: 24,
    height: 24,
    borderRadius: borderRadius.sm,
  },
  name: {
    flex: 1,
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
