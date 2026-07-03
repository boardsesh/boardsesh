import { useCallback, useMemo, useRef, type ComponentRef } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import { parseTickTime } from '@boardsesh/profile-stats';
import { displayedAttemptCount, normalizeLogbookQuality } from '@boardsesh/logbook';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { hapticSelection } from '../../lib/haptics';

type LogbookEntryChooserSheetProps = {
  /** The grouped day's entries, newest first. Always length > 1 (a single-entry
   *  row acts directly and never opens the chooser). */
  entries: AscentFeedItem[];
  /** What the pick routes to — worded in the title so the climber knows what
   *  tapping an entry will do. */
  intent: 'edit' | 'delete';
  onPick: (entry: AscentFeedItem) => void;
  onDismiss: () => void;
};

const STATUS_ICON: Record<AscentFeedItem['status'], IconName> = {
  flash: 'flash',
  send: 'tick.outline',
  attempt: 'circle',
};

/**
 * Day-entries chooser for a grouped logbook row: swipe-edit or swipe-delete on
 * a row that collapses several same-day entries must act on ONE tick, so the
 * climber picks which. There is deliberately no act-on-all option — DELETE is
 * a real server-side, Aurora-synced mutation and never fans out from one
 * gesture (PR #3350 thread).
 */
export function LogbookEntryChooserSheet({ entries, intent, onPick, onDismiss }: LogbookEntryChooserSheetProps) {
  const { t, i18n } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<ComponentRef<typeof BottomSheetModal>>(null);
  const managed = useManagedSheet({ open: true, sheetRef, onClose: onDismiss });
  const snapPoints = useMemo(() => androidSafeSnapPoints(['45%']), []);

  const handlePick = useCallback(
    (entry: AscentFeedItem) => {
      hapticSelection();
      onPick(entry);
    },
    [onPick],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose
      onChange={managed.onChange}
      handleIndicatorStyle={{ backgroundColor: systemColors.tertiaryLabel }}
      backgroundStyle={{ backgroundColor: systemColors.background }}
    >
      <BottomSheetScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing[6] }]}>
        <Text variant="headline" style={styles.title}>
          {intent === 'delete' ? t('mobile.logbook.chooser.deleteTitle') : t('mobile.logbook.chooser.editTitle')}
        </Text>
        {entries.map((entry) => {
          const statusColor =
            entry.status === 'flash'
              ? brandColors.warning
              : entry.status === 'send'
                ? brandColors.success
                : iosSystemColors.systemGray;
          const quality = normalizeLogbookQuality(entry.quality);
          const timeLabel = parseTickTime(entry.climbedAt)
            .toDate()
            .toLocaleTimeString(i18n.language, { hour: 'numeric', minute: '2-digit' });
          const meta = [
            t('mobile.logbook.tries', { count: displayedAttemptCount(entry.attemptCount) }),
            quality != null ? t('mobile.logbook.row.stars', { count: quality }) : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <Pressable
              key={entry.uuid}
              onPress={() => handlePick(entry)}
              accessibilityRole="button"
              accessibilityLabel={`${timeLabel}, ${meta}`}
              style={({ pressed }) => [
                styles.entryRow,
                { backgroundColor: systemColors.secondaryBackground },
                pressed && styles.entryRowPressed,
              ]}
            >
              <Icon name={STATUS_ICON[entry.status]} size={20} color={statusColor} />
              <View style={styles.entryText}>
                <Text variant="body" style={styles.entryTime}>
                  {timeLabel}
                </Text>
                <Text variant="footnote" color={systemColors.secondaryLabel}>
                  {meta}
                </Text>
              </View>
              <Icon
                name={intent === 'delete' ? 'delete' : 'edit'}
                size={18}
                color={intent === 'delete' ? brandColors.error : systemColors.secondaryLabel}
              />
            </Pressable>
          );
        })}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  title: {
    marginBottom: spacing[2],
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.md,
    minHeight: 44,
  },
  entryRowPressed: { opacity: 0.7 },
  entryText: {
    flex: 1,
    minWidth: 0,
  },
  entryTime: {
    fontWeight: '600',
  },
});
