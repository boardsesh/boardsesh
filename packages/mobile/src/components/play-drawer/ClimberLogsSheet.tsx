// Every climber the viewer follows who logged this climb, opened from the
// "Climber logs" card's "See all logs" row. The card is capped at four rows (it
// lives in the play drawer's plain ScrollView); this sheet holds the rest in a
// virtualised list, with three chips to narrow it.
//
// Driven by a controlled `visible` prop and mounted INSIDE PlayDrawer, so the
// ModalSheet coordinator presents it above the `/play` modal. A root-level
// sheet would land underneath it.
import { useCallback, useMemo, useRef, useState, type ComponentType } from 'react';
import { StyleSheet, View, type FlatListProps } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { ClimberLogEarlierRow, ClimberLogRow } from './ClimberLogRow';
import {
  buildClimberLogListItems,
  deriveCrewCounts,
  filterClimberLogs,
  followingSectionCount,
  groupClimberLogs,
  rankClimberLogGroups,
  type ClimberLogFilters,
  type ClimberLogListItem,
  type ClimberLogNotice,
} from './climber-logs';
import { useFollowingClimbLogs } from '../../lib/graphql/hooks/use-following-climb-logs';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

type ClimberLogsSheetProps = {
  visible: boolean;
  climb: Climb | null;
  boardName: string;
  /** The angle the board is set to. */
  angle: number;
  onClose: () => void;
  /** Called once the sheet has finished closing after a row tap. */
  onOpenProfile: (userId: string) => void;
};

// The bottom-sheet-aware list scrolls within the native sheet detent (its
// virtualization plugs into the sheet's gesture handling).
const SheetFlatList = BottomSheetFlatList as ComponentType<FlatListProps<ClimberLogListItem>>;

const SNAP_POINTS = ['90%'];
const MIN_TARGET = 44;
const CHIP_HEIGHT = 32;
const NO_EXPANDED: ReadonlySet<string> = new Set();

function keyExtractor(item: ClimberLogListItem): string {
  return item.key;
}

type FilterChipProps = { label: string; selected: boolean; onPress: () => void };

function FilterChip({ label, selected, onPress }: FilterChipProps) {
  const { brandColors, systemColors } = useTheme();
  return (
    // The 44 pt target wraps the 32 pt pill, so the chips stay easy to hit
    // without growing taller than the design.
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={styles.chipTarget}
    >
      <View style={[styles.chip, { backgroundColor: selected ? brandColors.primaryFill : systemColors.fill }]}>
        <Text variant="footnote" color={selected ? iosSystemColors.white : systemColors.label} style={styles.chipLabel}>
          {label}
        </Text>
      </View>
    </PressableSurface>
  );
}

