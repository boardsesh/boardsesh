import { memo, useCallback, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { QueueAddPlacement } from '@boardsesh/queue';
import { ListRow } from '../ListRow';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type PlaylistAddToQueueRowProps = {
  /** Put the whole playlist at the top (`'next'`) or the bottom (`'end'`) of Up next. */
  onQueue: (placement: QueueAddPlacement) => void;
  /** Which of the two is in flight (board-scoped fetch + add), or null when idle. */
  pendingPlacement: QueueAddPlacement | null;
  /**
   * How many climbs a filtered playlist would add ("Play 12 next"). Left out
   * for the whole playlist, which keeps the plain "Play next" / "Play last".
   */
  count?: number;
};

/**
 * The playlist detail screen's additive bulk-queue controls: Play next puts every
 * climb in this playlist at the top of Up next, Play last at the bottom, both in
 * list order and without touching the current climb (#6772). The two names say
 * where the list lands, the way a music app does: "Add to queue" alone left a
 * climber with a long queue never reaching the list they had just added.
 *
 * Labelled rows in the list header rather than controls on the bottom bar,
 * because that is the one surface reaching both platform branches, smart AND
 * owned playlists, and non-owners — the overflow menu is `isOwner`-gated and
 * smart playlists render no menu at all. They sit directly above
 * `PlaylistDiscussionRow`, which is the same shape (a `ListRow` in
 * `ListHeaderComponent`).
 *
 * Glyphs and tokens are the climb menu's own Play next / Play last marks, so the
 * same action reads the same wherever it appears.
 */
export const PlaylistAddToQueueRow = memo(function PlaylistAddToQueueRow({
  onQueue,
  pendingPlacement,
  count,
}: PlaylistAddToQueueRowProps) {
  const { t } = useTranslation('playlists');
  const { actionColors } = useTheme();
  const playNextTitle =
    count === undefined ? t('detail.addToQueue.playNextAction') : t('detail.addToQueue.playNextActionCount', { count });
  const playLastTitle =
    count === undefined ? t('detail.addToQueue.action') : t('detail.addToQueue.actionCount', { count });
  const handlePlayNext = useCallback(() => onQueue('next'), [onQueue]);
  const handlePlayLast = useCallback(() => onQueue('end'), [onQueue]);
  const isBlocked = pendingPlacement !== null;

  return (
    <View style={styles.container}>
      <PlacementRow
        title={playNextTitle}
        subtitle={t('detail.addToQueue.playNextSubtitle')}
        icon={<Icon name="queue.next" size={22} color={actionColors.accent} />}
        onPress={handlePlayNext}
        isPending={pendingPlacement === 'next'}
        isBlocked={isBlocked}
        showSeparator
      />
      <PlacementRow
        title={playLastTitle}
        subtitle={t('detail.addToQueue.subtitle')}
        icon={<Icon name="queue.last" size={22} color={actionColors.success} />}
        onPress={handlePlayLast}
        isPending={pendingPlacement === 'end'}
        isBlocked={isBlocked}
        showSeparator={false}
      />
    </View>
  );
});

type PlacementRowProps = {
  title: string;
  subtitle: string;
  icon: ReactNode;
  onPress: () => void;
  /** This row's add is in flight: it shows the spinner and reads as busy. */
  isPending: boolean;
  /** Either add is in flight. The hook lands one list at a time, so both rows swallow a tap. */
  isBlocked: boolean;
  showSeparator: boolean;
};

function PlacementRow({ title, subtitle, icon, onPress, isPending, isBlocked, showSeparator }: PlacementRowProps) {
  const { systemColors } = useTheme();
  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      leading={icon}
      trailing={
        isPending ? (
          // Sized into the trailing slot so the row height doesn't change
          // mid-add — no reflow of the list under the climber's thumb. It is
          // progress, not a control, so it never becomes its own focus stop.
          <View style={styles.spinner} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <ActivityIndicator size="small" color={systemColors.secondaryLabel} />
          </View>
        ) : undefined
      }
      showChevron={false}
      showSeparator={showSeparator}
      // `ListRow` has no `disabled` prop, so a tap while an add is in flight is
      // swallowed here. The hook guards re-entrancy too; this keeps the haptic
      // from firing on a tap that does nothing.
      onPress={isBlocked ? noop : onPress}
      haptic={!isBlocked}
      accessibilityState={isPending ? BUSY_STATE : isBlocked ? DISABLED_STATE : undefined}
      accessibilityLabel={title}
      accessibilityHint={subtitle}
    />
  );
}

const BUSY_STATE = { busy: true, disabled: true } as const;
const DISABLED_STATE = { disabled: true } as const;

function noop() {}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing[2], paddingBottom: spacing[2] },
  // Fixed width so the trailing slot reserves the same space whether or not the
  // indicator is there — the label column never shifts mid-add.
  spinner: { width: 20, alignItems: 'center', justifyContent: 'center' },
});
