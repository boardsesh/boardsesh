import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BoardName, ClimbSearchInput } from '@boardsesh/shared-schema';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import {
  SetterPickerList,
  type SetterPickerFollowControls,
  type SetterPickerItem,
} from '../../../src/components/filter-sheet/SetterPickerList';
import { useHeaderActions } from '../../../src/hooks/use-header-actions';
import { useScreenshotBoardParams } from '../../../src/hooks/use-screenshot-board-params';
import { useSearchClimbsCount, useSetterStats } from '../../../src/lib/graphql/hooks';
import { withSetterSelection } from '../../../src/lib/climb-count-preview-input';
import { emitSetterFilterSelection } from '../../../src/lib/setter-filter-handoff';
import { useAuth } from '../../../src/providers/auth-provider';
import { useFollowedAuthors, useToggleAuthorFollow } from '../../../src/lib/graphql/hooks/use-followed-authors';

// Stand-in input for the disabled count query when the route carries no usable
// `countInput` param (the query never runs with it).
const EMPTY_COUNT_INPUT: ClimbSearchInput = { boardName: '', layoutId: 0, sizeId: 0, setIds: '', angle: 0 };

type Params = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
  setters?: string;
  /** The filter sheet's count input (JSON) for its draft at push time. */
  countInput?: string;
  /** Which filter sheet gets the picks back (see lib/filter-picker-handoff-id.ts). */
  handoffId?: string;
};

// Defensive parse of the serialized selection param: a malformed value falls back
// to an empty selection rather than crashing the route.
function parseSelectedSetters(serialized: string | undefined): string[] {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

// Defensive parse of the count-input param. Anything missing the board fields a
// search needs falls back to null, and the header shows the plain Apply label.
function parseCountInput(serialized: string | undefined): ClimbSearchInput | null {
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.boardName !== 'string' || candidate.boardName.length === 0) return null;
    if (typeof candidate.layoutId !== 'number' || typeof candidate.sizeId !== 'number') return null;
    if (typeof candidate.setIds !== 'string' || typeof candidate.angle !== 'number') return null;
    return candidate as unknown as ClimbSearchInput;
  } catch {
    return null;
  }
}

/**
 * Full-screen route variant for the setter search filter. The climb filter sheet
 * suspends and pushes this route. Two ways out:
 * - The pinned "Show N climbs" button hands the selection back with
 *   `apply: true`; the sheet applies it and closes, landing on the results.
 * - The back chevron or swipe-back hands the selection back on blur, and the
 *   sheet merges it into its draft and re-presents.
 * A pushed route is used (not a stacked sheet) because native sheets can't stack
 * above the filter sheet — see docs/mobile-sheets-vs-routes.md.
 */
