// A gym's walls of one board type (#8151): the gym-first create flow's second
// step, and where a gym page's "Set up a board" opens. Backed by
// `existingWallCandidates`, so it lists the walls the server would refuse a
// copy of: the gym's own, listings merged into it, and public listings within
// 150 m. The climber takes one ("Use this board", which follows it), or says
// theirs isn't listed and goes on to the builder with the gym prefilled.
//
// Bounded lists in a ScrollView, as on the picker: at most 40 walls, five a
// shelf until "Show all".

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { SUPPORTED_BOARDS } from '@boardsesh/board-config';
import type { BoardName, ExistingWallCandidate, UserBoard } from '@boardsesh/shared-schema';
import { useExistingWallCandidates, useGym, useGymBoards, useProfile } from '../../lib/graphql/hooks';
import { isGraphqlRateLimitedError } from '../../lib/graphql/extract-error-message';
import { selectEffectiveOffline, useConnectivityField } from '../../lib/connectivity/use-connectivity';
import { track } from '../../lib/analytics';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { resolveBoardReturnTo } from '../../lib/boards/board-return-to';
import {
  isPickableBoardType,
  likelyBoardType,
  lookupState,
  notListedRowState,
  type LookupState,
} from '../../lib/boards/find-wall-state';
import {
  acknowledgedWallUuids,
  countWallCandidates,
  groupWallCandidates,
  wallCandidateItem,
  wallCandidateMatch,
  type WallCandidateMatch,
  type WallRowCopy,
  type WallShelfKey,
} from '../../lib/boards/wall-candidates';
import { useTakeExistingWall } from '../../lib/boards/use-take-existing-wall';
import { spacing } from '../../theme/tokens';
import { ShelfSection } from '../ShelfHeader';
import { EmptyState } from '../EmptyState';
import { Button } from '../Button';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { useGymReportAction } from '../gym-page/use-gym-report-action';
import { BoardConfigChips, type ChipOption } from './BoardConfigChips';
import { BoardRowList } from './BoardRowList';
import type { DiscoveryBoardItem } from './BoardDiscoveryCardView';
import { DiscoveryBoardArt } from './DiscoveryBoardArt';
import { boardTypeLabel } from './board-builder-labels';
import { WallNotListedConfirmSheet } from './WallNotListedConfirmSheet';

/** Rows a shelf shows before "Show all N". */
export const WALL_SHELF_COLLAPSED_ROW_COUNT = 5;

/** The server's most: everything the climber is shown can be acknowledged. */
const WALL_CANDIDATES_LIMIT = 40;

type GymWallListProps = {
  gymUuid: string;
  /** The type chosen on the gym search, or null to open on the gym's most common one. */
  initialBoardType: BoardName | null;
  returnTo: string | undefined;
  source: string | undefined;
  /** How the climber got here: the gym search, or a gym page. */
  entry: 'find_step' | 'gym_page';
};

function lookupErrorReason(error: unknown, offline: boolean): 'offline' | 'rate_limited' | 'exception' {
  if (offline) return 'offline';
  return isGraphqlRateLimitedError(error) ? 'rate_limited' : 'exception';
}

