'use client';

import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Chip from '@mui/material/Chip';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import Button from '@mui/material/Button';
import Popover from '@mui/material/Popover';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Slider from '@mui/material/Slider';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Checkbox from '@mui/material/Checkbox';
import FormGroup from '@mui/material/FormGroup';
import IconButton from '@mui/material/IconButton';
import useMediaQuery from '@mui/material/useMediaQuery';
import { HistoryOutlined, SearchOutlined, FilterListOutlined, SwapVertOutlined, ExpandMoreOutlined, CloseOutlined } from '@mui/icons-material';
import { BOULDER_GRADES } from '@/app/lib/board-data';
import { getAllLayouts } from '@/app/lib/board-constants';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import {
  ALL_LAYOUT_SELECTIONS,
  DEFAULT_ANGLE_RANGE,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  sanitizeLogbookPreferences,
  type BoardFilter,
  type LogbookPreferences,
  type LogbookFilterState as FilterState,
  type LogbookSortState as SortState,
  type SortDirection,
  type SortField,
  type SortPreset,
} from '@/app/lib/logbook-preferences';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import { useQueryClient } from '@tanstack/react-query';
import {
  GET_USER_ASCENTS_FEED,
  DELETE_TICK,
  type GetUserAscentsFeedQueryVariables,
  type GetUserAscentsFeedQueryResponse,
  type AscentFeedItem,
  type DeleteTickMutationVariables,
} from '@/app/lib/graphql/operations/ticks';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import LogbookFeedItem from './logbook-feed-item';
import { isInstagramPostingSupported } from '@/app/lib/instagram-posting';
import styles from './library.module.css';
import feedStyles from '@/app/components/activity-feed/ascents-feed.module.css';

const PAGE_SIZE = 20;
type StatusMode = 'both' | 'send' | 'attempt';

const BOARD_OPTIONS: { value: BoardFilter; label: string }[] = [
  { value: 'all', label: 'All boards' },
  { value: 'kilter', label: 'Kilter' },
  { value: 'tension', label: 'Tension' },
  { value: 'moonboard', label: 'MoonBoard' },
];

const BOARD_LAYOUT_OPTIONS: Record<Exclude<BoardFilter, 'all'>, { id: number; name: string }[]> = {
  kilter: getAllLayouts('kilter').map((layout) => ({ id: layout.id, name: `Kilter ${layout.name}` })),
  tension: getAllLayouts('tension').map((layout) => ({ id: layout.id, name: `Tension ${layout.name}` })),
  moonboard: getAllLayouts('moonboard').map((layout) => ({ id: layout.id, name: layout.name })),
};

const SORT_PRESET_OPTIONS: { value: SortPreset; label: string }[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'hardest', label: 'Hardest' },
];

const SORT_FIELD_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'climbName', label: 'Climb name' },
  { value: 'loggedGrade', label: 'Logged Grade' },
  { value: 'consensusGrade', label: 'Consensus Grade' },
  { value: 'date', label: 'Date' },
  { value: 'attemptCount', label: 'Number of attempts' },
];

function LogbookItemSkeleton() {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', p: 1, gap: 1.5, borderBottom: '1px solid var(--neutral-200)' }}>
      <Skeleton variant="rounded" width={64} height={64} animation="wave" sx={{ flexShrink: 0 }} />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: 1, minWidth: 0 }}>
        <Skeleton variant="rounded" width={120} height={18} animation="wave" />
        <Skeleton variant="rounded" width={180} height={14} animation="wave" />
      </Box>
      <Skeleton variant="rounded" width={40} height={18} animation="wave" sx={{ flexShrink: 0 }} />
    </Box>
  );
}

function isDefaultFilters(filters: FilterState): boolean {
  return (
    filters.includeSends === DEFAULT_FILTERS.includeSends &&
    filters.includeAttempts === DEFAULT_FILTERS.includeAttempts &&
    filters.flashOnly === DEFAULT_FILTERS.flashOnly &&
    filters.minGrade === DEFAULT_FILTERS.minGrade &&
    filters.maxGrade === DEFAULT_FILTERS.maxGrade &&
    filters.fromDate === DEFAULT_FILTERS.fromDate &&
    filters.toDate === DEFAULT_FILTERS.toDate &&
    filters.angleRange[0] === DEFAULT_FILTERS.angleRange[0] &&
    filters.angleRange[1] === DEFAULT_FILTERS.angleRange[1] &&
    filters.benchmarkOnly === DEFAULT_FILTERS.benchmarkOnly
  );
}