export default function SettersFilterScreen() {
  const params = useLocalSearchParams<Params>();
  const navigation = useNavigation();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const follows = useFollowedAuthors();
  const followMutation = useToggleAuthorFollow();
  const pendingSettersRef = useRef(new Set<string>());
  const [pendingSetters, setPendingSetters] = useState<ReadonlySet<string>>(new Set());
  const [followError, setFollowError] = useState(false);
  const [followingOnly, setFollowingOnly] = useState(false);
  const { t } = useTranslation('climbs');
  const handoffId = params.handoffId ?? '';

  // A screenshot deep link (`://climbs/setters`) opens this route with none of
  // the params the filter sheet pushes, which would leave the setter query
  // disabled and the list empty. In screenshot mode only, fall back to the wall
  // the capture activated on boot; `null` in every normal build and whenever the
  // route carried a board.
  const screenshotBoard = useScreenshotBoardParams(params.boardName);
  const boardName = (screenshotBoard?.boardName ?? params.boardName ?? '') as BoardName;
  const layoutId = Number(screenshotBoard?.layoutId ?? params.layoutId ?? 0);
  const sizeId = Number(screenshotBoard?.sizeId ?? params.sizeId ?? 0);
  const setIds = screenshotBoard?.setIds ?? params.setIds ?? '';
  const angle = Number(screenshotBoard?.angle ?? params.angle ?? 0);

  const [selectedSetters, setSelectedSetters] = useState<string[]>(() => parseSelectedSetters(params.setters));
  // Mirror of the latest selection so the focus-effect cleanup hands back the
  // current value without re-subscribing on every toggle.
  const selectedSettersRef = useRef(selectedSetters);
  selectedSettersRef.current = selectedSetters;
  // Set once the header's Apply has handed the selection back with `apply`, so
  // the blur cleanup that follows the pop doesn't hand it back a second time.
  const appliedRef = useRef(false);

  // The list debounces the search field and hands the settled text back here.
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Only removing the picker hands its draft back. Pushing a setter playlist
  // must not re-present the underlying filter sheet over that playlist.
  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        if (appliedRef.current) return;
        emitSetterFilterSelection({ handoffId, setters: selectedSettersRef.current });
      }),
    [navigation, handoffId],
  );

  const baseCountInput = useMemo(() => parseCountInput(params.countInput), [params.countInput]);

  // The sheet draft's "Other angles" switch (issue #5642). The count input is the
  // draft's own ClimbSearchInput, where `includeOtherAngles` becomes
  // `crossAngleStats: true`, so reading it there keeps the picker on the same
  // angles as the list it filters: without it a Woods setter counts only the
  // climbs the list shows at this angle, and a setter with none there is not
  // offered at all. Sent only on an angle-bound board, the one place the server
  // reads it, so every other board's query key is the one it always was. Part of
  // `queryInput`, and so of the setterStats query key: a draft with the switch
  // flipped is a different cache entry, never a stale list.
  const crossAngleStats = getBoardCapabilities(boardName).angleBoundClimbs && baseCountInput?.crossAngleStats === true;

  const queryInput = useMemo(
    () => ({
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      onlyFollowedAuthors: (followingOnly && isAuthenticated) || undefined,
      ...(debouncedSearch.length > 0 ? { search: debouncedSearch } : {}),
      ...(crossAngleStats ? { crossAngleStats: true } : {}),
    }),
    [boardName, layoutId, sizeId, setIds, angle, debouncedSearch, followingOnly, isAuthenticated, crossAngleStats],
  );

  const { data: setterStats, isLoading, isError, refetch } = useSetterStats(queryInput, boardName.length > 0);
  const setters = useMemo<SetterPickerItem[] | undefined>(
    () => setterStats?.map((stat) => ({ setterUsername: stat.setterUsername, count: stat.climbCount })),
    [setterStats],
  );
  const linkedSetterNames = useMemo(
    () =>
      new Set(
        follows.data?.users.flatMap((user) =>
          user.boardAccounts.filter((account) => account.boardType === boardName).map((account) => account.username),
        ) ?? [],
      ),
    [follows.data, boardName],
  );

  // Live "Show N climbs" count: the sheet's draft with this screen's picks swapped
  // in. Built with the same helper as the sheet's own count, so returning to the
  // sheet reads this result from the cache. No debounce: toggles are single taps.
  const countInput = useMemo(
    () => (baseCountInput ? withSetterSelection(baseCountInput, selectedSetters) : null),
    [baseCountInput, selectedSetters],
  );
  const { data: previewCount, isPlaceholderData: isCountForPreviousPicks } = useSearchClimbsCount(
    countInput ?? EMPTY_COUNT_INPUT,
    countInput != null,
  );
  // The count hook holds the previous number while a new one loads. That number
  // belongs to the previous picks, so show plain "Apply" until the real one lands.
  const applyLabel =
    previewCount != null && !isCountForPreviousPicks
      ? t('mobile.filter.showCount', { count: previewCount })
      : t('mobile.filter.apply');

  const toggle = useCallback((username: string) => {
    setSelectedSetters((previous) => {
      const next = new Set(previous);
      if (next.has(username)) {
        next.delete(username);
      } else {
        next.add(username);
      }
      return Array.from(next);
    });
  }, []);

  const clear = useCallback(() => {
    setSelectedSetters([]);
  }, []);

  // Apply straight from here: the sheet applies its draft with these picks and
  // closes, then the pop lands on the results. A second tap during the pop is
  // ignored.
  const handleApply = useCallback(() => {
    if (appliedRef.current) return;
    appliedRef.current = true;
    emitSetterFilterSelection({ handoffId, setters: selectedSettersRef.current, apply: true });
    navigation.goBack();
  }, [navigation, handoffId]);

  // Apply ("Show N climbs") is the header's trailing action. "Clear all" sits
  // in the selection bar under the search, next to the count it clears: beside
  // Apply it would not fit in German. The back chevron / swipe-back keeps the
  // picks as a draft (handed back on removal, see above).
  useHeaderActions({
    trailing: { kind: 'forward', label: applyLabel, onPress: handleApply, prominent: true },
  });

  const openSetter = useCallback(
    (username: string) => {
      router.push({ pathname: '/(tabs)/climbs/setter/[username]', params: { username } });
    },
    [router],
  );
  const followSetter = useCallback(
    (username: string, follow: boolean) => {
      if (pendingSettersRef.current.has(username)) return;
      pendingSettersRef.current.add(username);
      setPendingSetters(new Set(pendingSettersRef.current));
      setFollowError(false);
      void followMutation
        .mutateAsync({ kind: 'setter', identifier: username, follow })
        .catch(() => setFollowError(true))
        .finally(() => {
          pendingSettersRef.current.delete(username);
          setPendingSetters(new Set(pendingSettersRef.current));
        });
    },
    [followMutation.mutateAsync],
  );
  const canFollow = isAuthenticated && !!follows.data;
  const followControls = useMemo<SetterPickerFollowControls>(
    () => ({
      isFollowing: (username) => follows.setterNames.has(username),
      isPending: (username) => pendingSetters.has(username),
      isViaUserFollow: (username) => followingOnly || linkedSetterNames.has(username),
      onFollow: canFollow ? followSetter : undefined,
    }),
    [follows.setterNames, pendingSetters, followingOnly, linkedSetterNames, canFollow, followSetter],
  );
  const formatCount = useCallback((count: number) => t('mobile.search.climbsCount', { count }), [t]);
  const hints = useMemo(
    () => (followingOnly ? [t('authors.selectHint'), t('authors.followingHint')] : [t('authors.selectHint')]),
    [followingOnly, t],
  );
  const retry = useCallback(() => {
    if (follows.isError) void follows.refetch();
    if (isError) void refetch();
  }, [follows, isError, refetch]);

  return (
    <SetterPickerList
      setters={setters}
      isLoading={isLoading}
      onSearchChange={setDebouncedSearch}
      searchPlaceholder={t('mobile.filter.searchSetters')}
      formatCount={formatCount}
      selected={selectedSetters}
      onToggle={toggle}
      onClearAll={clear}
      onOpenSetter={openSetter}
      follow={followControls}
      headerAccessory={
        isAuthenticated ? (
          <SegmentedControl
            options={[
              { key: 'all', label: t('authors.allSetters') },
              { key: 'following', label: t('authors.following') },
            ]}
            selectedKey={followingOnly ? 'following' : 'all'}
            onSelect={(scope) => setFollowingOnly(scope === 'following')}
            accessibilityLabel={t('mobile.filter.setters')}
          />
        ) : null
      }
      hints={hints}
      notice={followError ? t('authors.followError') : undefined}
      error={
        isError || follows.isError
          ? { message: t('authors.syncNeeded'), retryLabel: t('authors.retry'), onRetry: retry }
          : null
      }
      emptyLabel={t('mobile.filter.noSetters')}
    />
  );
}
