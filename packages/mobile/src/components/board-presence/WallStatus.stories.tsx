import { useGradeFormat } from '../../hooks/use-grade-format';
import { useStorySheetPresentation } from '../../dev/stories/use-story-sheet-presentation';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { View, FlatList } from 'react-native';
import type { BottomSheetModal } from '@expo/ui/community/bottom-sheet';
import type { BoardPresenceClimb, Climb } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { STORY_BOARD, STORY_CLIMBS } from '../../dev/fixtures/climbs';
import { useStoryBoardRenderStyle } from '../../dev/fixtures/board-render-style';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { useVisibleArtReadiness } from '../../dev/stories/use-visible-art-readiness';
import { useTheme } from '../../providers/theme-provider';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { AccessoryClimbThumbnail } from '../queue-control/AccessoryClimbThumbnail';
import { BoardSheetView } from './BoardSheetView';
import { NowOnTheWallPanelView } from './NowOnTheWallPanelView';
import { WallHeroContentView, WallHistoryContentView } from './WallPanelRowViews';
import { WallStatTile } from './WallPanelStatsViews';
import { styles } from './wall-panel-styles';

const noop = () => {};
const presence = STORY_CLIMBS.slice(0, 3).map((climb, index): BoardPresenceClimb => ({
  climbUuid: climb.uuid,
  name: climb.name,
  frames: climb.frames,
  grade: climb.difficulty,
  angle: STORY_BOARD.angle,
  seq: index,
  sentAt: '2026-11-15T10:00:00Z',
  sentByDisplayName: index ? 'Alex' : 'Sam',
  setter: climb.setter_username,
}));
const keyExtractor = (climb: BoardPresenceClimb) => climb.climbUuid;
const sampleFor = (presenceClimb: BoardPresenceClimb): Climb =>
  STORY_CLIMBS.find((climb) => climb.uuid === presenceClimb.climbUuid)!;
const Thumbnail = memo(function Thumbnail({
  climb,
  onReady,
  onError,
}: {
  climb: BoardPresenceClimb;
  onReady: (uuid: string) => void;
  onError: (error: unknown) => void;
}) {
  const renderStyle = useStoryBoardRenderStyle();
  const report = useCallback(
    (state: 'loading' | 'ready' | 'failed') => {
      if (state === 'ready') onReady(climb.climbUuid);
      if (state === 'failed') onError(new Error('Wall history art failed'));
    },
    [climb.climbUuid, onReady, onError],
  );
  return (
    <AccessoryClimbThumbnail
      climb={sampleFor(climb)}
      boardConfig={STORY_BOARD}
      renderStyleOverride={renderStyle}
      onArtReadinessChange={report}
    />
  );
});
export function WallStatusScene({ onReady, onError }: StoryRenderControls) {
  const { systemColors, brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const { t } = useTranslation('session');
  const ref = useRef<BottomSheetModal>(null);
  const managed = useStorySheetPresentation(ref);
  const presented = managed.presented;
  const [heroReady, setHeroReady] = useState(false);
  const [rowsReady, setRowsReady] = useState(false);
  const reportRowsReady = useCallback(() => setRowsReady(true), []);
  const { onDisplayed, onViewableItemsChanged } = useVisibleArtReadiness(keyExtractor, reportRowsReady);
  const reportHero = useCallback(() => setHeroReady(true), []);
  useEffect(() => {
    if (presented && heroReady && rowsReady) onReady();
  }, [presented, heroReady, rowsReady, onReady]);
  const renderRow = useCallback(
    ({ item }: { item: BoardPresenceClimb }) => (
      <View style={styles.historyRow}>
        <WallHistoryContentView
          climb={item}
          renderClimb={sampleFor(item)}
          boardConfig={STORY_BOARD}
          labelColor={systemColors.label}
          secondaryColor={systemColors.secondaryLabel}
          formattedGrade={formatGrade(item.grade, STORY_BOARD.boardName)}
          gradeColor={getGradeColor(item.grade ?? '') ?? DEFAULT_GRADE_COLOR}
          sentAgo="5m"
          pressableAvatar={false}
          thumbnail={<Thumbnail climb={item} onReady={onDisplayed} onError={onError} />}
        />
      </View>
    ),
    [systemColors, onDisplayed, onError, formatGrade],
  );
  const header = (
    <>
      <View style={[styles.hero, { backgroundColor: systemColors.secondaryBackground }]}>
        <WallHeroContentView
          climb={presence[0]}
          renderClimb={sampleFor(presence[0])}
          boardConfig={STORY_BOARD}
          labelColor={systemColors.label}
          secondaryColor={systemColors.secondaryLabel}
          accentColor={brandColors.warning}
          formattedGrade={formatGrade(presence[0].grade, STORY_BOARD.boardName)}
          gradeColor={getGradeColor(presence[0].grade ?? '') ?? DEFAULT_GRADE_COLOR}
          pressableAvatar={false}
          thumbnail={<Thumbnail climb={presence[0]} onReady={reportHero} onError={onError} />}
        />
      </View>
      <View style={styles.statsBlock}>
        <Text variant="footnote" style={styles.sectionHeader}>
          {t('mobile.boardPresence.statsHeader')}
        </Text>
        <View style={styles.statTiles}>
          {[
            { count: '24', label: t('mobile.boardPresence.statSent', { count: 24 }) },
            { count: '4', label: t('mobile.boardPresence.statClimbers', { count: 4 }) },
            { count: 'V6', label: t('mobile.boardPresence.statHardest') },
            { count: 'V4', label: t('mobile.boardPresence.statTopGrade') },
          ].map((tile) => (
            <WallStatTile
              key={tile.label}
              value={tile.count}
              label={tile.label}
              surfaceColor={systemColors.secondaryBackground}
              labelColor={systemColors.secondaryLabel}
              valueColor={systemColors.label}
            />
          ))}
        </View>
      </View>
      <Text variant="footnote" style={styles.sectionHeader}>
        {t('mobile.boardPresence.historyHeader')}
      </Text>
    </>
  );
  return (
    <BoardSheetView ref={ref} onChange={managed.onChange} onFullyDismissed={managed.onFullyDismissed}>
      <NowOnTheWallPanelView
        variant="sheet"
        boardLabel="Kilter Original"
        headerTopPadding={0}
        footerBottomPadding={0}
        onClose={managed.handle.dismiss}
        onSwitchBoard={noop}
        list={
          <FlatList
            onLayout={managed.onLayout}
            data={presence.slice(1)}
            keyExtractor={keyExtractor}
            renderItem={renderRow}
            ListHeaderComponent={header}
            onViewableItemsChanged={onViewableItemsChanged}
          />
        }
      />
    </BoardSheetView>
  );
}
const stories: StoryModule = {
  title: 'Wall status',
  stories: {
    connected: {
      name: 'Now on the wall',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <WallStatusScene {...controls} />,
    },
  },
};
export default stories;
