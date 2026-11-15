import { selectByVariant } from '../../theme/variants';
import { useStoryBottomInset } from '../../dev/stories/use-story-bottom-inset';
import {
  buildLogbookListRows,
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  type LogbookFilterState,
  type LogbookListRow,
} from '@boardsesh/logbook';
import { formatGrade } from '@boardsesh/play-view';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';
import { buildStoryAscents } from '../../dev/fixtures/ascents';
import { useStoryBoardFixture } from '../../dev/stories/story-board-fixture';
import type { StoryModule } from '../../dev/stories/types';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { useTheme } from '../../providers/theme-provider';
import { UserAvatarToolbarActionView } from '../user-drawer/UserAvatarToolbarActionView';
import { LogbookChipRow } from './LogbookChipRow';
import { LogbookDayDividerView, LogbookWallSubDivider } from './LogbookDayDividerView';
import { LogbookRowView, type LogbookRowViewProps } from './LogbookRowView';
import { LogbookView, type LogbookGroupUnit } from './LogbookView';
import { ProfileTopChromeView } from './ProfileTopChromeView';
const noop = () => {};
const formatStoryGrade = (grade: string | null | undefined, board?: string | null) =>
  formatGrade(grade, 'v-grade', board);
const noDifficultyGrade = () => null;
const EMPTY_MENU: LogbookRowViewProps['menu'] = {
  rows: [],
  menuKey: 'story-logbook',
  onSelectIndex: noop,
  accessibilityActions: [],
  onAccessibilityAction: noop,
};
const NOW = Date.parse('2026-10-26T12:00:00Z');
function LogbookStory({ state = 'ready' }: { state?: 'ready' | 'loading' | 'empty' | 'error' | 'offline' }) {
  const fixture = useStoryBoardFixture();
  const ascents = useMemo(() => buildStoryAscents(fixture), [fixture]);
  const { i18n } = useTranslation('you');
  const { variant } = useTheme();
  const nativeRootHeader = useNativeRootHeader();
  const bottomInset = useStoryBottomInset();
  const { fontScale } = useWindowDimensions();
  const [headerHeight, setHeaderHeight] = useState(0);
  const [filters, setFilters] = useState<LogbookFilterState>(() => ({
    ...DEFAULT_LOGBOOK_FILTERS,
    includeSends: !fixture.attemptsOnly,
    includeAttempts: true,
    boardType: fixture.board.boardName,
    layoutIds: [fixture.board.layoutId],
  }));
  const changeFilters = useCallback(
    (patch: Partial<LogbookFilterState>) => setFilters((previous) => ({ ...previous, ...patch })),
    [],
  );
  const rows = useMemo(
    () =>
      buildLogbookListRows(state === 'ready' ? ascents.map((ascent) => ({ ...ascent, wall: fixture.label })) : [], {
        hasMore: false,
      }),
    [state, ascents, fixture.label],
  );
  const renderItem = useCallback(
    ({ item }: { item: LogbookListRow<LogbookGroupUnit> }) => {
      if (item.type === 'divider')
        return (
          <LogbookDayDividerView
            dayStartMs={item.dayStartMs}
            stats={item.stats}
            wallLabel={item.wallLabel}
            now={NOW}
            formatGrade={formatStoryGrade}
          />
        );
      if (item.type === 'subdivider') return <LogbookWallSubDivider wallLabel={item.wallLabel} />;
      return (
        <LogbookRowView
          ascent={item.item}
          onActivate={noop}
          menu={EMPTY_MENU}
          boardseshActive={false}
          formatGrade={formatStoryGrade}
          formatGradeByDifficultyId={noDifficultyGrade}
          fontScale={fontScale}
          showBoardInMeta={!item.wallCovered}
        />
      );
    },
    [fontScale],
  );
  const controls = (
    <LogbookChipRow
      pinned={['status', 'date', 'sort']}
      filters={filters}
      sort={DEFAULT_LOGBOOK_SORT}
      name=""
      viewerIsOwner
      gradeStops={[]}
      boardOptions={[]}
      locale={i18n.language}
      openRail={null}
      onOpenFilters={noop}
      onOpenCustomDates={noop}
      onToggleRail={noop}
      onChangeFilters={changeFilters}
      onChangeSort={noop}
      onOpenSetters={noop}
    />
  );
  return (
    <View style={{ flex: 1 }}>
      <LogbookView
        userId="story"
        viewerIsOwner
        hasComposedHeader
        controls={controls}
        header={
          <ProfileTopChromeView
            activeTab="logbook"
            displayName="Alex"
            onSelectTab={noop}
            onHeightChange={setHeaderHeight}
            accountAction={
              <UserAvatarToolbarActionView
                avatarName="Alex"
                variant={selectByVariant(variant, { material: 'material', liquidGlass: 'glass' } as const)}
                onPress={noop}
              />
            }
          >
            {controls}
          </ProfileTopChromeView>
        }
        headerMeasured={headerHeight > 0}
        nativeRootHeader={nativeRootHeader}
        headerHeight={headerHeight}
        scrollHeaderInset={nativeRootHeader ? headerHeight : 0}
        paddingBottom={bottomInset + 24}
        offline={{
          isOffline: state === 'offline',
          isBlocked: state === 'offline',
          reason: state === 'offline' ? 'offline' : null,
        }}
        isFiltered={!!fixture.attemptsOnly}
        listRows={rows}
        renderItem={renderItem}
        handleRetry={noop}
        handleRefresh={noop}
        handleEndReached={noop}
        handleClearFilters={noop}
        feed={{
          isPending: state === 'loading',
          isError: state === 'error',
          isRefetching: false,
          isFetchingNextPage: false,
        }}
      />
    </View>
  );
}
const stories: StoryModule = {
  title: 'You / Logbook',
  stories: {
    populated: {
      name: 'Logged climbs grouped by day',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <LogbookStory />,
    },
    empty: {
      name: 'No ascents yet',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <LogbookStory state="empty" />,
    },
    loading: {
      name: 'Loading ascents',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <LogbookStory state="loading" />,
    },
    error: {
      name: 'Could not load ascents',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <LogbookStory state="error" />,
    },
    offline: {
      name: 'Offline without saved ascents',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <LogbookStory state="offline" />,
    },
  },
};
export default stories;
