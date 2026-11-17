import { PlayDrawerHeader, type PreparedHeaderProps } from './PlayDrawerHeaderView';
export {
  PlayDrawerHeader,
  describePlayDrawerGrade,
  describePlayDrawerHeader,
  NAME_SHRINK_TO_FIT_SCALE,
} from './PlayDrawerHeaderView';
export type { PreparedHeaderProps } from './PlayDrawerHeaderView';
import { memo, useMemo, type ReactNode } from 'react';
import { type BoardName, type Climb } from '@boardsesh/shared-schema';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useMyGrade } from '../../hooks/use-my-grade';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { useBoldText } from '../../hooks/use-bold-text';
import { renderDifficulty } from '../../lib/boardsesh-grade-display';
import { derivePersonalGradeDisplay } from '@boardsesh/logbook';
import { splitGradeLabel } from '@boardsesh/play-view';

export type LivePlayDrawerHeaderProps = {
  climb: Climb | null;
  boardName: BoardName;
  layoutId: number;
  angle: number;
  leading?: ReactNode;
  onLongPressName?: () => void;
  onPressSetter?: () => void;
};

export type LivePlayDrawerHeaderModel = Readonly<{
  headerProps: Readonly<PreparedHeaderProps>;
  layoutFingerprint: string;
  reduceMotion: boolean;
}>;

/** Derive the current visual and its geometry identity from the SAME live reads. */
export function useLivePlayDrawerHeaderModel({
  climb,
  boardName,
  layoutId,
  angle,
  leading,
  onLongPressName,
  onPressSetter,
}: LivePlayDrawerHeaderProps): LivePlayDrawerHeaderModel | null {
  const { resolveGrade } = useDisplayGrade();
  const { gradeFormat } = useGradeFormat();
  const liveStats = useEffectiveClimbStats(
    boardName,
    layoutId,
    climb?.uuid ?? '',
    angle,
    {
      ascensionistCount: climb?.ascensionist_count,
      qualityAverage: climb?.quality_average,
      difficulty: climb?.difficulty,
    },
    { enabled: climb !== null },
  );
  const displayedGrade = resolveGrade(
    {
      ...climb,
      difficulty: liveStats.difficulty,
    },
    boardName,
  );

  // Your grade wins over the crowd's. Resolved ABOVE `resolveGrade`, never
  // inside it — that resolver's contract is community-grades-only.
  // Falls back to the device's own ticks table while the logbook is unresolved,
  // so the drawer shows the climber's grade offline too — the same grade the
  // on-device search placed this climb by.
  const myGrade = useMyGrade(climb?.uuid ?? '', angle, { localFallback: climb !== null });
  const mine = myGrade.status === 'set' ? renderDifficulty(myGrade.difficultyId, gradeFormat, boardName) : null;
  const personal = derivePersonalGradeDisplay(mine?.label ?? null, displayedGrade.label);
  const showsMine = personal.source === 'personal' && mine !== null;

  const reduceMotion = useReduceMotion();
  const boldText = useBoldText();
  const difficulty = showsMine ? mine.label : displayedGrade.label;
  const gradeColor = showsMine ? mine.color : displayedGrade.color;
  const markedAsMine = showsMine && personal.markPrimary;
  const secondaryGrade = showsMine ? (splitGradeLabel(personal.secondaryLabel)[0] ?? null) : null;
  const characteristicsFingerprint = JSON.stringify(climb?.characteristics ?? null);
  const hasLeading = leading != null;
  const hasLongPressName = onLongPressName !== undefined;
  const hasSetterAction = onPressSetter !== undefined;

  return useMemo(() => {
    if (!climb) return null;
    const headerProps: PreparedHeaderProps = {
      name: climb.name,
      difficulty,
      rawDifficulty: liveStats.difficulty,
      gradeColor,
      markedAsMine,
      secondaryGrade,
      qualityAverage: liveStats.qualityAverage,
      ascensionistCount: liveStats.ascensionistCount,
      setterUsername: climb.setter_username,
      benchmarkDifficulty: climb.benchmark_difficulty,
      characteristics: climb.characteristics,
      isNoMatch: climb.is_no_match,
      boardName,
      isHidden: climb.is_hidden === true,
      isDraft: climb.is_draft === true,
      statsAngle: climb.statsAngle,
      angle,
    };
    return Object.freeze({
      headerProps: Object.freeze(headerProps),
      reduceMotion,
      // Translation, viewport and safe-area fields live in the outer layout
      // identity. Every header output and layout-affecting control lives here.
      layoutFingerprint: JSON.stringify([
        headerProps,
        hasLeading,
        hasLongPressName,
        hasSetterAction,
        reduceMotion,
        boldText,
      ]),
    });
  }, [
    climb?.name,
    difficulty,
    liveStats.difficulty,
    gradeColor,
    markedAsMine,
    secondaryGrade,
    liveStats.qualityAverage,
    liveStats.ascensionistCount,
    climb?.setter_username,
    climb?.benchmark_difficulty,
    characteristicsFingerprint,
    climb?.is_no_match,
    boardName,
    climb?.is_hidden,
    climb?.is_draft,
    climb?.statsAngle,
    angle,
    hasLeading,
    hasLongPressName,
    hasSetterAction,
    reduceMotion,
    boldText,
  ]);
}

/** Pure prepared visual: observes no live stats or personal-grade sources. */
export const PreparedPlayDrawerHeader = memo(function PreparedPlayDrawerHeader({
  model,
  leading,
  onLongPressName,
  onPressSetter,
  peek,
}: Pick<LivePlayDrawerHeaderProps, 'leading' | 'onLongPressName' | 'onPressSetter'> & {
  model: LivePlayDrawerHeaderModel;
  peek?: boolean;
}) {
  return (
    <PlayDrawerHeader
      {...model.headerProps}
      onPressSetter={onPressSetter}
      leading={leading}
      onLongPressName={onLongPressName}
      peek={peek}
    />
  );
});

type SwipeHeaderProps = LivePlayDrawerHeaderProps & {
  /**
   * The current climb's model, already derived for the screen-reader stand-in.
   * When given, `climb` is not read: the header observes nothing of its own.
   */
  model?: LivePlayDrawerHeaderModel | null;
  /** A neighbour in the swipe; see `PlayDrawerHeader`'s `peek`. */
  peek?: boolean;
};

/**
 * Every header in the swipe, the current climb's and its neighbours', is this
 * one component. A neighbour that becomes current keeps its mounted header and
 * only gains its handlers: a different component there remounted the header at
 * the commit, after the title had already landed.
 */
export const LivePlayDrawerHeader = memo(function LivePlayDrawerHeader({ model, peek, ...props }: SwipeHeaderProps) {
  const derived = useLivePlayDrawerHeaderModel(model ? { ...props, climb: null } : props);
  const resolved = model ?? derived;
  return resolved ? (
    <PreparedPlayDrawerHeader
      model={resolved}
      leading={props.leading}
      onLongPressName={props.onLongPressName}
      onPressSetter={props.onPressSetter}
      peek={peek}
    />
  ) : null;
});
