// Every climber who logged this climb, opened from the "Climber logs" card's
// "See all logs" row: the people the viewer follows first, then everyone else.
// The card is capped at four rows (it lives in the play drawer's plain
// ScrollView); this sheet holds the rest in a virtualised list, with three
// chips to narrow it. Those chips are the only chips: every row says how it
// went in words.
//
// Climbers with a note or a grade that disagrees get a row. The rest sit two to
// a line (one at large text): under "Also sent" and "Tried, no send" in
// Following, and in place among the rows in Everyone.
//
// The two sections come from two requests. Following is one answer of up to
// 100 logs, grouped and filtered here. Everyone is paged by the server, one row
// per climber and already filtered, one page per end-reach. Following is always
// the first section, at every chip combination, and Everyone never repeats the
// viewer or anyone already listed under Following.
//
// Driven by a controlled `visible` prop and mounted INSIDE PlayDrawer, so the
// ModalSheet coordinator presents it above the `/play` modal. A root-level
// sheet would land underneath it.
import { useCallback, useMemo, useRef, useState, type ComponentType } from 'react';
import { StyleSheet, View, useWindowDimensions, type FlatListProps } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { Button } from '../Button';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { ClimberLogBareRow, ClimberLogEarlierFoldRow, ClimberLogEarlierRow, ClimberLogRow } from './ClimberLogRow';
import {
  buildClimberLogListItems,
  deriveCrewCounts,
  filterClimberLogs,
  followingSectionCount,
  groupClimberLogs,
  otherAnglesNoticeCount,
  rankClimberLogGroups,
  splitEveryoneLogs,
  type ClimberLogFilters,
  type ClimberLogListItem,
  type ClimberLogNotice,
} from './climber-logs';
import { useFollowingClimbLogs } from '../../lib/graphql/hooks/use-following-climb-logs';
import { flattenClimbLogPages, useClimbLogs } from '../../lib/graphql/hooks/use-climb-logs';
import { useFollowedAuthorsSnapshot } from '../../lib/graphql/hooks/use-followed-authors';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { getDifficultyIdForGradeName } from '../../lib/grade-label';
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
const SKELETON_ROW_HEIGHT = 64;
// Past the halfway point of the last screenful, the next page is already on
// its way by the time the climber reaches the end.
const END_REACHED_THRESHOLD = 0.5;
/** From this text size up, two names to a line no longer fit: one each. */
const ONE_COLUMN_FONT_SCALE = 1.3;

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

/** Two placeholder rows while a page of Everyone's logs is on its way. */
function PageSkeleton() {
  const { systemColors } = useTheme();
  const block = { backgroundColor: systemColors.fill };
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="climber-logs-page-skeleton"
    >
      <View style={styles.skeletonRow}>
        <View style={[styles.skeletonAvatar, block]} />
        <View style={[styles.skeletonLine, block]} />
      </View>
      <View style={styles.skeletonRow}>
        <View style={[styles.skeletonAvatar, block]} />
        <View style={[styles.skeletonLine, block]} />
      </View>
    </View>
  );
}

