// "Find your gym's board" (#8151): the gym-first create flow's first step.
// Find the gym by name or by location, then its walls (GymWallList). A board
// found by name can be taken straight from here.
//
// Location is never asked on open: the screen reads a permission the climber
// already gave (`requestIfAllowed`) and asks only from "Use my location", with
// the reason under it. Unlike GymPickerSheet, which asks as it opens.
//
// The gyms are the virtualised list (`GymSearchList`, up to 50); the search,
// chips and states sit in its header, and the Boards shelf (at most five rows
// until "Show all") and "My gym isn't listed" in its footer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View, type TextInputInstance } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { SUPPORTED_BOARDS } from '@boardsesh/board-config';
import type { BoardName, Gym, UserBoard } from '@boardsesh/shared-schema';
import { useNearbyGyms, useProfile, useSearchBoards } from '../../lib/graphql/hooks';
import { isGraphqlRateLimitedError } from '../../lib/graphql/extract-error-message';
import { useDeviceLocation } from '../../lib/use-device-location';
import { canOpenAppSettings, openAppSettings } from '../../lib/open-app-settings';
import { selectEffectiveOffline, useConnectivityField } from '../../lib/connectivity/use-connectivity';
import { track } from '../../lib/analytics';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { resolveBoardReturnTo } from '../../lib/boards/board-return-to';
import { locationRowState, lookupState, type LookupState } from '../../lib/boards/find-wall-state';
import { wallCandidateItem, type WallRowCopy } from '../../lib/boards/wall-candidates';
import { useTakeExistingWall } from '../../lib/boards/use-take-existing-wall';
import { borderRadius, spacing } from '../../theme/tokens';
import { AccessibleTextInput } from '../AccessibleTextInput';
import { ShelfSection } from '../ShelfHeader';
import { EmptyState } from '../EmptyState';
import { Button } from '../Button';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { BoardConfigChips, type ChipOption } from './BoardConfigChips';
import { BoardRowList } from './BoardRowList';
import type { DiscoveryBoardItem } from './BoardDiscoveryCardView';
import { DiscoveryBoardArt } from './DiscoveryBoardArt';
import { GymSearchList } from './GymSearchList';
import { boardTypeLabel } from './board-builder-labels';

const SEARCH_DEBOUNCE_MS = 300;
/** Boards found by name: five, then "Show all". */
const BOARD_RESULTS_COLLAPSED_ROW_COUNT = 5;
const BOARD_RESULTS_LIMIT = 20;
const GYM_SEARCH_RADIUS_KM = 50;

type FindWallGymSearchProps = {
  initialBoardType: BoardName | null;
  returnTo: string | undefined;
  source: string | undefined;
};

function lookupErrorReason(error: unknown, offline: boolean): 'offline' | 'rate_limited' | 'exception' {
  if (offline) return 'offline';
  return isGraphqlRateLimitedError(error) ? 'rate_limited' : 'exception';
}

