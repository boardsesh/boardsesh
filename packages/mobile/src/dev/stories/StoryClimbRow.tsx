import { memo, createContext, useContext, useMemo, useCallback, type ReactNode, type ComponentProps } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { resolveDisplayGrade } from '../../lib/boardsesh-grade-display';
import { View } from 'react-native';
import { useStoryBoardFixture } from './story-board-fixture';
import { StorySprayBoard } from './StorySprayBoard';
import { useClimbListThumbnailSize } from '../../components/climb-list-thumbnail-metrics';
import { DEFAULT_CLIMB_ROW_DISPLAY } from '../../lib/climb-row-display';
import { ClimbListRowView, type ClimbListRowViewProps } from '../../components/ClimbListRow';
import {
  ClimbListItemContentView,
  ClimbGradeView,
  ClimbSubtitleView,
  ClimbAscentStatusView,
  type ClimbRowLeaves,
} from '../../components/ClimbListItemContent';
import { ClimbListThumbnail } from '../../components/ClimbListThumbnail';
import { useStoryBoardRenderStyle } from '../fixtures/board-render-style';
type StoryClimbArtObserver = { onDisplayed: (uuid: string) => void; onError: (error: unknown) => void };
const StoryClimbArtContext = createContext<StoryClimbArtObserver | null>(null);
export function StoryClimbArtObserverProvider({
  onDisplayed,
  onError,
  children,
}: StoryClimbArtObserver & { children: ReactNode }) {
  const observer = useMemo(() => ({ onDisplayed, onError }), [onDisplayed, onError]);
  return <StoryClimbArtContext.Provider value={observer}>{children}</StoryClimbArtContext.Provider>;
}
export function StoryClimbThumbnail({
  onArtDisplayed,
  onArtError,
  ...props
}: ComponentProps<typeof ClimbListThumbnail>) {
  const renderStyle = useStoryBoardRenderStyle();
  const fixture = useStoryBoardFixture();
  const listSize = useClimbListThumbnailSize();
  const observer = useContext(StoryClimbArtContext);
  const reportDisplayed = useCallback(() => {
    onArtDisplayed?.();
    if (props.climbUuid) observer?.onDisplayed(props.climbUuid);
  }, [onArtDisplayed, observer, props.climbUuid]);
  const reportError = useCallback(
    (error: unknown) => {
      onArtError?.(error);
      observer?.onError(error);
    },
    [onArtError, observer],
  );
  if (props.boardName === 'spray') {
    if (!fixture.spray || fixture.board.layoutId !== props.layoutId)
      throw new Error('Spray thumbnail has no matching story geometry');
    return (
      <View style={props.size ?? listSize}>
        <StorySprayBoard
          geometry={fixture.spray}
          frames={props.frames}
          mirrored={props.mirrored}
          onReady={reportDisplayed}
          onError={reportError}
        />
      </View>
    );
  }
  return (
    <ClimbListThumbnail
      {...props}
      onArtDisplayed={reportDisplayed}
      onArtError={reportError}
      renderStyleOverride={renderStyle}
    />
  );
}
const noContent = () => null;
const noop = () => {};
export function StoryClimbGrade({ climb, boardName }: ComponentProps<NonNullable<ClimbRowLeaves['Grade']>>) {
  const { gradeFormat } = useGradeFormat();
  const grade = resolveDisplayGrade(climb, { useBoardseshGrades: false, gradeFormat, boardName });
  return (
    <ClimbGradeView
      label={grade.label}
      color={grade.color}
      markedAsMine={false}
      isProject={false}
      setAtAngle={null}
      reserveSetAngleLine={false}
    />
  );
}

const leaves: Required<ClimbRowLeaves> = {
  Thumbnail: StoryClimbThumbnail,
  Grade: StoryClimbGrade,
  Subtitle: (props) => <ClimbSubtitleView {...props} communityGrade={null} />,
  AscentStatus: (props) => <ClimbAscentStatusView {...props} ascentStatus={null} mirrorStatus={null} />,
  Favorite: noContent,
  Progress: noContent,
  PlaylistChips: noContent,
};

export const renderStoryClimbContent: (
  props: Omit<ComponentProps<typeof ClimbListItemContentView>, 'display' | 'leaves'>,
) => React.ReactNode = (props) => (
  <ClimbListItemContentView {...props} display={DEFAULT_CLIMB_ROW_DISPLAY} leaves={leaves} />
);

const menu: ClimbListRowViewProps['menu'] = {
  rows: [],
  onSelectIndex: noop,
  menuKey: 'story-row',
  accessibilityActions: [],
  onAccessibilityAction: noop,
};
export const StoryClimbRow = memo(function StoryClimbRow({
  climb,
  onPress = noop,
  selected = false,
}: {
  climb: Climb;
  onPress?: (climb: Climb) => void;
  selected?: boolean;
}) {
  const { board } = useStoryBoardFixture();
  return (
    <ClimbListRowView
      {...board}
      climb={climb}
      onPress={onPress}
      selected={selected}
      quickActionsEnabled={false}
      thumbnailEnabled
      renderContent={renderStoryClimbContent}
      menu={menu}
    />
  );
});
