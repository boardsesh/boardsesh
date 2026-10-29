import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { Text } from '../Text';
import type { PlayerButtonsPreviewBoard } from '../player-buttons/PlayerButtonsPreview';
import type { MiniPlayerButtonId, MiniPlayerButtonsLayout } from '../../lib/mini-player-buttons';
import { useMeasuredMiniPlayerBar } from '../../lib/mini-player-measured-bar-store';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import {
  TALL_PLATTER_MIN_HEIGHT,
  accessoryPlatterGeometry,
  accessoryWidthBesideName,
  isMiniPlayerButtonAvailable,
  miniPlayerSlotCount,
  miniPlayerUsesWideLayout,
  resolveMiniPlayerControls,
  type MiniPlayerControls,
} from './mini-player-controls';

/** Tall enough for both bars and their captions; fixed so a native form can host it. */
export const MINI_PLAYER_PREVIEW_HEIGHT = 124;

/**
 * The widths the preview stands for before the bar has ever drawn: a 375pt
 * iPhone's 343pt bar, and an iPad in portrait. Once the bar has drawn, the preview
 * uses the width it measured on this device. The slot counts come from the real
 * `miniPlayerSlotCount`.
 */
export const PREVIEW_PHONE_ROW_WIDTH = 343;
export const PREVIEW_WIDE_ROW_WIDTH = 995;
// The row's insets and artwork on an iPhone's 48pt platter and on iPad's taller one.
const PHONE_WIDTH_BESIDE_NAME = accessoryWidthBesideName(accessoryPlatterGeometry(glassSize.standard), true);
const WIDE_WIDTH_BESIDE_NAME = accessoryWidthBesideName(accessoryPlatterGeometry(TALL_PLATTER_MIN_HEIGHT), true);

const BUTTON_ICONS: Record<MiniPlayerButtonId, IconName> = {
  next: 'skip.next',
  previous: 'skip.previous',
  mirror: 'mirror',
  favorite: 'favorite',
  queue: 'queue',
  share: 'share',
  angle: 'angle',
};
// Music's iPad layout draws ⏮ ⏭ filled.
const WIDE_TRANSPORT_ICONS: Partial<Record<MiniPlayerButtonId, IconName>> = {
  next: 'skip.next.fill',
  previous: 'skip.previous.fill',
};
const ICON_SIZE = 18;
// ✓ on a wide bar: the one large filled control, as on the real bar.
const WIDE_LOG_ICON_SIZE = 22;