export function FindWallGymSearch({ initialBoardType, returnTo, source }: FindWallGymSearchProps) {
  const { t } = useTranslation('boards');
  const router = useRouter();
  const { systemColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const { isAuthenticated } = useAuth();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const viewerId = profile?.id ?? null;
  const offline = useConnectivityField(selectEffectiveOffline);

  // --- search ---
  const searchRef = useRef<TextInputInstance | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const trimmed = search.trim();
    const handle = setTimeout(() => setQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);
  const [boardType, setBoardType] = useState<BoardName | null>(initialBoardType);
  // A second tap on the chosen type clears it: every type again.
  const onSelectType = useCallback(
    (picked: BoardName) => setBoardType((current) => (current === picked ? null : picked)),
    [],
  );
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
  const boardTypes = useMemo(() => (boardType ? [boardType] : undefined), [boardType]);

  // --- location: read on open, asked on tap ---
  const location = useDeviceLocation({ retryAfterDenial: true, rereadWhenActive: true });
  const { requestIfAllowed, request: requestLocation } = location;
  useEffect(() => {
    void requestIfAllowed();
  }, [requestIfAllowed]);
  const locationRow = locationRowState({
    status: location.status,
    permission: location.permission,
    platform: Platform.OS,
  });
  const askedRef = useRef(false);
  const onUseMyLocation = useCallback(() => {
    askedRef.current = true;
    void requestLocation();
  }, [requestLocation]);
  // Refused after the climber asked: the name search is the way on, so it gets the focus.
  useEffect(() => {
    if (askedRef.current && (locationRow === 'denied' || locationRow === 'blocked_web')) searchRef.current?.focus();
  }, [locationRow]);
  const onOpenSettings = useCallback(() => void openAppSettings(), []);

  // --- lookups ---
  const coords = location.coords;
  const gymsQuery = useNearbyGyms(coords, GYM_SEARCH_RADIUS_KM, query, boardTypes, undefined, undefined, undefined, {
    enabled: !offline,
  });
  const gyms = useMemo<readonly Gym[]>(() => gymsQuery.data?.gyms ?? [], [gymsQuery.data?.gyms]);
  const gymsState: LookupState = lookupState({
    enabled: coords !== null || query.length > 0,
    offline,
    isLoading: gymsQuery.isLoading,
    isError: gymsQuery.isError,
    count: gymsQuery.data ? gyms.length : null,
  });

  const boardsInput = useMemo(
    () => ({
      query,
      boardTypes,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
      limit: BOARD_RESULTS_LIMIT,
    }),
    [query, boardTypes, coords],
  );
  const boardsQuery = useSearchBoards(boardsInput, !offline && query.length > 0);
  const boards = useMemo<readonly UserBoard[]>(() => boardsQuery.data?.boards ?? [], [boardsQuery.data?.boards]);
  const boardsState: LookupState = lookupState({
    enabled: query.length > 0,
    offline,
    isLoading: boardsQuery.isLoading,
    isError: boardsQuery.isError,
    count: boardsQuery.data ? boards.length : null,
  });

  // --- analytics ---
  const searchStartedRef = useRef(new Set<'location' | 'text'>());
  useEffect(() => {
    if (coords && !searchStartedRef.current.has('location')) {
      searchStartedRef.current.add('location');
      track(SHARED_EVENTS.BoardWallSearchStarted, { method: 'location', boardType, queryLength: query.length });
    }
    if (query.length > 0 && !searchStartedRef.current.has('text')) {
      searchStartedRef.current.add('text');
      track(SHARED_EVENTS.BoardWallSearchStarted, { method: 'text', boardType, queryLength: query.length });
    }
  }, [coords, query, boardType]);
  useEffect(() => {
    if (gymsState === 'failed') {
      track(SHARED_EVENTS.BoardWallLookupFailed, {
        stage: 'gyms',
        error_reason: lookupErrorReason(gymsQuery.error, offline),
      });
    }
    // Once per failure: the state, not the error object, says when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gymsState]);
  useEffect(() => {
    if (boardsState === 'failed') {
      track(SHARED_EVENTS.BoardWallLookupFailed, {
        stage: 'nearby_boards',
        error_reason: lookupErrorReason(boardsQuery.error, offline),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardsState]);

  // --- navigation ---
  const routeParams = useCallback(
    (extra: Record<string, string>) => {
      const params: Record<string, string> = { ...extra };
      if (boardType) params.boardType = boardType;
      if (returnTo !== undefined) params.returnTo = returnTo;
      if (source !== undefined) params.source = source;
      return params;
    },
    [boardType, returnTo, source],
  );
  const onSelectGym = useCallback(
    (gym: Gym) => router.push({ pathname: '/boards/find-wall', params: routeParams({ gymUuid: gym.uuid }) }),
    [router, routeParams],
  );
  const onGymNotListed = useCallback(() => {
    if (!isAuthenticated) {
      router.push('/auth/login');
      return;
    }
    router.push({ pathname: '/boards/create', params: routeParams({ kind: 'gym', focusLocation: '1' }) });
  }, [isAuthenticated, router, routeParams]);

  // --- a board found by name: take it ---
  const wallRowCopy = useMemo<WallRowCopy>(
    () => ({
      adjustable: t('mobile.findWall.adjustable'),
      stats: ({ climbers, sends }) => t('mobile.findWall.stats', { climbers, sends }),
      addedBy: (name) => t('mobile.findWall.addedBy', { name }),
      nearbyGym: (gymName, distance) => t('mobile.findWall.nearbyGym', { gym: gymName, distance }),
      yourBoard: t('mobile.findWall.yourBoard'),
      following: t('mobile.findWall.following'),
    }),
    [t],
  );
  const boardItems = useMemo(
    () =>
      boards.flatMap((board) => {
        const item = wallCandidateItem(board, { copy: wallRowCopy, viewerId });
        return item ? [item] : [];
      }),
    [boards, wallRowCopy, viewerId],
  );
  const boardsByUuid = useMemo(() => new Map(boards.map((board) => [board.uuid, board])), [boards]);
  const takeWall = useTakeExistingWall({ returnTo: resolveBoardReturnTo(returnTo), source, viewerId });
  const [useError, setUseError] = useState(false);
  const takingRef = useRef(false);
  const onUseBoard = useCallback(
    (item: DiscoveryBoardItem, position: number) => {
      const board = boardsByUuid.get(item.key);
      if (!board || takingRef.current) return;
      takingRef.current = true;
      setUseError(false);
      void takeWall(board)
        .then(({ alreadyFollowed }) => {
          track(SHARED_EVENTS.BoardWallCandidateUsed, {
            match: 'search',
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
    [boardsByUuid, takeWall],
  );

  const retry = useCallback(() => {
    void gymsQuery.refetch();
    if (query.length > 0) void boardsQuery.refetch();
  }, [gymsQuery, boardsQuery, query.length]);

  const header = (
    <View style={styles.header}>
      <AccessibleTextInput
        ref={searchRef}
        value={search}
        onChangeText={setSearch}
        placeholder={t('mobile.findWall.searchPlaceholder')}
        placeholderTextColor={systemColors.tertiaryLabel}
        accessibilityLabel={t('mobile.findWall.searchPlaceholder')}
        autoCorrect={false}
        returnKeyType="search"
        style={[styles.searchInput, { backgroundColor: systemColors.tertiaryBackground, color: systemColors.label }]}
        testID="find-wall-search"
      />
      <BoardConfigChips groupLabel={t('mobile.findWall.boardType')} options={typeOptions} onSelect={onSelectType} />
      <LocationRow state={locationRow} onUseMyLocation={onUseMyLocation} onOpenSettings={onOpenSettings} />
      {useError ? (
        <Text variant="footnote" color={systemColors.error} testID="find-wall-use-error">
          {t('mobile.findWall.useError')}
        </Text>
      ) : null}
      {offline ? (
        <View style={styles.notice} testID="find-wall-offline">
          <Text variant="subheadline" tone="secondary">
            {t('mobile.findWall.offline')}
          </Text>
          <Button title={t('mobile.findWall.retry')} variant="outlined" size="small" onPress={retry} />
        </View>
      ) : null}
      {gymsState === 'listed' ? (
        <Text variant="headline" accessibilityRole="header" style={styles.shelfTitle}>
          {t('mobile.findWall.gyms')}
        </Text>
      ) : null}
    </View>
  );

  const gymsEmpty =
    gymsState === 'loading' ? (
      <View style={styles.centerState}>
        <ActivityIndicator size="small" />
      </View>
    ) : gymsState === 'failed' ? (
      <EmptyState
        size="section"
        title={t('mobile.findWall.gymsFailed')}
        actions={<Button title={t('mobile.findWall.retry')} variant="outlined" onPress={retry} />}
        testID="find-wall-gyms-failed"
      />
    ) : gymsState === 'empty' && boardsState !== 'listed' && boardsState !== 'loading' ? (
      <EmptyState size="section" title={t('mobile.findWall.noMatches')} testID="find-wall-no-matches" />
    ) : gymsState === 'idle' && !offline ? (
      <Text variant="subheadline" tone="secondary" style={styles.prompt} testID="find-wall-prompt">
        {t('mobile.findWall.searchPrompt')}
      </Text>
    ) : null;

  const footer = (
    <View style={styles.footer}>
      {boardsState === 'listed' ? (
        <ShelfSection title={t('mobile.findWall.boards')} testID="find-wall-boards">
          <BoardRowList
            items={boardItems}
            onSelect={onUseBoard}
            collapsedRowCount={BOARD_RESULTS_COLLAPSED_ROW_COUNT}
            BoardArt={DiscoveryBoardArt}
          />
        </ShelfSection>
      ) : null}
      {boardsState === 'failed' ? (
        <Text variant="footnote" tone="secondary" style={styles.prompt} testID="find-wall-boards-failed">
          {t('mobile.findWall.boardsFailed')}
        </Text>
      ) : null}
      <View style={styles.notListed}>
        <Button
          title={isAuthenticated ? t('mobile.findWall.gymNotListed') : t('mobile.findWall.signInToAdd')}
          variant="text"
          onPress={onGymNotListed}
          testID="find-wall-gym-not-listed"
        />
      </View>
    </View>
  );

  return (
    <GymSearchList
      testID="find-wall"
      style={styles.flex}
      gyms={gymsState === 'listed' ? gyms : EMPTY_GYMS}
      onSelect={onSelectGym}
      showChevrons
      ListHeaderComponent={header}
      ListEmptyComponent={gymsEmpty}
      ListFooterComponent={footer}
      contentContainerStyle={{ paddingBottom: bottomChrome.scrollBottomPadding }}
    />
  );
}

const EMPTY_GYMS: readonly Gym[] = [];

/** "Use my location" and what became of it. See `locationRowState`. */
function LocationRow({
  state,
  onUseMyLocation,
  onOpenSettings,
}: {
  state: ReturnType<typeof locationRowState>;
  onUseMyLocation: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation('boards');
  switch (state) {
    case 'granted':
      return null;
    case 'not_asked':
    case 'loading':
      return (
        <View style={styles.locationRow} testID="find-wall-location-ask">
          <Button
            title={t('mobile.findWall.useMyLocation')}
            icon="location"
            variant="tonal"
            size="small"
            loading={state === 'loading'}
            onPress={onUseMyLocation}
          />
          <Text variant="footnote" tone="secondary">
            {t('mobile.findWall.useMyLocationHint')}
          </Text>
        </View>
      );
    case 'denied':
      return (
        <View style={styles.locationRow} testID="find-wall-location-denied">
          <Text variant="footnote" tone="secondary">
            {t('mobile.findWall.locationDenied')}
          </Text>
          {canOpenAppSettings() ? (
            <Button title={t('mobile.firstBoard.openSettings')} variant="text" size="small" onPress={onOpenSettings} />
          ) : null}
        </View>
      );
    case 'blocked_web':
      return (
        <View style={styles.locationRow} testID="find-wall-location-blocked-web">
          <Text variant="footnote" tone="secondary">
            {t('mobile.findWall.locationBlockedWeb')}
          </Text>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
    gap: spacing[3],
  },
  searchInput: {
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  locationRow: {
    alignItems: 'flex-start',
    gap: spacing[1],
  },
  notice: {
    alignItems: 'flex-start',
    gap: spacing[2],
  },
  shelfTitle: {
    paddingTop: spacing[2],
  },
  centerState: {
    alignItems: 'center',
    paddingVertical: spacing[8],
  },
  prompt: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
  },
  footer: {
    paddingTop: spacing[4],
    gap: spacing[3],
  },
  notListed: {
    alignItems: 'center',
    paddingHorizontal: spacing[4],
  },
});