export function GymWallList({ gymUuid, initialBoardType, returnTo, source, entry }: GymWallListProps) {
  const { t } = useTranslation('boards');
  const router = useRouter();
  const navigation = useNavigation();
  const { systemColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const { isAuthenticated } = useAuth();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const viewerId = profile?.id ?? null;
  const offline = useConnectivityField(selectEffectiveOffline);

  const gymQuery = useGym(gymUuid);
  const gym = gymQuery.data ?? null;
  const gymName = gym?.name ?? '';
  const gymBoardsQuery = useGymBoards(gymUuid);
  const gymBoards = gymBoardsQuery.data;

  // The header names the gym once it's known.
  useEffect(() => {
    if (gym) navigation.setOptions({ title: gym.name });
  }, [gym, navigation]);

  const [chosenType, setChosenType] = useState<BoardName | null>(initialBoardType);
  const boardType = chosenType ?? likelyBoardType(gymBoards);
  const typeOptions = useMemo<ChipOption<BoardName>[]>(
    () =>
      SUPPORTED_BOARDS.map((board) => ({
        key: board,
        label: boardTypeLabel(board),
        value: board,
        selected: board === boardType,
      })),
    [boardType],
  );

  const candidatesInput = useMemo(
    () => (boardType ? { gymUuid, boardType, limit: WALL_CANDIDATES_LIMIT } : null),
    [gymUuid, boardType],
  );
  const candidatesQuery = useExistingWallCandidates(candidatesInput, { enabled: !offline });
  const candidates = useMemo<readonly ExistingWallCandidate[]>(
    () => candidatesQuery.data?.candidates ?? [],
    [candidatesQuery.data],
  );
  const walls: LookupState = lookupState({
    enabled: candidatesInput !== null,
    offline,
    isLoading: candidatesQuery.isLoading,
    isError: candidatesQuery.isError,
    count: candidatesQuery.data ? candidates.length : null,
  });

  // The gym's walls of the other types, under "Other boards here".
  const otherBoards = useMemo(() => {
    if (!gymBoards || boardType === null) return [];
    const listed = new Set(candidates.map((candidate) => candidate.board.uuid));
    return gymBoards.filter(
      (board) => board.boardType !== boardType && isPickableBoardType(board.boardType) && !listed.has(board.uuid),
    );
  }, [gymBoards, boardType, candidates]);

  // --- analytics: once per gym and type, and once per failure ---
  useEffect(() => {
    if (entry === 'gym_page') {
      track(SHARED_EVENTS.BoardWallSearchStarted, { method: 'gym_page', boardType: initialBoardType, queryLength: 0 });
    }
    // Once per screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shownKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (boardType === null || (walls !== 'listed' && walls !== 'empty' && walls !== 'failed')) return;
    const shownKey = `${boardType}:${walls === 'failed' ? 'failed' : 'ok'}`;
    if (shownKeyRef.current === shownKey) return;
    shownKeyRef.current = shownKey;
    const counts = countWallCandidates(candidates);
    track(SHARED_EVENTS.BoardWallCandidatesShown, {
      boardType,
      ...counts,
      otherTypeCount: otherBoards.length,
      lookup: walls === 'failed' ? 'failed' : 'ok',
      trigger: 'find_step',
    });
    if (walls === 'failed') {
      track(SHARED_EVENTS.BoardWallLookupFailed, {
        stage: 'gym_boards',
        error_reason: lookupErrorReason(candidatesQuery.error, offline),
      });
    }
  }, [boardType, walls, candidates, otherBoards.length, candidatesQuery.error, offline]);

  // --- rows ---
  const wallRowCopy = useMemo<WallRowCopy>(
    () => ({
      adjustable: t('mobile.findWall.adjustable'),
      stats: ({ climbers, sends }) => t('mobile.findWall.stats', { climbers, sends }),
      addedBy: (name) => t('mobile.findWall.addedBy', { name }),
      nearbyGym: (nearbyGymName, distance) => t('mobile.findWall.nearbyGym', { gym: nearbyGymName, distance }),
      yourBoard: t('mobile.findWall.yourBoard'),
      following: t('mobile.findWall.following'),
    }),
    [t],
  );
  const shelves = useMemo(
    () =>
      groupWallCandidates(candidates).map((shelf) => ({
        key: shelf.key,
        items: shelf.candidates.flatMap((candidate) => {
          const item = wallCandidateItem(candidate.board, {
            copy: wallRowCopy,
            viewerId,
            nearby:
              candidate.source === 'NEARBY_LISTING'
                ? { gymName: candidate.gymName, distanceMeters: candidate.gymDistanceMeters }
                : null,
          });
          return item ? [item] : [];
        }),
      })),
    [candidates, wallRowCopy, viewerId],
  );
  const otherItems = useMemo(
    () =>
      otherBoards.flatMap((board) => {
        const item = wallCandidateItem(board, { copy: wallRowCopy, viewerId });
        return item ? [item] : [];
      }),
    [otherBoards, wallRowCopy, viewerId],
  );
  // Each row's board and how it matched, read on a tap. One map per list build.
  const rowLookup = useMemo(() => {
    const byKey = new Map<string, { board: UserBoard; match: WallCandidateMatch }>();
    for (const candidate of candidates) {
      byKey.set(candidate.board.uuid, { board: candidate.board, match: wallCandidateMatch(candidate) });
    }
    for (const board of otherBoards) byKey.set(board.uuid, { board, match: 'other_type' });
    return byKey;
  }, [candidates, otherBoards]);

  // --- use this board ---
  const takeWall = useTakeExistingWall({ returnTo: resolveBoardReturnTo(returnTo), source, viewerId });
  const [useError, setUseError] = useState(false);
  const takingRef = useRef(false);
  const onUseWall = useCallback(
    (item: DiscoveryBoardItem, position: number) => {
      const row = rowLookup.get(item.key);
      if (!row || takingRef.current) return;
      takingRef.current = true;
      setUseError(false);
      void takeWall(row.board)
        .then(({ alreadyFollowed }) => {
          track(SHARED_EVENTS.BoardWallCandidateUsed, {
            match: row.match,
            position,
            alreadyFollowed,
            fixSetupStarted: false,
            trigger: 'find_step',
          });
        })
        .catch(() => setUseError(true))
        .finally(() => {
          takingRef.current = false;
        });
    },
    [rowLookup, takeWall],
  );

  // --- my board isn't listed ---
  const gymLinkable = gym != null && ((gym.latitude != null && gym.longitude != null) || gym.canEdit === true);
  const notListed = notListedRowState({ walls, signedIn: isAuthenticated, gymLinkable });
  const reportAction = useGymReportAction(gym);
  const [confirming, setConfirming] = useState(false);
  const openBuilder = useCallback(
    (acknowledged: readonly string[]) => {
      const params: Record<string, string> = { kind: 'gym', gymUuid };
      if (boardType) params.boardType = boardType;
      if (acknowledged.length > 0) params.acknowledged = acknowledged.join(',');
      if (returnTo !== undefined) params.returnTo = returnTo;
      if (source !== undefined) params.source = source;
      router.push({ pathname: '/boards/create', params });
    },
    [gymUuid, boardType, returnTo, source, router],
  );
  const onNotListed = useCallback(() => {
    switch (notListed) {
      case 'sign_in':
        router.push('/auth/login');
        return;
      case 'report':
        reportAction?.open();
        return;
      case 'direct':
        openBuilder([]);
        return;
      case 'confirm':
      case 'add_anyway':
        setConfirming(true);
        return;
      case 'hidden':
        return;
    }
  }, [notListed, router, reportAction, openBuilder]);
  const onConfirmNotListed = useCallback(() => {
    setConfirming(false);
    const lookupFailed = walls === 'failed';
    const shown = lookupFailed ? [] : acknowledgedWallUuids(candidates.map((candidate) => candidate.board.uuid));
    track(SHARED_EVENTS.BoardWallNotListedConfirmed, {
      candidateCount: shown.length,
      lookup: lookupFailed ? 'failed' : 'ok',
    });
    openBuilder(shown);
  }, [walls, candidates, openBuilder]);
  const onDismissConfirm = useCallback(() => setConfirming(false), []);

  const [otherExpanded, setOtherExpanded] = useState(false);
  const toggleOther = useCallback(() => setOtherExpanded((expanded) => !expanded), []);
  const retry = useCallback(() => {
    void candidatesQuery.refetch();
    if (gymQuery.isError) void gymQuery.refetch();
  }, [candidatesQuery, gymQuery]);

  const shelfTitle = (key: WallShelfKey): string => {
    switch (key) {
      case 'same_setup':
        return t('mobile.findWall.sameSetup');
      case 'set_up_differently':
        return t('mobile.findWall.setUpDifferently');
      case 'listed_nearby':
        return t('mobile.findWall.listedNearby');
      case 'at_gym':
        return t('mobile.findWall.atGym', { gym: gymName });
    }
  };

  if (gymQuery.isError && !gym) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.flex}>
        <EmptyState
          size="section"
          title={t('mobile.findWall.gymFailed')}
          actions={<Button title={t('mobile.findWall.retry')} variant="outlined" onPress={retry} />}
          testID="gym-walls-gym-failed"
        />
      </ScrollView>
    );
  }

  const boardLabel = boardType ? boardTypeLabel(boardType) : '';

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={styles.flex}
        contentContainerStyle={[styles.container, { paddingBottom: bottomChrome.scrollBottomPadding }]}
        testID="gym-walls"
      >
        <View style={styles.chips}>
          {boardType === null && gymBoards !== undefined ? (
            <Text variant="subheadline" tone="secondary">
              {t('mobile.findWall.pickBoardType')}
            </Text>
          ) : null}
          <BoardConfigChips
            groupLabel={t('mobile.findWall.boardType')}
            options={typeOptions}
            onSelect={setChosenType}
          />
        </View>

        {useError ? (
          <Text variant="footnote" color={systemColors.error} style={styles.inlineError} testID="gym-walls-use-error">
            {t('mobile.findWall.useError')}
          </Text>
        ) : null}

        {walls === 'loading' ? (
          <View style={styles.centerState}>
            <ActivityIndicator size="small" />
          </View>
        ) : null}

        {walls === 'offline' ? (
          <EmptyState
            size="section"
            title={t('mobile.findWall.offline')}
            actions={<Button title={t('mobile.findWall.retry')} variant="outlined" onPress={retry} />}
            testID="gym-walls-offline"
          />
        ) : null}

        {walls === 'failed' ? (
          <EmptyState
            size="section"
            title={t('mobile.findWall.lookupFailed', { gym: gymName })}
            actions={<Button title={t('mobile.findWall.retry')} variant="outlined" onPress={retry} />}
            testID="gym-walls-failed"
          />
        ) : null}

        {walls === 'empty' ? (
          <EmptyState
            size="section"
            title={t('mobile.findWall.emptyTitle', { board: boardLabel, gym: gymName })}
            actions={
              notListed === 'direct' ? (
                <Button title={t('mobile.findWall.setUpFirst')} onPress={onNotListed} />
              ) : undefined
            }
            testID="gym-walls-empty"
          />
        ) : null}

        {walls === 'listed'
          ? shelves.map((shelf) => (
              <ShelfSection key={shelf.key} title={shelfTitle(shelf.key)} testID={`gym-walls-shelf-${shelf.key}`}>
                <WallShelfRows items={shelf.items} onSelect={onUseWall} />
              </ShelfSection>
            ))
          : null}

        {otherItems.length > 0 ? (
          <ShelfSection
            title={t('mobile.findWall.otherBoardsHere', { n: otherItems.length })}
            action={{
              label: otherExpanded ? t('mobile.findWall.otherHide') : t('mobile.findWall.otherShow'),
              onPress: toggleOther,
            }}
            testID="gym-walls-other"
          >
            {otherExpanded ? <WallShelfRows items={otherItems} onSelect={onUseWall} /> : null}
          </ShelfSection>
        ) : null}

        <NotListedRow state={notListed} canReport={reportAction !== null} walls={walls} onPress={onNotListed} />
      </ScrollView>
      {confirming ? (
        <WallNotListedConfirmSheet
          gymName={gymName}
          candidateCount={candidates.length}
          lookupFailed={walls === 'failed'}
          onConfirm={onConfirmNotListed}
          onDismiss={onDismissConfirm}
        />
      ) : null}
      {reportAction?.sheet ?? null}
    </>
  );
}