export function ClimberLogsSheet({ visible, climb, boardName, angle, onClose, onOpenProfile }: ClimberLogsSheetProps) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { brandColors, systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const climbUuid = climb?.uuid ?? null;

  // Asks only while open. The sheet stays mounted once it has been opened, and
  // a closed sheet must not send a request for every climb the drawer passes.
  // Rows already loaded stay in the result, so they hold while it animates out.
  const query = useFollowingClimbLogs(boardName, climbUuid, { enabled: visible });
  const offline = useOfflineQueryState(query);
  const { data } = query;
  const hasMore = data?.hasMore ?? false;
  const counts = useMemo(() => deriveCrewCounts(data, angle), [data, angle]);

  // Chip and expand state belong to one climb. Tagging them with the uuid
  // resets both on a new climb without an effect, so there is never a frame of
  // the previous climb's choices.
  const [chosen, setChosen] = useState<{ climbUuid: string | null; filters: ClimberLogFilters } | null>(null);
  const [expanded, setExpanded] = useState<{ climbUuid: string | null; userIds: ReadonlySet<string> } | null>(null);
  // Until a chip is touched, "this angle only" follows the data: on when
  // someone followed has logged at the board's angle, off otherwise.
  const angleOnlyDefault = (counts?.climbersAtAngle ?? 0) > 0;
  const filters = useMemo<ClimberLogFilters>(
    () =>
      chosen && chosen.climbUuid === climbUuid
        ? chosen.filters
        : { angleOnly: angleOnlyDefault, withNotes: false, sendsOnly: false },
    [chosen, climbUuid, angleOnlyDefault],
  );
  const expandedUserIds = expanded && expanded.climbUuid === climbUuid ? expanded.userIds : NO_EXPANDED;

  const changeFilters = useCallback(
    (change: (current: ClimberLogFilters) => ClimberLogFilters) => {
      setChosen((previous) => ({
        climbUuid,
        filters: change(
          previous && previous.climbUuid === climbUuid
            ? previous.filters
            : { angleOnly: angleOnlyDefault, withNotes: false, sendsOnly: false },
        ),
      }));
    },
    [climbUuid, angleOnlyDefault],
  );
  const handleToggleAngleOnly = useCallback(
    () => changeFilters((current) => ({ ...current, angleOnly: !current.angleOnly })),
    [changeFilters],
  );
  const handleToggleWithNotes = useCallback(
    () => changeFilters((current) => ({ ...current, withNotes: !current.withNotes })),
    [changeFilters],
  );
  const handleToggleSendsOnly = useCallback(
    () => changeFilters((current) => ({ ...current, sendsOnly: !current.sendsOnly })),
    [changeFilters],
  );
  const handleShowAllAngles = useCallback(
    () => changeFilters((current) => ({ ...current, angleOnly: false })),
    [changeFilters],
  );

  const handleToggleEarlier = useCallback(
    (userId: string) => {
      setExpanded((previous) => {
        const userIds = new Set(previous && previous.climbUuid === climbUuid ? previous.userIds : NO_EXPANDED);
        if (!userIds.delete(userId)) userIds.add(userId);
        return { climbUuid, userIds };
      });
    },
    [climbUuid],
  );

  // A profile pushed while the sheet is still on screen lands under it, so the
  // tap only closes the sheet and the push waits for the dismiss to settle.
  const pendingProfileRef = useRef<string | null>(null);
  const handlePressClimber = useCallback(
    (userId: string) => {
      pendingProfileRef.current = userId;
      onClose();
    },
    [onClose],
  );
  const handleFullyDismissed = useCallback(() => {
    const userId = pendingProfileRef.current;
    pendingProfileRef.current = null;
    if (userId) onOpenProfile(userId);
  }, [onOpenProfile]);

  const logs = data?.items;
  const items = useMemo(() => {
    const groups = rankClimberLogGroups(groupClimberLogs(filterClimberLogs(logs ?? [], angle, filters), angle));
    const notices: ClimberLogNotice[] = [];
    const elsewhere = counts ? counts.climbers - counts.climbersAtAngle : 0;
    if (filters.angleOnly && elsewhere > 0) notices.push({ notice: 'otherAngles', count: elsewhere });
    if (hasMore && groups.length > 0) notices.push({ notice: 'capped', count: 0 });
    return buildClimberLogListItems(
      [{ id: 'following', groups, count: followingSectionCount(counts, filters) }],
      expandedUserIds,
      notices,
    );
  }, [logs, angle, filters, counts, hasMore, expandedUserIds]);

  const angleOnly = filters.angleOnly;
  const renderItem = useCallback(
    ({ item }: { item: ClimberLogListItem }) => {
      switch (item.kind) {
        case 'header': {
          // Only the Following section exists here; other sections bring their own header.
          if (item.section !== 'following') return null;
          const label =
            item.count === null
              ? t('mobile.climberLogs.sectionFollowing')
              : angleOnly
                ? t('mobile.climberLogs.sectionFollowingAtAngle', { count: item.count, angle })
                : t('mobile.climberLogs.sectionFollowingCount', { count: item.count });
          return (
            <Text
              variant="footnote"
              accessibilityRole="header"
              color={systemColors.secondaryLabel}
              style={styles.section}
            >
              {label}
            </Text>
          );
        }
        case 'group':
          return (
            <ClimberLogRow
              group={item.group}
              boardAngle={angle}
              noteLines={6}
              hideEarlier={hasMore}
              onPressClimber={handlePressClimber}
              onPressEarlier={handleToggleEarlier}
              earlierExpanded={expandedUserIds.has(item.group.userId)}
            />
          );
        case 'earlier':
          return <ClimberLogEarlierRow log={item.log} boardAngle={angle} />;
        default:
          return item.notice === 'otherAngles' ? (
            <PressableSurface
              onPress={handleShowAllAngles}
              feedback="opacity"
              accessibilityRole="button"
              style={styles.notice}
            >
              <Text variant="footnote" color={brandColors.primary}>
                {t('mobile.climberLogs.otherAngles', { count: item.count })}
              </Text>
            </PressableSurface>
          ) : (
            <View style={styles.notice}>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('mobile.climberLogs.cappedNotice')}
              </Text>
            </View>
          );
      }
    },
    [
      angle,
      angleOnly,
      hasMore,
      expandedUserIds,
      handlePressClimber,
      handleToggleEarlier,
      handleShowAllAngles,
      brandColors.primary,
      systemColors.secondaryLabel,
      t,
    ],
  );

  const listHeader = useMemo(
    () => (
      <View style={styles.chips}>
        <FilterChip
          label={t('mobile.climberLogs.filterAngleOnly', { angle })}
          selected={filters.angleOnly}
          onPress={handleToggleAngleOnly}
        />
        <FilterChip
          label={t('mobile.climberLogs.filterWithNotes')}
          selected={filters.withNotes}
          onPress={handleToggleWithNotes}
        />
        <FilterChip
          label={t('mobile.climberLogs.filterSendsOnly')}
          selected={filters.sendsOnly}
          onPress={handleToggleSendsOnly}
        />
      </View>
    ),
    [angle, filters, handleToggleAngleOnly, handleToggleWithNotes, handleToggleSendsOnly, t],
  );

  // Says why the list is empty. A request still in flight says nothing yet.
  const emptyText = data
    ? data.summary.climberCount === 0
      ? t('mobile.climberLogs.emptyNobodyLogged')
      : t('mobile.climberLogs.filterEmpty')
    : offline.isBlocked
      ? offline.reason === 'error'
        ? tCommon('mobile.offlineState.errorBody')
        : t('mobile.climberLogs.offlineBody')
      : null;
  const listEmpty = useMemo(
    () =>
      emptyText ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.empty}>
          {emptyText}
        </Text>
      ) : null,
    [emptyText, systemColors.secondaryLabel],
  );

  const grade = climb ? formatGrade(climb.difficulty) : null;
  const subtitle = climb
    ? grade
      ? t('mobile.climberLogs.sheetSubtitle', { name: climb.name, grade })
      : climb.name
    : null;

  return (
    <ModalSheet
      visible={visible && climb !== null}
      snapPoints={SNAP_POINTS}
      surface="solid"
      onClose={onClose}
      onFullyDismissed={handleFullyDismissed}
      header={
        <View style={[styles.header, { borderBottomColor: systemColors.separator }]}>
          <View style={styles.titles}>
            <Text variant="title3" accessibilityRole="header" style={styles.title} numberOfLines={1}>
              {t('mobile.climberLogs.title')}
            </Text>
            {subtitle ? (
              <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <PressableSurface
            onPress={onClose}
            feedback="opacity"
            accessibilityRole="button"
            accessibilityLabel={tCommon('actions.close')}
            style={[styles.close, { backgroundColor: systemColors.fill }]}
          >
            <Icon name="close" size={18} color={systemColors.secondaryLabel} />
          </PressableSurface>
        </View>
      }
    >
      <SheetFlatList
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titles: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontWeight: '600',
  },
  close: {
    width: MIN_TARGET,
    height: MIN_TARGET,
    borderRadius: MIN_TARGET / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[4],
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  chipTarget: {
    minHeight: MIN_TARGET,
    justifyContent: 'center',
  },
  chip: {
    height: CHIP_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.full,
  },
  chipLabel: {
    fontWeight: '600',
  },
  section: {
    paddingTop: spacing[2],
    paddingBottom: spacing[1],
    fontWeight: '600',
  },
  notice: {
    minHeight: MIN_TARGET,
    justifyContent: 'center',
  },
  empty: {
    paddingVertical: spacing[6],
    textAlign: 'center',
  },
});
