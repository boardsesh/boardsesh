'use client';

import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import { HistoryOutlined } from '@mui/icons-material';
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  DEFAULT_ANGLE_RANGE,
  sanitizeLogbookPreferences,
  type LogbookFilterState as FilterState,
  type LogbookSortState as SortState,
} from '@/app/lib/logbook-preferences';
import { readFiltersFromQuery, readSortFromQuery, filtersToQueryParams } from '@/app/lib/logbook-url-utils';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useLocaleRouter, usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import {
  GET_USER_ASCENTS_FEED,
  DELETE_TICK,
  type GetUserAscentsFeedQueryVariables,
  type GetUserAscentsFeedQueryResponse,
  type AscentFeedItem,
  type DeleteTickMutationVariables,
  type LayoutStats,
} from '@/app/lib/graphql/operations/ticks';
import { getLayoutDisplayName } from '@/app/profile/[user_id]/utils/profile-constants';
import {
  getDefaultSizeForLayout,
  getSetsForLayoutAndSize,
  ORPHANED_KILTER_LAYOUT_DEFAULTS,
} from '@boardsesh/board-constants/product-sizes';
import { getLayoutById, MOONBOARD_SETS, type MoonBoardLayoutKey } from '@/app/lib/moonboard-config';
import type { BoardName } from '@/app/lib/types';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { isInstagramPostingSupported } from '@/app/lib/instagram-posting';
import type { UserBoard } from '@boardsesh/shared-schema';
import LogbookFeedItem from './logbook-feed-item';
import LogbookSwipeHintOrchestrator from './logbook-swipe-hint-orchestrator';
import LogbookSearchForm from './logbook-search-form';
import LogbookItemSkeleton from './logbook-item-skeleton';
import styles from './library.module.css';
import feedStyles from '@/app/components/activity-feed/ascents-feed.module.css';

const PAGE_SIZE = 20;
type StatusMode = 'both' | 'send' | 'attempt';

// ---------- Component ----------

type LogbookFeedProps = {
  layoutStats: LayoutStats[];
  loadingLayoutStats: boolean;
};

