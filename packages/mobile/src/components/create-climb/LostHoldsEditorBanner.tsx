import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { overlays, spacing, borderRadius } from '../../theme/tokens';
import type { LostHoldsStatus } from './use-lost-hold-ghosts';

type LostHoldsEditorBannerProps = {
  status: LostHoldsStatus;
  /** Lost holds still unanswered. Nothing renders at 0. */
  count: number;
  /** True while the climber is picking a replacement on the board. */
  replacing: boolean;
  /** The last pick was refused because that role is already full. */
  roleFull: boolean;
  /** Tapping the banner opens the first ghost's sheet (a small ring is hard to hit). */
  onOpenFirstGhost: () => void;
  onCancelReplacing: () => void;
};

/**
 * The create editor's word on lost holds (#5493), floated over the top of the
 * board rather than placed above it.
 *
 * Floated on purpose: the drawer's peek height is measured from the blocks
 * above the fold, and a banner that mounts there (and unmounts the moment the
 * last ghost is answered) would re-snap the sheet under the climber's thumb.
 * Over the board it costs no layout at all. The board pans and zooms under it.
 */
export const LostHoldsEditorBanner = React.memo(function LostHoldsEditorBanner({
  status,
  count,
  replacing,
  roleFull,
  onOpenFirstGhost,
  onCancelReplacing,
}: LostHoldsEditorBannerProps) {
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');

  if (replacing) {
    return (
      <View style={styles.banner} accessibilityLiveRegion="polite" testID="lost-holds-editor-banner">
        <Icon name="hand.tap" size={16} color={overlays.onScrim} />
        <Text variant="footnote" color={overlays.onScrim} style={styles.copy}>
          {roleFull ? t('mobile.lostHolds.editor.roleFull') : t('mobile.lostHolds.editor.pickNearby')}
        </Text>
        <Pressable
          onPress={onCancelReplacing}
          accessibilityRole="button"
          hitSlop={spacing[2]}
          testID="lost-holds-editor-cancel"
        >
          <Text variant="footnote" color={overlays.onScrim} style={styles.action}>
            {tCommon('actions.cancel')}
          </Text>
        </Pressable>
      </View>
    );
  }

  if (status === 'none' || !(count > 0)) return null;

  const message =
    status === 'ready'
      ? t('mobile.lostHolds.editor.tapGhost', { count })
      : status === 'unavailable'
        ? t('mobile.lostHolds.editor.offline', { count })
        : t('mobile.lostHolds.banner', { count });

  return (
    <Pressable
      style={styles.banner}
      onPress={status === 'ready' ? onOpenFirstGhost : undefined}
      disabled={status !== 'ready'}
      accessibilityRole={status === 'ready' ? 'button' : 'text'}
      accessibilityLabel={message}
      testID="lost-holds-editor-banner"
    >
      <Icon name="frame.remove" size={16} color={overlays.onScrim} />
      <Text variant="footnote" color={overlays.onScrim} style={styles.copy}>
        {message}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: spacing[2],
    left: spacing[2],
    right: spacing[2],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.lg,
    backgroundColor: overlays.scrim,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  action: {
    fontWeight: '600',
  },
});