function isDefaultSort(sortState: SortState): boolean {
  return JSON.stringify(sortState) === JSON.stringify(DEFAULT_SORT);
}

function getDirectionOptions(field: SortField): { value: SortDirection; label: string }[] {
  switch (field) {
    case 'climbName':
      return [
        { value: 'asc', label: 'A → Z' },
        { value: 'desc', label: 'Z → A' },
      ];
    case 'loggedGrade':
    case 'consensusGrade':
      return [
        { value: 'asc', label: 'Easier → Harder' },
        { value: 'desc', label: 'Harder → Easier' },
      ];
    case 'date':
      return [
        { value: 'asc', label: 'Old → New' },
        { value: 'desc', label: 'New → Old' },
      ];
    case 'attemptCount':
      return [
        { value: 'asc', label: 'Low → High' },
        { value: 'desc', label: 'High → Low' },
      ];
  }
}

export default function LogbookFeed() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const { token, isLoading: authLoading, error: authError } = useWsAuthToken();
  const userId = session?.user?.id;
  const isNarrowViewport = useMediaQuery('(max-width: 768px)', { noSsr: true });

  const queryClient = useQueryClient();
  const { showMessage } = useSnackbar();

  const [boardFilter, setBoardFilter] = useState<BoardFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [draftFilters, setDraftFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [sortState, setSortState] = useState<SortState>(DEFAULT_SORT);
  const [draftSortState, setDraftSortState] = useState<SortState>(DEFAULT_SORT);
  const [isAdvancedSortOpen, setIsAdvancedSortOpen] = useState(false);
  const [filterAnchorEl, setFilterAnchorEl] = useState<HTMLElement | null>(null);
  const [sortAnchorEl, setSortAnchorEl] = useState<HTMLElement | null>(null);
  const [boardAnchorEl, setBoardAnchorEl] = useState<HTMLElement | null>(null);
  const [editingItemUuid, setEditingItemUuid] = useState<string | null>(null);
  const [layoutSelections, setLayoutSelections] = useState<Record<Exclude<BoardFilter, 'all'>, number[]>>({
    ...ALL_LAYOUT_SELECTIONS,
  });
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchText(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value.trim());
    }, 350);
  }, []);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  useEffect(() => {
    let isCancelled = false;

    getPreference('logbookPreferences').then((saved) => {
      if (isCancelled) return;

      if (saved) {
        const sanitized = sanitizeLogbookPreferences(saved);
        setBoardFilter(sanitized.boardFilter);
        setLayoutSelections(sanitized.layoutSelections);
        setFilters(sanitized.filters);
        setDraftFilters(sanitized.filters);
        setSortState(sanitized.sort);
        setDraftSortState(sanitized.sort);
        setIsAdvancedSortOpen(Boolean(sanitized.sort.secondaryField));
      }

      setPreferencesLoaded(true);
    });

    return () => {
      isCancelled = true;
    };
  }, []);

  const openFilterMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    setDraftFilters(filters);
    setFilterAnchorEl(event.currentTarget);
  }, [filters]);

  const openSortMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    setDraftSortState(sortState);
    setIsAdvancedSortOpen(Boolean(sortState.secondaryField));
    setSortAnchorEl(event.currentTarget);
  }, [sortState]);

  const closeFilterMenu = useCallback(() => setFilterAnchorEl(null), []);
  const closeSortMenu = useCallback(() => setSortAnchorEl(null), []);
  const closeBoardMenu = useCallback(() => setBoardAnchorEl(null), []);

  const handleBoardChipClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const value = event.currentTarget.dataset.boardFilter as BoardFilter | undefined;
      if (!value) return;
      setBoardFilter(value);
      if (value !== 'all' && BOARD_LAYOUT_OPTIONS[value].length > 1) {
        setBoardAnchorEl(event.currentTarget);
      } else {
        setBoardAnchorEl(null);
      }
    },
    [],
  );

  const applyFilters = useCallback(() => {
    setFilters({
      ...draftFilters,
      flashOnly: draftFilters.includeSends ? draftFilters.flashOnly : false,
    });
    closeFilterMenu();
  }, [closeFilterMenu, draftFilters]);

  const clearFilters = useCallback(() => {
    setDraftFilters(DEFAULT_FILTERS);
  }, []);

  const applySort = useCallback(() => {
    setSortState({
      ...draftSortState,
      secondaryField: isAdvancedSortOpen ? draftSortState.secondaryField : '',
    });
    closeSortMenu();
  }, [closeSortMenu, draftSortState, isAdvancedSortOpen]);

  const applyPresetSort = useCallback((preset: SortPreset) => {
    const nextSortState: SortState = {
      ...sortState,
      mode: 'preset',
      preset,
    };
    setDraftSortState(nextSortState);
    setSortState(nextSortState);
    closeSortMenu();
  }, [closeSortMenu, sortState]);

  const persistedPreferences = useMemo<LogbookPreferences>(() => ({
    version: 1,
    boardFilter,
    layoutSelections,
    filters,
    sort: sortState,
  }), [boardFilter, layoutSelections, filters, sortState]);

  const boardChipLabels = useMemo(() => {
    return BOARD_OPTIONS.reduce<Record<BoardFilter, string>>((labels, option) => {
      if (option.value === 'all') {
        labels.all = option.label;
        return labels;
      }

      const totalVariants = BOARD_LAYOUT_OPTIONS[option.value].length;
      if (totalVariants <= 1) {
        labels[option.value] = option.label;
        return labels;
      }

      const selectedVariants = layoutSelections[option.value].length;
      labels[option.value] = `${option.label} (${selectedVariants}/${totalVariants})`;
      return labels;
    }, { all: 'All boards', kilter: 'Kilter', tension: 'Tension', moonboard: 'MoonBoard' });
  }, [layoutSelections]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    void setPreference('logbookPreferences', persistedPreferences);
  }, [persistedPreferences, preferencesLoaded]);

  const boardTypeParam = boardFilter === 'all' ? undefined : boardFilter;
  const selectedLayoutIds = boardFilter === 'all' ? undefined : layoutSelections[boardFilter];
  const climbNameParam = debouncedSearch || undefined;

  const sortParams = useMemo(() => {
    if (sortState.mode === 'preset') {
      if (sortState.preset === 'hardest') {
        return {
          sortBy: 'hardest' as const,
          sortOrder: 'desc' as const,
        };
      }

      return {
        sortBy: 'recent' as const,
        sortOrder: 'desc' as const,
      };
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

  const activeFilters = useMemo(() => ({
    statusMode: (filters.includeSends && filters.includeAttempts ? 'both' : filters.includeSends ? 'send' : 'attempt') as StatusMode,
    flashOnly: filters.includeSends ? filters.flashOnly : false,
    minDifficulty: filters.minGrade !== '' ? filters.minGrade : undefined,
    maxDifficulty: filters.maxGrade !== '' ? filters.maxGrade : undefined,
    fromDate: filters.fromDate || undefined,
    toDate: filters.toDate || undefined,
    minAngle: filters.angleRange[0] !== DEFAULT_ANGLE_RANGE[0] ? filters.angleRange[0] : undefined,
    maxAngle: filters.angleRange[1] !== DEFAULT_ANGLE_RANGE[1] ? filters.angleRange[1] : undefined,
    benchmarkOnly: filters.benchmarkOnly || undefined,
  }), [filters]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: [
      'logbookFeed',
      userId,
      boardTypeParam ?? 'all',
      selectedLayoutIds?.join(',') ?? 'all-layouts',
      climbNameParam ?? '',
      JSON.stringify(activeFilters),
      JSON.stringify(sortParams),
    ],
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(token ?? null);
      const variables: GetUserAscentsFeedQueryVariables = {
        userId: userId!,
        input: {
          limit: PAGE_SIZE,
          offset: pageParam,
          ...(boardTypeParam ? { boardType: boardTypeParam } : {}),
          ...(boardTypeParam && selectedLayoutIds && selectedLayoutIds.length !== BOARD_LAYOUT_OPTIONS[boardTypeParam].length
            ? { layoutIds: selectedLayoutIds }
            : {}),
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
    enabled: !!userId && !!token,
    staleTime: 60 * 1000,
  });

  const items: AscentFeedItem[] = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: fetchNextPage,
    hasMore: hasNextPage ?? false,
    isFetching: isFetchingNextPage,
  });

  // Ref-based token to avoid re-rendering all LogbookFeedItem components on auth refresh (E9)
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const pendingDeleteRef = useRef<{ uuid: string; item: AscentFeedItem; timerId: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    return () => {
      if (pendingDeleteRef.current) {
        clearTimeout(pendingDeleteRef.current.timerId);
      }
    };
  }, []);

  const handleDelete = useCallback((uuid: string) => {
    // If there's already a pending delete for a different item, flush it immediately
    if (pendingDeleteRef.current && pendingDeleteRef.current.uuid !== uuid) {
      const { uuid: prevUuid, timerId } = pendingDeleteRef.current;
      clearTimeout(timerId);
      pendingDeleteRef.current = null;
      const client = createGraphQLHttpClient(tokenRef.current ?? null);
      client.request<{ deleteTick: boolean }, DeleteTickMutationVariables>(DELETE_TICK, { uuid: prevUuid }).catch(() => {
        showMessage('Failed to delete tick', 'error');
      });
    }

    // Find and capture the item before removing it from the cache
    const currentData = queryClient.getQueryData<{ pages: { items: AscentFeedItem[]; hasMore: boolean }[] }>(
      ['logbookFeed', userId, boardTypeParam ?? 'all', selectedLayoutIds?.join(',') ?? 'all-layouts', climbNameParam ?? '', JSON.stringify(activeFilters), JSON.stringify(sortParams)]
    );
    const itemToDelete = currentData?.pages.flatMap((p) => p.items).find((i) => i.uuid === uuid);

    // Optimistically remove the item from the cache
    queryClient.setQueryData(
      ['logbookFeed', userId, boardTypeParam ?? 'all', selectedLayoutIds?.join(',') ?? 'all-layouts', climbNameParam ?? '', JSON.stringify(activeFilters), JSON.stringify(sortParams)],
      (old: { pages: { items: AscentFeedItem[]; hasMore: boolean }[]; pageParams: number[] } | undefined) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.filter((i) => i.uuid !== uuid),
          })),
        };
      }
    );

    const timerId = setTimeout(() => {
      pendingDeleteRef.current = null;
      const client = createGraphQLHttpClient(tokenRef.current ?? null);
      client
        .request<{ deleteTick: boolean }, DeleteTickMutationVariables>(DELETE_TICK, { uuid })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['logbookFeed'] });
        })
        .catch(() => {
          // Restore the item on failure
          if (itemToDelete) {
            queryClient.invalidateQueries({ queryKey: ['logbookFeed'] });
          }
          showMessage('Failed to delete tick', 'error');
        });
    }, 5000);

    pendingDeleteRef.current = { uuid, item: itemToDelete ?? ({ uuid } as AscentFeedItem), timerId };

    showMessage('Tick deleted', 'success', {
      label: 'Undo',
      onClick: () => {
        if (pendingDeleteRef.current?.uuid === uuid) {
          clearTimeout(pendingDeleteRef.current.timerId);
          pendingDeleteRef.current = null;
          // Restore the item by refreshing from server
          queryClient.invalidateQueries({ queryKey: ['logbookFeed'] });
        }
      },
    }, 5000);
  }, [queryClient, showMessage, userId, boardTypeParam, selectedLayoutIds, climbNameParam, activeFilters, sortParams]);

  const handleEdit = useCallback((item: AscentFeedItem) => {
    setEditingItemUuid(item.uuid);
  }, []);

  const handleCloseEdit = useCallback(() => {
    setEditingItemUuid(null);
  }, []);

  const showBoardType = boardFilter === 'all';
  const hasFilters = boardFilter !== 'all' || debouncedSearch.length > 0 || !isDefaultFilters(filters);
  const enableInstagramPosting = pathname === '/you/logbook' && isNarrowViewport && isInstagramPostingSupported();
  const enableInstagramLinking = pathname === '/you/logbook';

  const filterButtonActive = !isDefaultFilters(filters);
  const sortButtonActive = !isDefaultSort(sortState);

  const filterBar = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
      <TextField
        size="small"
        placeholder="Search climbs or notes"
        value={searchText}
        onChange={handleSearchChange}
        slotProps={{
          htmlInput: {
            suppressHydrationWarning: true,
            autoComplete: 'off',
            autoCapitalize: 'off',
            autoCorrect: 'off',
            spellCheck: false,
          },
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchOutlined sx={{ fontSize: 20, color: 'text.secondary' }} />
              </InputAdornment>
            ),
          },
        }}
        sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
      />

      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
          {BOARD_OPTIONS.map((opt) => (
            <Chip
              key={opt.value}
              label={boardChipLabels[opt.value]}
              size="small"
              variant={boardFilter === opt.value ? 'filled' : 'outlined'}
              color={boardFilter === opt.value ? 'primary' : 'default'}
              data-board-filter={opt.value}
              onClick={handleBoardChipClick}
            />
          ))}
        </Box>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant={filterButtonActive ? 'contained' : 'outlined'}
            color={filterButtonActive ? 'primary' : 'inherit'}
            size="small"
            startIcon={<FilterListOutlined />}
            onClick={openFilterMenu}
            sx={{ borderRadius: '10px', textTransform: 'none', minWidth: 96 }}
          >
            Filters
          </Button>
          <Button
            variant={sortButtonActive ? 'contained' : 'outlined'}
            color={sortButtonActive ? 'primary' : 'inherit'}
            size="small"
            startIcon={<SwapVertOutlined />}
            onClick={openSortMenu}
            sx={{ borderRadius: '10px', textTransform: 'none', minWidth: 84 }}
          >
            Sort
          </Button>
        </Box>
      </Box>
    </Box>
  );

  if (isLoading) {
    return (
      <>
        {filterBar}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <LogbookItemSkeleton key={i} />
          ))}
        </Box>
      </>
    );
  }

  if (items.length === 0) {
    return (
      <>
        {filterBar}
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
            {userId && !authLoading && !token
              ? 'Logbook unavailable on this device'
              : hasFilters
                ? 'No matching climbs'
                : 'No logged climbs yet'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 300 }}>
            {userId && !authLoading && !token
              ? 'Your account is signed in, but the authenticated data connection did not become available.'
              : hasFilters
                ? 'Try adjusting your filters or sort.'
                : 'Tick your sends and they show up here.'}
          </Typography>
        </div>
        <FilterPopover
          anchorEl={filterAnchorEl}
          draftFilters={draftFilters}
          setDraftFilters={setDraftFilters}
          appliedFilters={filters}
          onClose={closeFilterMenu}
          onApply={applyFilters}
          onClear={clearFilters}
        />
        <SortPopover
          anchorEl={sortAnchorEl}
          draftSortState={draftSortState}
          setDraftSortState={setDraftSortState}
          isAdvancedSortOpen={isAdvancedSortOpen}
          setIsAdvancedSortOpen={setIsAdvancedSortOpen}
          onClose={closeSortMenu}
          onApply={applySort}
          onPresetChange={applyPresetSort}
        />
        {boardFilter !== 'all' && (
          <BoardLayoutsPopover
            anchorEl={boardAnchorEl}
            boardFilter={boardFilter}
            selectedLayoutIds={selectedLayoutIds ?? []}
            setLayoutSelections={setLayoutSelections}
            onClose={closeBoardMenu}
          />
        )}
      </>
    );
  }

  return (
    <>
      {filterBar}
      <div className={feedStyles.feed}>
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          {items.map((item) => (
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
            />
          ))}
        </Box>

        <Box ref={sentinelRef} sx={{ display: 'flex', justifyContent: 'center', py: 2, minHeight: 20 }}>
          {isFetchingNextPage && <CircularProgress size={24} />}
        </Box>
      </div>

      <FilterPopover
        anchorEl={filterAnchorEl}
        draftFilters={draftFilters}
        setDraftFilters={setDraftFilters}
        appliedFilters={filters}
        onClose={closeFilterMenu}
        onApply={applyFilters}
        onClear={clearFilters}
      />
      <SortPopover
        anchorEl={sortAnchorEl}
        draftSortState={draftSortState}
        setDraftSortState={setDraftSortState}
        isAdvancedSortOpen={isAdvancedSortOpen}
        setIsAdvancedSortOpen={setIsAdvancedSortOpen}
        onClose={closeSortMenu}
        onApply={applySort}
        onPresetChange={applyPresetSort}
      />
      {boardFilter !== 'all' && (
        <BoardLayoutsPopover
          anchorEl={boardAnchorEl}
          boardFilter={boardFilter}
          selectedLayoutIds={selectedLayoutIds ?? []}
          setLayoutSelections={setLayoutSelections}
          onClose={closeBoardMenu}
        />
      )}
    </>
  );
}