export default function LogbookFeed({ layoutStats, loadingLayoutStats }: LogbookFeedProps) {
  const { t } = useTranslation('profile');
  const { data: session } = useSession();
  const pathname = usePathnameWithoutLocale();
  const searchParams = useSearchParams();
  const router = useLocaleRouter();
  const { token, isLoading: authLoading, error: authError } = useWsAuthToken();
  const userId = session?.user?.id;
  const isNarrowViewport = useMediaQuery('(max-width: 768px)', { noSsr: true });

  const queryClient = useQueryClient();
  const { showMessage } = useSnackbar();

  // Build board list from layout stats (boards the user has ticks for)
  const logbookBoards: UserBoard[] = useMemo(
    () =>
      layoutStats.map((ls) => {
        const layoutId = ls.layoutId ?? 0;
        const boardName = ls.boardType as BoardName;

        let sizeId = 0;
        let setIds = '';

        if (boardName === 'moonboard') {
          // MoonBoard uses its own set system, not Aurora's
          const layoutEntry = getLayoutById(layoutId);
          if (layoutEntry) {
            const [layoutKey] = layoutEntry;
            const moonSets = MOONBOARD_SETS[layoutKey as MoonBoardLayoutKey] ?? [];
            setIds = moonSets.map((s) => s.id).join(',');
          }
        } else {
          const defaultSize = getDefaultSizeForLayout(boardName, layoutId);
          if (defaultSize !== null) {
            sizeId = defaultSize;
            const sets = getSetsForLayoutAndSize(boardName, layoutId, sizeId);
            setIds = sets.map((s) => s.id).join(',');
          } else {
            const fallback = boardName === 'kilter' ? ORPHANED_KILTER_LAYOUT_DEFAULTS[layoutId] : undefined;
            if (fallback) {
              sizeId = fallback.sizeId;
              setIds = fallback.setIds;
            }
            // Non-Kilter orphaned layouts (sizeId=0, setIds='') will render with
            // the fallback icon in BoardScrollCard since useBoardDetails returns
            // null when board config can't be resolved. The card still works for
            // filtering by boardType/layoutId.
          }
        }

        return {
          uuid: `logbook-${ls.boardType}-${layoutId}`,
          slug: '',
          ownerId: '',
          boardType: ls.boardType,
          layoutId,
          sizeId,
          setIds,
          name: getLayoutDisplayName(ls.boardType, ls.layoutId),
          isPublic: false,
          isUnlisted: false,
          hideLocation: false,
          isOwned: false,
          angle: 0,
          isAngleAdjustable: false,
          createdAt: '',
          totalAscents: ls.distinctClimbCount,
          uniqueClimbers: 0,
          followerCount: 0,
          commentCount: 0,
          isFollowedByMe: false,
        };
      }),
    [layoutStats],
  );

  // State
  const [searchText, setSearchText] = useState(() => searchParams.get('q') || '');
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get('q') || '');
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [sortState, setSortState] = useState<SortState>(DEFAULT_SORT);
  const [selectedBoards, setSelectedBoards] = useState<UserBoard[]>([]);
  const [editingItemUuid, setEditingItemUuid] = useState<string | null>(null);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [boardsInitialized, setBoardsInitialized] = useState(() => !searchParams.get('boards'));
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Debounced search text
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchText(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value.trim());
    }, 350);
  }, []);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  // Load preferences from IndexedDB, then overlay URL query params
  useEffect(() => {
    let isCancelled = false;

    void getPreference('logbookPreferences').then((saved) => {
      if (isCancelled) return;

      let baseFilters = DEFAULT_FILTERS;
      let baseSort = DEFAULT_SORT;

      if (saved) {
        const sanitized = sanitizeLogbookPreferences(saved);
        baseFilters = sanitized.filters;
        baseSort = sanitized.sort;
      }

      // Overlay URL query params if present
      const hasQueryParams = searchParams.toString().length > 0;
      if (hasQueryParams) {
        const queryFilters = readFiltersFromQuery(searchParams);
        baseFilters = { ...baseFilters, ...queryFilters };

        const querySort = readSortFromQuery(searchParams);
        baseSort = { ...baseSort, ...querySort };
      }

      setFilters(baseFilters);
      setSortState(baseSort);
      setPreferencesLoaded(true);
    });

    return () => {
      isCancelled = true;
    };
    // Intentionally run-once on mount: loads persisted preferences from IndexedDB
    // and overlays URL query params. searchParams is read once and should not
    // re-trigger this effect when Next.js re-renders with the same URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve selected boards from URL param after boards load
  useEffect(() => {
    if (loadingLayoutStats) return;

    const boardsParam = searchParams.get('boards');
    if (boardsParam && logbookBoards.length > 0) {
      const uuids = boardsParam.split(',');
      const matched = logbookBoards.filter((b) => uuids.includes(b.uuid));
      if (matched.length > 0) {
        setSelectedBoards(matched);
      } else {
        showMessage(t('logbook.feed.snackbar.boardsLinkMissing'), 'warning');
      }
    }
    setBoardsInitialized(true);
    // Omits searchParams from deps: the boards param is read once after layout
    // stats load, not re-evaluated on every URL change (URL is output, not input
    // for this effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingLayoutStats, logbookBoards, showMessage]);

  // Update URL query params when state changes
  const updateUrlRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!preferencesLoaded || !boardsInitialized) return;

    clearTimeout(updateUrlRef.current);
    updateUrlRef.current = setTimeout(() => {
      const params = filtersToQueryParams(
        debouncedSearch,
        filters,
        sortState,
        selectedBoards.map((b) => b.uuid),
      );

      const newSearchParams = new URLSearchParams(params);
      const newSearch = newSearchParams.toString();
      const currentSearch = searchParams.toString();

      if (newSearch !== currentSearch) {
        router.replace(`${pathname}${newSearch ? `?${newSearch}` : ''}`, { scroll: false });
      }
    }, 300);

    return () => clearTimeout(updateUrlRef.current);
    // Omits router, pathname, searchParams: these are output targets, not inputs.
    // Including them would cause an infinite loop (effect writes URL → URL changes
    // → effect re-runs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, filters, sortState, selectedBoards, preferencesLoaded, boardsInitialized]);

  // Persist to IndexedDB
  useEffect(() => {
    if (!preferencesLoaded) return;
    void setPreference('logbookPreferences', {
      version: 1 as const,
      boardFilter: 'all' as const,
      layoutSelections: {
        kilter: [],
        tension: [],
        moonboard: [],
        decoy: [],
        touchstone: [],
        grasshopper: [],
        soill: [],
      },
      filters,
      sort: sortState,
    });
  }, [filters, sortState, preferencesLoaded]);

  // Board toggle handler (multi-select)
  const handleBoardToggle = useCallback((board: UserBoard | null) => {
    if (board === null) {
      setSelectedBoards([]);
      return;
    }
    setSelectedBoards((prev) => {
      const isSelected = prev.some((b) => b.uuid === board.uuid);
      if (isSelected) {
        return prev.filter((b) => b.uuid !== board.uuid);
      }
      return [...prev, board];
    });
  }, []);

  // Build query variables from state
  const selectedBoardTypes = useMemo(() => {
    if (selectedBoards.length === 0) return undefined;
    const types = [...new Set(selectedBoards.map((b) => b.boardType))];
    return types;
  }, [selectedBoards]);

  const selectedLayoutIds = useMemo(() => {
    if (selectedBoards.length === 0) return undefined;
    const ids = selectedBoards.map((b) => b.layoutId).filter((id): id is number => id != null);
    return ids.length > 0 ? ids : undefined;
  }, [selectedBoards]);

  const climbNameParam = debouncedSearch || undefined;

  const sortParams = useMemo(() => {
    if (sortState.mode === 'preset') {
      if (sortState.preset === 'hardest') {
        return { sortBy: 'hardest' as const, sortOrder: 'desc' as const };
      }
      return { sortBy: 'recent' as const, sortOrder: 'desc' as const };
    }
    return {
      sortBy: sortState.primaryField,
      sortOrder: sortState.primaryDirection,
      ...(sortState.secondaryField
        ? {
            secondarySortBy: sortState.secondaryField,
            secondarySortOrder: sortState.secondaryDirection,
          }
        : {}),
    };
  }, [sortState]);

  const activeFilters = useMemo(() => {
    let statusMode: StatusMode;
    if (filters.includeSends && filters.includeAttempts) {
      statusMode = 'both';
    } else if (filters.includeSends) {
      statusMode = 'send';
    } else {
      statusMode = 'attempt';
    }
    return {
      statusMode,
      flashOnly: filters.includeSends ? filters.flashOnly : false,
      minDifficulty: filters.minGrade !== '' ? filters.minGrade : undefined,
      maxDifficulty: filters.maxGrade !== '' ? filters.maxGrade : undefined,
      fromDate: filters.fromDate || undefined,
      toDate: filters.toDate || undefined,
      minAngle: filters.angleRange[0] !== DEFAULT_ANGLE_RANGE[0] ? filters.angleRange[0] : undefined,
      maxAngle: filters.angleRange[1] !== DEFAULT_ANGLE_RANGE[1] ? filters.angleRange[1] : undefined,
      benchmarkOnly: filters.benchmarkOnly || undefined,
    };
  }, [filters]);

  const feedQueryKey = useMemo(
    () => [
      'logbookFeed',
      userId,
      selectedBoardTypes?.join(',') ?? 'all',
      selectedLayoutIds?.join(',') ?? 'all-layouts',
      climbNameParam ?? '',
      JSON.stringify(activeFilters),
      JSON.stringify(sortParams),
    ],
    [userId, selectedBoardTypes, selectedLayoutIds, climbNameParam, activeFilters, sortParams],
  );

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: feedQueryKey,
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(token ?? null);

      // For single board type, use boardType; for multiple, use boardTypes
      const buildBoardTypeFilter = () => {
        if (selectedBoardTypes?.length === 1) return { boardType: selectedBoardTypes[0] };
        if (selectedBoardTypes && selectedBoardTypes.length > 1) return { boardTypes: selectedBoardTypes };
        return {};
      };
      const boardTypeFilter = buildBoardTypeFilter();

      const variables: GetUserAscentsFeedQueryVariables = {
        userId: userId!,
        input: {
          limit: PAGE_SIZE,
          offset: pageParam,
          ...boardTypeFilter,
          ...(selectedLayoutIds ? { layoutIds: selectedLayoutIds } : {}),
          ...(climbNameParam ? { climbName: climbNameParam } : {}),
          statusMode: activeFilters.statusMode,
          flashOnly: activeFilters.flashOnly,
          ...(activeFilters.minDifficulty !== undefined ? { minDifficulty: activeFilters.minDifficulty } : {}),
          ...(activeFilters.maxDifficulty !== undefined ? { maxDifficulty: activeFilters.maxDifficulty } : {}),
          ...(activeFilters.fromDate ? { fromDate: activeFilters.fromDate } : {}),
          ...(activeFilters.toDate ? { toDate: activeFilters.toDate } : {}),
          ...(activeFilters.minAngle !== undefined ? { minAngle: activeFilters.minAngle } : {}),
          ...(activeFilters.maxAngle !== undefined ? { maxAngle: activeFilters.maxAngle } : {}),
          ...(activeFilters.benchmarkOnly ? { benchmarkOnly: activeFilters.benchmarkOnly } : {}),
          ...sortParams,
        },
      };
      const response = await client.request<GetUserAscentsFeedQueryResponse>(GET_USER_ASCENTS_FEED, variables);
      return response.userAscentsFeed;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return lastPageParam + lastPage.items.length;
    },
    enabled: !!userId && !!token && preferencesLoaded && boardsInitialized,
    staleTime: 60 * 1000,
  });

  const items: AscentFeedItem[] = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: fetchNextPage,
    hasMore: hasNextPage ?? false,
    isFetching: isFetchingNextPage,
  });

  const pendingDeleteRef = useRef<{
    uuid: string;
    item: AscentFeedItem;
    timerId: ReturnType<typeof setTimeout>;
  } | null>(null);

  useEffect(() => {
    return () => {
      if (pendingDeleteRef.current) {
        clearTimeout(pendingDeleteRef.current.timerId);
      }
    };
  }, []);

  // Keep token in a ref so handleDelete stays stable across auth refreshes,
  // which would otherwise invalidate React.memo on every LogbookFeedItem.
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const handleDelete = useCallback(
    (uuid: string) => {
      // If there's already a pending delete for a different item, flush it immediately
      if (pendingDeleteRef.current && pendingDeleteRef.current.uuid !== uuid) {
        const { uuid: prevUuid, timerId } = pendingDeleteRef.current;
        clearTimeout(timerId);
        pendingDeleteRef.current = null;
        const client = createGraphQLHttpClient(tokenRef.current ?? null);
        client
          .request<{ deleteTick: boolean }, DeleteTickMutationVariables>(DELETE_TICK, {
            uuid: prevUuid,
          })
          .catch(() => {
            showMessage(t('logbook.feed.snackbar.deleteFailed'), 'error');
          });
      }

      // Find and capture the item before removing it from the cache
      const currentData = queryClient.getQueryData<{
        pages: { items: AscentFeedItem[]; hasMore: boolean }[];
      }>(feedQueryKey);
      const itemToDelete = currentData?.pages.flatMap((p) => p.items).find((i) => i.uuid === uuid);

      // Optimistically remove the item from the cache
      queryClient.setQueryData(
        feedQueryKey,
        (old: { pages: { items: AscentFeedItem[]; hasMore: boolean }[]; pageParams: number[] } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.filter((i) => i.uuid !== uuid),
            })),
          };
        },
      );

      const timerId = setTimeout(() => {
        pendingDeleteRef.current = null;
        const client = createGraphQLHttpClient(tokenRef.current ?? null);
        void client
          .request<{ deleteTick: boolean }, DeleteTickMutationVariables>(DELETE_TICK, { uuid })
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: ['logbookFeed'] });
          })
          .catch(() => {
            void queryClient.invalidateQueries({ queryKey: ['logbookFeed'] });
            showMessage(t('logbook.feed.snackbar.deleteFailed'), 'error');
          });
      }, 5000);

      pendingDeleteRef.current = {
        uuid,
        item: itemToDelete ?? ({ uuid } as AscentFeedItem),
        timerId,
      };

      showMessage(
        t('logbook.feed.snackbar.tickDeleted'),
        'success',
        {
          label: t('logbook.feed.snackbar.undo'),
          onClick: () => {
            if (pendingDeleteRef.current?.uuid === uuid) {
              clearTimeout(pendingDeleteRef.current.timerId);
              pendingDeleteRef.current = null;
              void queryClient.invalidateQueries({ queryKey: ['logbookFeed'] });
            }
          },
        },
        5000,
      );
    },
    [queryClient, showMessage, feedQueryKey, t],
  );

  const handleEdit = useCallback((item: AscentFeedItem) => {
    setEditingItemUuid(item.uuid);
  }, []);

  const handleCloseEdit = useCallback(() => {
    setEditingItemUuid(null);
  }, []);

  const showBoardType = selectedBoards.length === 0 || selectedBoards.length > 1;
  const hasFilters =
    selectedBoards.length > 0 ||
    debouncedSearch.length > 0 ||
    filters.minGrade !== '' ||
    filters.maxGrade !== '' ||
    filters.flashOnly ||
    filters.benchmarkOnly ||
    !filters.includeSends ||
    !filters.includeAttempts ||
    filters.fromDate !== '' ||
    filters.toDate !== '' ||
    filters.angleRange[0] !== DEFAULT_ANGLE_RANGE[0] ||
    filters.angleRange[1] !== DEFAULT_ANGLE_RANGE[1];
  // Posting and linking are mutually exclusive — see `allowInstagramLinking` below.
  const enableInstagramPosting = pathname === '/you/logbook' && isNarrowViewport && isInstagramPostingSupported();
  const enableInstagramLinking = pathname === '/you/logbook';

  const searchForm = (
    <LogbookSearchForm
      searchText={searchText}
      onSearchChange={handleSearchChange}
      minGrade={filters.minGrade}
      maxGrade={filters.maxGrade}
      onMinGradeChange={(value) =>
        setFilters((prev) => ({
          ...prev,
          minGrade: value,
          maxGrade: value !== '' && prev.maxGrade !== '' && value > prev.maxGrade ? value : prev.maxGrade,
        }))
      }
      onMaxGradeChange={(value) =>
        setFilters((prev) => ({
          ...prev,
          maxGrade: value,
          minGrade: value !== '' && prev.minGrade !== '' && value < prev.minGrade ? value : prev.minGrade,
        }))
      }
      sortState={sortState}
      onSortChange={setSortState}
      boards={logbookBoards}
      boardsLoading={loadingLayoutStats}
      selectedBoards={selectedBoards}
      onBoardToggle={handleBoardToggle}
      filters={filters}
      onFiltersChange={setFilters}
    />
  );

  if (isLoading) {
    return (
      <>
        {searchForm}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <LogbookItemSkeleton key={i} />
          ))}
        </Box>
      </>
    );
  }

  if (items.length === 0) {
    const isLogbookUnavailable = !!userId && !authLoading && !token;
    let emptyTitle: string;
    if (isLogbookUnavailable) {
      emptyTitle = 'Logbook unavailable on this device';
    } else if (hasFilters) {
      emptyTitle = 'No matching climbs';
    } else {
      emptyTitle = 'No logged climbs yet';
    }
    let emptyDescription: string;
    if (isLogbookUnavailable) {
      emptyDescription = 'Your account is signed in, but the authenticated data connection did not become available.';
    } else if (hasFilters) {
      emptyDescription = 'Try adjusting your filters or sort.';
    } else {
      emptyDescription = 'Tick your sends and they show up here.';
    }
    return (
      <>
        {searchForm}
        {userId && !authLoading && !token && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {authError
              ? 'Signed in, but Boardsesh could not load your authenticated logbook data on this device.'
              : 'Signed in, but Boardsesh could not access your authenticated logbook data on this device.'}
          </Alert>
        )}
        <div className={styles.emptyContainer}>
          <HistoryOutlined className={styles.emptyIcon} />
          <Typography variant="h6" component="h4" sx={{ mb: 1 }}>
            {emptyTitle}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 300 }}>
            {emptyDescription}
          </Typography>
        </div>
      </>
    );
  }

  return (
    <>
      {searchForm}
      <LogbookSwipeHintOrchestrator />
      <div className={feedStyles.feed}>
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          {items.map((item, index) => (
            <LogbookFeedItem
              key={item.uuid}
              item={item}
              showBoardType={showBoardType}
              isEditing={editingItemUuid === item.uuid}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onCancelEdit={handleCloseEdit}
              allowInstagramPosting={enableInstagramPosting}
              allowInstagramLinking={enableInstagramLinking && !enableInstagramPosting}
              // Orchestrator re-queries DOM at animation time, so re-sorts are safe.
              isSwipeHintTarget={index === 0}
            />
          ))}
        </Box>

        <Box ref={sentinelRef} sx={{ display: 'flex', justifyContent: 'center', py: 2, minHeight: 20 }}>
          {isFetchingNextPage && <CircularProgress size={24} />}
        </Box>
      </div>
    </>
  );
}
