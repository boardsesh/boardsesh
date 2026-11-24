// TEMPORARY marketing-capture stories. Not for commit; deleted after the Android capture.
import { deriveProfileViewModel, type LogbookEntry } from '@boardsesh/profile-stats';
import dayjs from 'dayjs';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { selectByVariant } from '../../theme/variants';
import { useStoryBottomInset } from './use-story-bottom-inset';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { useTheme } from '../../providers/theme-provider';
import { ReadableColumn } from '../../components/ReadableColumn';
import { GlassActionToolbar } from '../../components/chrome/GlassActionToolbar';
import { UserAvatarToolbarActionView } from '../../components/user-drawer/UserAvatarToolbarActionView';
import { ProfileTopChromeView } from '../../components/you/ProfileTopChromeView';
import { ProgressView, type ProgressViewData } from '../../components/you/ProgressView';
import { ClimbsStory } from '../../components/climbs/ClimbsMarketingWall.stories';
import queue from '../../components/play-drawer/QueueSheet.stories';
import status from '../../components/board-presence/WallStatus.stories';
import { STORY_BOARDS } from '../fixtures/boards';
import { StoryBoardFixtureContext, type StoryBoardPresentation } from './story-board-fixture';
import type { StoryModule } from './types';
import { PlayerScene } from './PlayerSceneMarketingTmp';

const noop = () => {};
const NOW = dayjs('2026-10-26T12:00:00.000Z');

const BOARDS: { boardType: string; layoutId: number; sends: number; grades: [number, number][] }[] = [
  {
    boardType: 'kilter',
    layoutId: 8,
    sends: 112,
    grades: [
      [16, 38],
      [18, 34],
      [20, 26],
      [22, 14],
    ],
  },
  {
    boardType: 'tension',
    layoutId: 10,
    sends: 64,
    grades: [
      [15, 22],
      [17, 20],
      [19, 14],
      [21, 8],
    ],
  },
  {
    boardType: 'moonboard',
    layoutId: 2,
    sends: 47,
    grades: [
      [16, 18],
      [18, 16],
      [20, 9],
      [21, 4],
    ],
  },
  {
    boardType: 'kilter',
    layoutId: 1,
    sends: 31,
    grades: [
      [14, 12],
      [16, 11],
      [19, 8],
    ],
  },
];

function multiBoardProfile(): ProgressViewData {
  const ticks: Record<string, LogbookEntry[]> = {};
  let index = 0;
  for (const board of BOARDS) {
    const count = Math.round(board.sends / 2);
    for (let tick = 0; tick < count; tick++, index++) {
      const grade = board.grades[tick % board.grades.length][0];
      (ticks[board.boardType] ??= []).push({
        climbed_at: NOW.subtract((index * 7) % 330, 'day').toISOString(),
        difficulty: grade + (tick % 2),
        tries: 1 + (tick % 4),
        angle: 40,
        status: tick % 3 === 0 ? 'flash' : 'send',
        climbUuid: `marketing-${board.boardType}-${board.layoutId}-${tick}`,
        layoutId: board.layoutId,
        boardType: board.boardType,
      } as LogbookEntry);
    }
  }
  const total = BOARDS.reduce((sum, board) => sum + board.sends, 0);
  return {
    ...deriveProfileViewModel({
      allBoardsTicks: ticks,
      selectedBoard: 'all',
      timeframe: 'all',
      fromDate: '',
      toDate: '',
      gradeFormat: 'v-grade',
      comparisonMode: 'trailing',
      now: NOW,
      profileStats: {
        totalDistinctClimbs: total,
        layoutStats: BOARDS.map((board) => ({
          layoutKey: `${board.boardType}-${board.layoutId}`,
          boardType: board.boardType,
          layoutId: board.layoutId,
          distinctClimbCount: board.sends,
          gradeCounts: board.grades.map(([grade, count]) => ({ grade: String(grade), count })),
        })),
      },
    }),
    loading: false,
    refreshing: false,
    refetch: noop,
    retryTotals: noop,
    totalsStatus: 'ready',
    selectedBoard: 'all',
    timeframe: 'all',
    comparisonMode: 'trailing',
    setComparisonMode: noop,
    hasActiveFilters: false,
    percentile: null,
    offline: { isOffline: false, isBlocked: false, reason: null },
  } as ProgressViewData;
}

function ProfileStory() {
  const { variant, systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomInset = useStoryBottomInset();
  const nativeRootHeader = useNativeRootHeader();
  const [topInset, setTopInset] = useState(insets.top + 96);
  const [model] = useState<ProgressViewData>(multiBoardProfile);
  const accountAction = (
    <UserAvatarToolbarActionView
      variant={selectByVariant(variant, { material: 'material', liquidGlass: 'glass' } as const)}
      avatarName="Alex"
      onPress={noop}
    />
  );
  return (
    <View style={[styles.fill, { backgroundColor: systemColors.background }]}>
      <ReadableColumn style={styles.fill}>
        <ProgressView
          data={model}
          topInset={topInset}
          bottomInset={bottomInset}
          nativeRootHeader={nativeRootHeader}
          listTopOffset={0}
          onOpenFilters={noop}
        />
      </ReadableColumn>
      <ProfileTopChromeView
        activeTab="progress"
        displayName="Alex"
        onSelectTab={noop}
        onHeightChange={setTopInset}
        accountAction={selectByVariant(variant, {
          material: accountAction,
          liquidGlass: <GlassActionToolbar actionCount={1}>{accountAction}</GlassActionToolbar>,
        })}
      />
    </View>
  );
}

const homewall: StoryBoardPresentation = { ...STORY_BOARDS['kilter-homewall-7x10'], label: 'Kilter Homewall' };

const stories: StoryModule = {
  title: 'TEMP marketing (Android)',
  stories: {
    kilter: {
      name: 'Player kilter-homewall-7x10',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <PlayerScene {...controls} fixture={STORY_BOARDS['kilter-homewall-7x10']} />,
    },
    tension: {
      name: 'Player tension',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <PlayerScene {...controls} fixture={STORY_BOARDS['tension']} />,
    },
    moonboard: {
      name: 'Player moonboard',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <PlayerScene {...controls} fixture={STORY_BOARDS['moonboard']} />,
    },
    spray: {
      name: 'Player spray-liz',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <PlayerScene {...controls} fixture={STORY_BOARDS['spray-liz']} />,
    },
    profile: {
      name: 'Profile across boards',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <ProfileStory />,
    },
    wall: {
      name: 'Climbs with the climb on the wall',
      layout: 'fullscreen',
      tab: 'climbs',
      readiness: 'explicit',
      render: ({ onReady, onError }) => (
        <StoryBoardFixtureContext value={homewall}>
          <ClimbsStory scene="populated" onReady={onReady} onError={onError} />
        </StoryBoardFixtureContext>
      ),
    },
    queue: {
      ...queue.stories['up-next'],
      name: 'Queue on Kilter Homewall',
      render: (controls) => (
        <StoryBoardFixtureContext value={homewall}>
          {queue.stories['up-next'].render(controls)}
        </StoryBoardFixtureContext>
      ),
    },
    status: {
      ...status.stories.connected,
      name: 'Now on the wall, Kilter Homewall',
      render: (controls) => (
        <StoryBoardFixtureContext value={homewall}>
          {status.stories.connected.render(controls)}
        </StoryBoardFixtureContext>
      ),
    },
  },
};
export default stories;
const styles = StyleSheet.create({ fill: { flex: 1 } });