type MiniPlayerButtonsPreviewProps = {
  buttons: MiniPlayerButtonsLayout;
  board: PlayerButtonsPreviewBoard;
  /** An iPad or an open Duo: the bar holds every button that is on. Otherwise an iPhone's three slots. */
  wide: boolean;
  /** Favorite and Queue need an account; the bar leaves them out when signed out. */
  signedIn: boolean;
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
  signedIn,
}: MiniPlayerButtonsPreviewProps) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const measuredBar = useMeasuredMiniPlayerBar();

  const resolve = useMemo(() => {
    // The bar's own rule. The preview has no session: no timed block, and the climb is not a draft.
    const isAvailable = (buttonId: MiniPlayerButtonId): boolean =>
      isMiniPlayerButtonAvailable(buttonId, {
        inTimedBlock: false,
        mirror: board.supportsMirroring,
        signedIn,
        isDraft: false,
        angleAdjustable: board.angleAvailable,
        playerRouteUp: false,
      });
    return (slotCount: number, placement: 'regular' | 'inline'): MiniPlayerControls =>
      resolveMiniPlayerControls({
        slotCount,
        layout: buttons,
        isAvailable,
        singleSlotShowsBulb: board.showLightbulb,
        bulbAvailable: board.showLightbulb,
        paneMode: 'none',
        workoutOutcome: false,
        wideLayout: miniPlayerUsesWideLayout({ wide, placement }),
        moreAvailable: true,
      });
  }, [buttons, board.supportsMirroring, board.angleAvailable, board.showLightbulb, signedIn, wide]);
  // The real bar's slot rule at the width the bar measured on this device, or a representative one before it has drawn.
  const slotCountAt = useCallback(
    (placement: 'regular' | 'inline') =>
      miniPlayerSlotCount({
        placement,
        rowWidth: measuredBar?.rowWidth ?? (wide ? PREVIEW_WIDE_ROW_WIDTH : PREVIEW_PHONE_ROW_WIDTH),
        widthBesideName: measuredBar?.widthBesideName ?? (wide ? WIDE_WIDTH_BESIDE_NAME : PHONE_WIDTH_BESIDE_NAME),
        wide,
      }),
    [wide, measuredBar],
  );
  const openControls = useMemo(() => resolve(slotCountAt('regular'), 'regular'), [resolve, slotCountAt]);
  const collapsedControls = useMemo(() => resolve(slotCountAt('inline'), 'inline'), [resolve, slotCountAt]);
  const openWideLayout = miniPlayerUsesWideLayout({ wide, placement: 'regular' });

  const buttonLabel = (buttonId: MiniPlayerButtonId): string =>
    buttonId === 'next' || buttonId === 'previous'
      ? t(`mobile.settings.miniPlayer.buttons.${buttonId}`)
      : t(`mobile.settings.playerButtons.buttons.${buttonId}`);
  const spoken = (controls: MiniPlayerControls): string =>
    [
      ...controls.leading.map(buttonLabel),
      ...(controls.more ? [t('mobile.settings.miniPlayer.more')] : []),
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

  const glyph = (key: string, name: IconName, color: ColorValue, size = ICON_SIZE) => (
    <View key={key} style={styles.slot}>
      <Icon maxFontSizeMultiplier={1} name={name} size={size} color={color} />
    </View>
  );
  /**
   * The resolver already orders `leading`: on a wide bar ⏮ ⏭ first and the
   * whole cluster before the climb, as the real bar draws it (Music's iPad
   * layout); elsewhere after the climb.
   */
  const bar = (caption: string, shape: string, controls: MiniPlayerControls, wideLayout: boolean, testID: string) => {
    const buttonGlyphs = controls.leading.map((buttonId) => {
      const transportIcon = wideLayout ? WIDE_TRANSPORT_ICONS[buttonId] : undefined;
      if (transportIcon) return glyph(buttonId, transportIcon, systemColors.label);
      return glyph(buttonId, BUTTON_ICONS[buttonId], wideLayout ? systemColors.secondaryLabel : systemColors.label);
    });
    const trailingGlyphs = [
      ...(controls.more ? [glyph('more', 'more', systemColors.label)] : []),
      ...controls.trailing.map((slot) =>
        slot === 'lightbulb'
          ? glyph(slot, 'lightbulb', systemColors.label)
          : wideLayout
            ? glyph(slot, 'checkmark.circle.fill', brandColors.primary, WIDE_LOG_ICON_SIZE)
            : glyph(slot, 'tick.outline', brandColors.success),
      ),
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
          {wideLayout ? buttonGlyphs : null}
          <View
            style={[
              styles.thumbnail,
              wideLayout ? styles.thumbnailAfterButtons : null,
              { backgroundColor: systemColors.secondaryBackground },
            ]}
          />
          <View style={[styles.name, { backgroundColor: systemColors.secondaryBackground }]} />
          {wideLayout ? null : buttonGlyphs}
          {trailingGlyphs}
        </View>
      </View>
    );
  };

  return (
    <View
      testID="mini-player-buttons-preview"
      style={[styles.frame, { backgroundColor: systemColors.secondaryBackground }]}
    >
      {bar(openCaption, openShape, openControls, openWideLayout, 'mini-player-preview-open')}
      {bar(collapsedCaption, collapsedShape, collapsedControls, false, 'mini-player-preview-collapsed')}
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
  thumbnailAfterButtons: {
    marginStart: spacing[1],
  },
  name: {
    flex: 1,
    marginEnd: spacing[2],
    height: 8,
    borderRadius: 4,
  },
  slot: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