const WallShelfRows = memo(function WallShelfRows({
  items,
  onSelect,
}: {
  items: readonly DiscoveryBoardItem[];
  onSelect: (item: DiscoveryBoardItem, position: number) => void;
}) {
  return (
    <BoardRowList
      items={items}
      onSelect={onSelect}
      collapsedRowCount={WALL_SHELF_COLLAPSED_ROW_COUNT}
      BoardArt={DiscoveryBoardArt}
    />
  );
});

/** The row under the list: its label follows the state (see `notListedRowState`). */
function NotListedRow({
  state,
  canReport,
  walls,
  onPress,
}: {
  state: ReturnType<typeof notListedRowState>;
  canReport: boolean;
  walls: LookupState;
  onPress: () => void;
}) {
  const { t } = useTranslation('boards');
  // The empty state already carries "Set up the first one".
  if (state === 'hidden' || state === 'direct' || (state === 'report' && !canReport)) return null;
  const title =
    state === 'sign_in'
      ? t('mobile.findWall.signInToAdd')
      : state === 'report'
        ? t('mobile.gymPage.report')
        : state === 'add_anyway' || walls === 'failed'
          ? t('mobile.findWall.addAnyway')
          : t('mobile.findWall.boardNotListed');
  return (
    <View style={styles.notListed}>
      <Button title={title} variant="text" onPress={onPress} testID="gym-walls-not-listed" />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    paddingTop: spacing[3],
  },
  chips: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    gap: spacing[2],
  },
  centerState: {
    alignItems: 'center',
    paddingVertical: spacing[8],
  },
  inlineError: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
  },
  notListed: {
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
});
