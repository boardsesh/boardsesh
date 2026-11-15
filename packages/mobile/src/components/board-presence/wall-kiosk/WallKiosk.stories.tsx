import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { resolveDisplayGrade } from '../../../lib/boardsesh-grade-display';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { getBoardRenderData } from '../../../lib/board-details';
import { useStoryBoardFixture } from '../../../dev/stories/story-board-fixture';
import { StoryBoard } from '../../../dev/stories/StoryBoard';
import type { StoryModule, StoryRenderControls } from '../../../dev/stories/types';
import { WallKioskView } from './WallKioskView';
import { WallChromeRegionView } from './WallChromeRegionView';
import { WallIdentityBlockView } from './WallIdentityBlockView';
import { WallStateStripView } from './WallStateStripView';
import { WallScrubberView } from './WallScrubberView';
import { WallIdleRecoveryView } from './WallIdleRecoveryView';
import type { WallPreviewState } from './useWallPreview';

const noop = () => {};
function WallScene({
  initialHistory = false,
  idle = false,
  ...controls
}: StoryRenderControls & { initialHistory?: boolean; idle?: boolean }) {
  const { board: STORY_BOARD, climbs: STORY_CLIMBS } = useStoryBoardFixture();
  const presenceClimbs = useMemo(
    () =>
      STORY_CLIMBS.map(
        (climb, seq) =>
          ({
            climbUuid: climb.uuid,
            name: climb.name,
            grade: climb.difficulty,
            frames: climb.frames,
            sentAt: '2026-11-15T10:00:00.000Z',
            seq,
            angle: STORY_BOARD.angle,
          }) satisfies BoardPresenceClimb,
      ),
    [STORY_CLIMBS, STORY_BOARD],
  );

  const [position, setPosition] = useState(initialHistory ? 1 : 0);
  const renderData = useMemo(
    () => getBoardRenderData({ ...STORY_BOARD, setIds: STORY_BOARD.setIds.split(',').map(Number) }),
    [STORY_BOARD],
  );
  const climb = presenceClimbs[position];
  const { gradeFormat } = useGradeFormat();
  const gradeOptions = { useBoardseshGrades: false, gradeFormat, boardName: STORY_BOARD.boardName };
  const resolvedGrade = resolveDisplayGrade({ difficulty: climb.grade }, gradeOptions);
  const liveResolvedGrade = resolveDisplayGrade({ difficulty: presenceClimbs[0].grade }, gradeOptions);
  const preview: WallPreviewState = {
    displayedClimb: idle ? null : climb,
    liveClimb: idle ? null : presenceClimbs[0],
    previewClimb: position ? climb : null,
    isPreviewing: position > 0,
    stepsBack: position,
    previewTimestamp: position ? climb.sentAt : null,
    historyCount: presenceClimbs.length,
    lastLitClimb: idle ? presenceClimbs[0] : null,
    canStepOlder: position < presenceClimbs.length - 1,
    canStepNewer: position > 0,
    isLoadingOlder: false,
    step: (direction) =>
      setPosition((current) =>
        Math.max(0, Math.min(presenceClimbs.length - 1, current + (direction === 'older' ? 1 : -1))),
      ),
    goOldest: () => setPosition(presenceClimbs.length - 1),
    backToLive: () => setPosition(0),
    canLight: true,
    lightBlockedReason: null,
    isLighting: false,
    lightError: false,
    lightThis: () => setPosition(0),
    pendingOverride: false,
    confirmOverride: noop,
    cancelOverride: noop,
  };
  const mode = idle ? 'idle' : position > 0 ? 'history' : 'live';
  return (
    <WallKioskView
      renderData={renderData}
      emptyState={null}
      renderBoard={(width, height) => (
        <View style={{ width, height }}>
          <StoryBoard
            {...controls}
            board={STORY_BOARD}
            climb={idle ? { ...STORY_CLIMBS[0], frames: '' } : STORY_CLIMBS[position]}
          />
        </View>
      )}
      renderChrome={({ region, bandWidth, typeScale }) => (
        <WallChromeRegionView
          region={region}
          bandWidth={bandWidth}
          stateStrip={
            <WallStateStripView
              mode={mode}
              stepsBack={position}
              previewTimestamp={preview.previewTimestamp}
              liveClimb={preview.liveClimb}
              typeScale={typeScale}
              ledless={false}
              liveResolvedGrade={liveResolvedGrade}
              detailLine={position ? '5m' : null}
            />
          }
          identity={
            idle ? (
              <WallIdleRecoveryView
                lastLitClimb={presenceClimbs[0]}
                typeScale={typeScale}
                ledless={false}
                resolvedGrade={resolvedGrade}
                relativeTime="5m"
              />
            ) : (
              <WallIdentityBlockView
                climb={climb}
                typeScale={typeScale}
                isPreviewing={position > 0}
                resolvedGrade={resolvedGrade}
              />
            )
          }
          scrubber={<WallScrubberView preview={preview} ledless={false} onConnect={noop} />}
        />
      )}
    />
  );
}
const stories: StoryModule = {
  title: 'Wall display',
  stories: {
    live: {
      name: 'Live climb',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <WallScene {...controls} />,
    },
    history: {
      name: 'Browse wall history',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <WallScene {...controls} initialHistory />,
    },
    idle: {
      name: 'Wall dark',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <WallScene {...controls} idle />,
    },
  },
};
export default stories;