export function ClimberLogsSheet({ visible, climb, boardName, angle, onClose, onOpenProfile }: ClimberLogsSheetProps) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { brandColors, systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const climbUuid = climb?.uuid ?? null;
  const climbGradeId = getDifficultyIdForGradeName(climb?.difficulty);
  const { fontScale } = useWindowDimensions();
  const columns = fontScale >= ONE_COLUMN_FONT_SCALE ? 1 : 2;

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

  // Everyone the viewer follows, from the phone's own snapshot (read only, the
  // root sync bridge keeps it fresh).
  const { data: followedAuthors } = useFollowedAuthorsSnapshot({ loadWhenMissing: visible });
  const followsNobody = followedAuthors !== undefined && followedAuthors.users.length === 0;

  // Everyone else. Waits for the Following answer: the angle chip's default and
  // whether the server may leave followed climbers out both come from it, and
  // asking before it lands would send a request the next render throws away.
  // An account that follows nobody has nothing to wait for: its Following
  // answer is empty, which is what both values already assume, so it asks at
  // once. With no signal it does not ask at all, and rows from an earlier visit
  // are not shown: who may see a spray wall's logs is decided per request.
  const { userId: viewerId } = useStoredUserId(true);
  const everyone = useClimbLogs({
    boardName,
    climbUuid,
    angle: filters.angleOnly ? angle : undefined,
    withNotes: filters.withNotes,
    sendsOnly: filters.sendsOnly,
    // The Following list was cut at 100 logs: a followed climber past the cut
    // is in neither section unless Everyone keeps them.
    excludeFollowed: !hasMore,
    enabled: visible && (data !== undefined || followsNobody) && !offline.isOffline,
  });
  const everyonePages = offline.isOffline ? undefined : everyone.data?.pages;
  const {
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
    refetch: refetchEveryone,
    isLoading: everyoneLoading,
    isError: everyoneFailed,
    isSuccess: everyoneLoaded,
  } = everyone;

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
  // The snapshot, plus anybody in the Following answer in case the snapshot is
  // missing or a follow landed since.
  const followedUserIds = useMemo(() => {
    const userIds = new Set<string>();
    for (const author of followedAuthors?.users ?? []) userIds.add(author.userId);
    for (const log of logs ?? []) userIds.add(log.userId);
    return userIds;
  }, [followedAuthors, logs]);

  const heldFollowingGroups = useMemo(
    () => rankClimberLogGroups(groupClimberLogs(filterClimberLogs(logs ?? [], angle, filters), angle, climbGradeId)),
    [logs, angle, filters, climbGradeId],
  );
  // Follow-first, past the 100-log cut too: a followed climber the server sent
  // with everyone's logs goes under Following, never under Everyone, and is
  // never left out of both. Server order (newest first) is kept inside each
  // half, so the next page lands under this one.
  const { followingGroups, everyoneGroups } = useMemo(() => {
    const { followed, strangers } = splitEveryoneLogs(flattenClimbLogPages(everyonePages), {
      viewerId,
      followedUserIds,
      shownFollowingUserIds: new Set(heldFollowingGroups.map((group) => group.userId)),
      followingCapped: hasMore,
    });
    return {
      followingGroups: [...heldFollowingGroups, ...groupClimberLogs(followed, angle, climbGradeId)],
      everyoneGroups: groupClimberLogs(strangers, angle, climbGradeId),
    };
  }, [everyonePages, viewerId, followedUserIds, heldFollowingGroups, hasMore, angle, climbGradeId]);

  const items = useMemo(() => {
    const notices: ClimberLogNotice[] = [];
    const elsewhere = otherAnglesNoticeCount(counts, filters);
    if (elsewhere > 0) notices.push({ notice: 'otherAngles', count: elsewhere });
    if (hasMore && followingGroups.length > 0) notices.push({ notice: 'capped', count: 0 });
    return buildClimberLogListItems(
      [
        // Following first. The builder holds that order whatever is passed, and
        // drops from Everyone anyone it has already listed.
        { id: 'following', groups: followingGroups, count: followingSectionCount(counts, filters), capped: hasMore },
        // No count: the server pages this list and never totals it.
        { id: 'everyone', groups: everyoneGroups, count: null },
      ],
      expandedUserIds,
      notices,
      { columns, boardAngle: angle, climbGradeId },
    );
  }, [angle, climbGradeId, filters, counts, hasMore, expandedUserIds, columns, followingGroups, everyoneGroups]);

  // One page per end-reach. A page that failed waits for the retry button
  // instead of being asked for again on every scroll.
  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const handleLoadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);
  const handleRetryEveryone = useCallback(() => {
    void (isFetchNextPageError ? fetchNextPage() : refetchEveryone());
  }, [isFetchNextPageError, fetchNextPage, refetchEveryone]);

  const angleOnly = filters.angleOnly;
  const renderItem = useCallback(
    ({ item }: { item: ClimberLogListItem }) => {
      switch (item.kind) {
        case 'header': {
          if (item.section === 'everyone') {
            return (
              <View style={[styles.sectionRow, { borderTopColor: systemColors.separator }]}>
                <Text
                  variant="footnote"
                  accessibilityRole="header"
                  color={systemColors.secondaryLabel}
                  style={styles.sectionTitle}
                >
                  {angleOnly
                    ? t('mobile.climberLogs.everyone.titleAtAngle', { angle })
                    : t('mobile.climberLogs.everyone.title')}
                </Text>
                <Text variant="caption1" color={systemColors.secondaryLabel}>
                  {t('mobile.climberLogs.everyone.sortHint')}
                </Text>
              </View>
            );
          }
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
          // An Everyone row is the climber's newest matching log and nothing
          // else: the server sends one per climber, so there is no "earlier".
          return item.section === 'everyone' ? (
            <ClimberLogRow
              group={item.group}
              boardAngle={angle}
              boardName={boardName}
              noteLines={6}
              hideEarlier
              onPressClimber={handlePressClimber}
            />
          ) : (
            <ClimberLogRow
              group={item.group}
              boardAngle={angle}
              boardName={boardName}
              noteLines={6}
              hideEarlier={hasMore}
              onPressClimber={handlePressClimber}
              onPressEarlier={handleToggleEarlier}
              earlierExpanded={expandedUserIds.has(item.group.userId)}
            />
          );
        case 'bareHeader': {
          const label =
            item.result === 'sent'
              ? item.count === null
                ? t('mobile.climberLogs.bareHeaderSent')
                : t('mobile.climberLogs.bareHeaderSentCount', { count: item.count })
              : item.count === null
                ? t('mobile.climberLogs.bareHeaderTried')
                : t('mobile.climberLogs.bareHeaderTriedCount', { count: item.count });
          return (
            <Text
              variant="footnote"
              accessibilityRole="header"
              color={systemColors.secondaryLabel}
              style={[styles.section, styles.bareHeader, { borderTopColor: systemColors.separator }]}
            >
              {label}
            </Text>
          );
        }
        case 'bare':
          return (
            <ClimberLogBareRow
              groups={item.groups}
              wide={item.wide}
              boardAngle={angle}
              // Only Following has the "Tried, no send" heading above its cells.
              underTriedHeading={item.section === 'following'}
              onPressClimber={handlePressClimber}
              onPressEarlier={handleToggleEarlier}
              earlierExpanded={item.wide && expandedUserIds.has(item.groups[0].userId)}
            />
          );
        case 'earlier':
          return (
            <ClimberLogEarlierRow log={item.log} boardAngle={angle} climbGradeId={climbGradeId} boardName={boardName} />
          );
        case 'earlierFold':
          return <ClimberLogEarlierFoldRow angle={item.angle} count={item.count} boardAngle={angle} />;
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
      boardName,
      climbGradeId,
      angleOnly,
      hasMore,
      expandedUserIds,
      handlePressClimber,
      handleToggleEarlier,
      handleShowAllAngles,
      brandColors.primary,
      systemColors.secondaryLabel,
      systemColors.separator,
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

  // What sits under the last row: the next page on its way, a page that did
  // not arrive, or a way to ask for more. The last one matters when a page came
  // back holding only climbers already listed above. It adds no rows, the list
  // does not grow, and end-reach would never fire again.
  const everyoneBusy = everyoneLoading || isFetchingNextPage;
  const everyoneBroken = !everyoneBusy && (everyoneFailed || isFetchNextPageError);
  const listFooter = useMemo(() => {
    if (offline.isOffline) return null;
    if (everyoneBusy) return <PageSkeleton />;
    if (everyoneBroken) {
      return (
        <View style={styles.footer}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.climberLogs.everyone.loadMoreError')}
          </Text>
          <Button
            title={tCommon('mobile.offlineState.retry')}
            variant="tonal"
            size="small"
            onPress={handleRetryEveryone}
          />
        </View>
      );
    }
    if (hasNextPage) {
      return (
        <PressableSurface onPress={handleLoadMore} feedback="opacity" accessibilityRole="button" style={styles.notice}>
          <Text variant="footnote" color={brandColors.primary}>
            {t('mobile.climberLogs.everyone.loadMore')}
          </Text>
        </PressableSurface>
      );
    }
    return null;
  }, [
    offline.isOffline,
    everyoneBusy,
    everyoneBroken,
    hasNextPage,
    handleRetryEveryone,
    handleLoadMore,
    brandColors.primary,
    systemColors.secondaryLabel,
    t,
    tCommon,
  ]);

  // Says why the list is empty. A request still in flight says nothing yet, and
  // neither does a list with more pages to ask for.
  const anyChip = filters.angleOnly || filters.withNotes || filters.sendsOnly;
  const everyoneExhausted = !offline.isOffline && everyoneLoaded && !hasNextPage && !isFetchingNextPage;
  const emptyText = (() => {
    if (!data) {
      if (!offline.isBlocked) return null;
      return offline.reason === 'error'
        ? tCommon('mobile.offlineState.errorBody')
        : t('mobile.climberLogs.offlineBody');
    }
    if (everyoneExhausted) {
      return anyChip ? t('mobile.climberLogs.filterEmpty') : t('mobile.climberLogs.everyone.empty');
    }
    if (everyoneBusy || hasNextPage) return null;
    // Everyone's logs are not available (no signal, or the request failed), so
    // this can only speak for the people the viewer follows.
    return data.summary.climberCount === 0
      ? t('mobile.climberLogs.emptyNobodyLogged')
      : t('mobile.climberLogs.filterEmpty');
  })();
  const listEmpty = useMemo(
    () =>
      emptyText ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.empty}>
          {emptyText}
        </Text>
      ) : null,
    [emptyText, systemColors.secondaryLabel],
  );

  const grade = climb ? formatGrade(climb.difficulty, boardName) : null;
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
        ListFooterComponent={listFooter}
        onEndReached={handleEndReached}
        onEndReachedThreshold={END_REACHED_THRESHOLD}
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
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing[2],
    marginTop: spacing[2],
    paddingTop: spacing[3],
    paddingBottom: spacing[1],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sectionTitle: {
    fontWeight: '600',
  },
  bareHeader: {
    marginTop: spacing[2],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  notice: {
    minHeight: MIN_TARGET,
    justifyContent: 'center',
  },
  footer: {
    alignItems: 'flex-start',
    gap: spacing[2],
    paddingVertical: spacing[3],
  },
  skeletonRow: {
    height: SKELETON_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  skeletonAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    opacity: 0.55,
  },
  skeletonLine: {
    flex: 1,
    height: 14,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  empty: {
    paddingVertical: spacing[6],
    textAlign: 'center',
  },
});