function FilterPopover({
  anchorEl,
  draftFilters,
  setDraftFilters,
  appliedFilters,
  onClose,
  onApply,
  onClear,
}: {
  anchorEl: HTMLElement | null;
  draftFilters: FilterState;
  setDraftFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  appliedFilters: FilterState;
  onClose: () => void;
  onApply: () => void;
  onClear: () => void;
}) {
  const open = Boolean(anchorEl);
  const clearDisabled = isDefaultFilters(appliedFilters) && isDefaultFilters(draftFilters);

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { width: 420, maxWidth: 'calc(100vw - 24px)', borderRadius: '16px', mt: 1 } } }}
    >
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1 }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700, mb: 0.5 }}>Filter Logbook</Typography>
            <Typography variant="body2" color="text.secondary">Narrow down your climbing history.</Typography>
          </Box>
          <IconButton size="small" onClick={onClose} sx={{ mt: -0.5, mr: -0.5 }}>
            <CloseOutlined fontSize="small" />
          </IconButton>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography variant="caption" color="text.secondary">Result type</Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Chip
              label="Sends"
              size="small"
              variant={draftFilters.includeSends ? 'filled' : 'outlined'}
              color={draftFilters.includeSends ? 'primary' : 'default'}
              onClick={() =>
                setDraftFilters((current) => {
                  if (!current.includeSends && !current.includeAttempts) return current;
                  if (current.includeSends && !current.includeAttempts) return current;
                  return {
                    ...current,
                    includeSends: !current.includeSends,
                    flashOnly: !current.includeSends ? current.flashOnly : false,
                  };
                })
              }
            />
            <Chip
              label="Attempts"
              size="small"
              variant={draftFilters.includeAttempts ? 'filled' : 'outlined'}
              color={draftFilters.includeAttempts ? 'primary' : 'default'}
              onClick={() =>
                setDraftFilters((current) => {
                  if (current.includeAttempts && !current.includeSends) return current;
                  return {
                    ...current,
                    includeAttempts: !current.includeAttempts,
                  };
                })
              }
            />
          </Box>
        </Box>

        <FormControlLabel
          control={
            <Switch
              checked={draftFilters.flashOnly}
              onChange={(_, checked) => setDraftFilters((current) => ({ ...current, flashOnly: checked }))}
              disabled={!draftFilters.includeSends}
            />
          }
          label="Flash only"
          sx={{ m: 0 }}
        />

        <FormControlLabel
          control={
            <Switch
              checked={draftFilters.benchmarkOnly}
              onChange={(_, checked) => setDraftFilters((current) => ({ ...current, benchmarkOnly: checked }))}
            />
          }
          label="Benchmark climbs only"
          sx={{ m: 0 }}
        />

        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.25 }}>
          <FormControl size="small" fullWidth>
            <Select
              displayEmpty
              value={draftFilters.minGrade}
              onChange={(e) => setDraftFilters((current) => ({ ...current, minGrade: e.target.value as number | '' }))}
              sx={{ borderRadius: '10px' }}
            >
              <MenuItem value="">Min grade</MenuItem>
              {BOULDER_GRADES.map((grade) => (
                <MenuItem key={grade.difficulty_id} value={grade.difficulty_id}>{grade.difficulty_name}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <Select
              displayEmpty
              value={draftFilters.maxGrade}
              onChange={(e) => setDraftFilters((current) => ({ ...current, maxGrade: e.target.value as number | '' }))}
              sx={{ borderRadius: '10px' }}
            >
              <MenuItem value="">Max grade</MenuItem>
              {BOULDER_GRADES.map((grade) => (
                <MenuItem key={grade.difficulty_id} value={grade.difficulty_id}>{grade.difficulty_name}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.25 }}>
          <TextField
            size="small"
            type="date"
            label="Start date"
            value={draftFilters.fromDate}
            onChange={(e) => setDraftFilters((current) => ({ ...current, fromDate: e.target.value }))}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
          />
          <TextField
            size="small"
            type="date"
            label="End date"
            value={draftFilters.toDate}
            onChange={(e) => setDraftFilters((current) => ({ ...current, toDate: e.target.value }))}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
          />
        </Box>

        <Box sx={{ px: 0.5 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Wall angle range</Typography>
            <Typography variant="body2" color="primary.main">
              {draftFilters.angleRange[0]}° - {draftFilters.angleRange[1]}°
            </Typography>
          </Box>
          <Slider
            value={draftFilters.angleRange}
            min={0}
            max={70}
            step={5}
            marks={[
              { value: 0, label: '0°' },
              { value: 70, label: '70°' },
            ]}
            onChange={(_, value) => {
              if (Array.isArray(value) && value.length === 2) {
                setDraftFilters((current) => ({ ...current, angleRange: [value[0], value[1]] as [number, number] }));
              }
            }}
            sx={{ mt: 1, mb: 0.5 }}
          />
        </Box>

        <Divider />

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button variant="outlined" color="inherit" onClick={onClear} disabled={clearDisabled} sx={{ textTransform: 'none' }}>Clear</Button>
          <Button variant="contained" onClick={onApply} sx={{ textTransform: 'none' }}>Apply</Button>
        </Box>
      </Box>
    </Popover>
  );
}

function SortPopover({
  anchorEl,
  draftSortState,
  setDraftSortState,
  isAdvancedSortOpen,
  setIsAdvancedSortOpen,
  onClose,
  onApply,
  onPresetChange,
}: {
  anchorEl: HTMLElement | null;
  draftSortState: SortState;
  setDraftSortState: React.Dispatch<React.SetStateAction<SortState>>;
  isAdvancedSortOpen: boolean;
  setIsAdvancedSortOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onClose: () => void;
  onApply: () => void;
  onPresetChange: (preset: SortPreset) => void;
}) {
  const open = Boolean(anchorEl);
  const primaryDirectionOptions = getDirectionOptions(draftSortState.primaryField);
  const secondaryDirectionOptions = getDirectionOptions(draftSortState.secondaryField || 'date');

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { width: 420, maxWidth: 'calc(100vw - 24px)', borderRadius: '16px', mt: 1 } } }}
    >
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1 }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700, mb: 0.5 }}>Sort Logbook</Typography>
            <Typography variant="body2" color="text.secondary">Choose how your entries are ordered.</Typography>
          </Box>
          <IconButton size="small" onClick={onClose} sx={{ mt: -0.5, mr: -0.5 }}>
            <CloseOutlined fontSize="small" />
          </IconButton>
        </Box>

        <Box sx={{ display: 'flex', gap: 1 }}>
          <Chip
            label="Preset"
            size="small"
            variant={draftSortState.mode === 'preset' ? 'filled' : 'outlined'}
            color={draftSortState.mode === 'preset' ? 'primary' : 'default'}
            onClick={() => setDraftSortState((current) => ({ ...current, mode: 'preset' }))}
          />
          <Chip
            label="Custom sort"
            size="small"
            variant={draftSortState.mode === 'custom' ? 'filled' : 'outlined'}
            color={draftSortState.mode === 'custom' ? 'primary' : 'default'}
            onClick={() => setDraftSortState((current) => ({ ...current, mode: 'custom' }))}
          />
        </Box>

        {draftSortState.mode === 'preset' ? (
          <FormControl size="small" fullWidth>
            <Select
              value={draftSortState.preset}
              onChange={(e) => {
                const nextPreset = e.target.value as SortPreset;
                setDraftSortState((current) => ({ ...current, mode: 'preset', preset: nextPreset }));
                onPresetChange(nextPreset);
              }}
              sx={{ borderRadius: '10px' }}
            >
              {SORT_PRESET_OPTIONS.map((option) => (
                <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : (
          <>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.25, mb: 0.5 }}>
              <FormControl size="small" fullWidth>
                <Select
                  value={draftSortState.primaryField}
                  onChange={(e) => setDraftSortState((current) => ({ ...current, primaryField: e.target.value as SortField }))}
                  sx={{ borderRadius: '10px' }}
                >
                  {SORT_FIELD_OPTIONS.map((option) => (
                    <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth>
                <Select
                  value={draftSortState.primaryDirection}
                  onChange={(e) => setDraftSortState((current) => ({ ...current, primaryDirection: e.target.value as SortDirection }))}
                  sx={{ borderRadius: '10px' }}
                >
                  {primaryDirectionOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>

            <Accordion
              expanded={isAdvancedSortOpen}
              onChange={(_, expanded) => setIsAdvancedSortOpen(expanded)}
              disableGutters
              elevation={0}
              sx={{
                mt: 0.5,
                bgcolor: 'transparent',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '12px !important',
                '&:before': { display: 'none' },
              }}
            >
              <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Advanced tie-breaker</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.25 }}>
                  <FormControl size="small" fullWidth>
                    <Select
                      displayEmpty
                      value={draftSortState.secondaryField}
                      onChange={(e) => setDraftSortState((current) => ({ ...current, secondaryField: e.target.value as '' | SortField }))}
                      sx={{ borderRadius: '10px' }}
                    >
                      <MenuItem value="">None</MenuItem>
                      {SORT_FIELD_OPTIONS.map((option) => (
                        <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl size="small" fullWidth disabled={!draftSortState.secondaryField}>
                    <Select
                      value={draftSortState.secondaryDirection}
                      onChange={(e) => setDraftSortState((current) => ({ ...current, secondaryDirection: e.target.value as SortDirection }))}
                      sx={{ borderRadius: '10px' }}
                    >
                      {secondaryDirectionOptions.map((option) => (
                        <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Box>
              </AccordionDetails>
            </Accordion>
          </>
        )}

        {draftSortState.mode === 'custom' && (
          <>
            <Divider />

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <Button variant="outlined" color="inherit" onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
              <Button variant="contained" onClick={onApply} sx={{ textTransform: 'none' }}>Apply</Button>
            </Box>
          </>
        )}
      </Box>
    </Popover>
  );
}

function BoardLayoutsPopover({
  anchorEl,
  boardFilter,
  selectedLayoutIds,
  setLayoutSelections,
  onClose,
}: {
  anchorEl: HTMLElement | null;
  boardFilter: Exclude<BoardFilter, 'all'>;
  selectedLayoutIds: number[];
  setLayoutSelections: React.Dispatch<React.SetStateAction<Record<Exclude<BoardFilter, 'all'>, number[]>>>;
  onClose: () => void;
}) {
  const open = Boolean(anchorEl);
  const options = BOARD_LAYOUT_OPTIONS[boardFilter];

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{ paper: { sx: { width: 280, maxWidth: 'calc(100vw - 24px)', borderRadius: '14px', mt: 1 } } }}
    >
      <Box sx={{ p: 1.5 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
          {BOARD_OPTIONS.find((option) => option.value === boardFilter)?.label} variants
        </Typography>
        <FormGroup>
          {options.map((layout) => (
            <FormControlLabel
              key={layout.id}
              control={
                <Checkbox
                  checked={selectedLayoutIds.includes(layout.id)}
                  onChange={(_, checked) => {
                    setLayoutSelections((current) => {
                      const existing = current[boardFilter];
                      if (!checked && existing.length === 1) return current;

                      return {
                        ...current,
                        [boardFilter]: checked
                          ? Array.from(new Set([...existing, layout.id])).sort((a, b) => a - b)
                          : existing.filter((id) => id !== layout.id),
                      };
                    });
                  }}
                />
              }
              label={layout.name}
              sx={{ mx: 0 }}
            />
          ))}
        </FormGroup>
      </Box>
    </Popover>
  );
}
