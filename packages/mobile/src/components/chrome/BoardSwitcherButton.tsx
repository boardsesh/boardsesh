import { useMemo } from 'react';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { canAdjustBoardAngle } from '../../lib/boards/can-adjust-board-angle';
import { MaterialAppBarTitle } from './MaterialAppBarTitle';

type BoardSwitcherButtonProps = {
  /** The destination's name, shown as the headline ("Discover", "Climbs"). */
  title: string;
  /** What a tap does — open the board switcher (the `/boards` modal). */
  onPress: () => void;
  /** VoiceOver / TalkBack hint, e.g. "Opens the board switcher". */
  accessibilityHint?: string;
  /** Show a brand-coloured dot near the trailing caret — the one-time onboarding
   *  cue pointing a new user at this control. */
  badge?: boolean;
  /** Screenshot mode only: log this button's rect as the showcase video's
   *  `board-history-button` (the Material twin of the glass board glyph). */
  showcaseAnchor?: boolean;
};

/**
 * The Material variant's board switcher: the screen's name as the app-bar title,
 * with the active board ("Kilter • M", or "Garage Wall" for a named board) as a
 * subtitle and a down-caret, the whole block one tap target. It is the flat M3
 * counterpart of the liquid-glass `BoardToolbarAction`. An adjustable board's
 * angle rides its own control, so the subtitle drops it; a fixed-angle wall keeps
 * it. With no board set the title stands alone and is not a button.
 */
export function BoardSwitcherButton({
  title,
  onPress,
  accessibilityHint,
  badge = false,
  showcaseAnchor = false,
}: BoardSwitcherButtonProps) {
  const { data: activeBoard } = useActiveBoard();
  const boardLabel = useMemo(
    () => formatActiveBoardLabel(activeBoard, { includeAngle: !canAdjustBoardAngle(activeBoard) }),
    [activeBoard],
  );

  if (!boardLabel) return <MaterialAppBarTitle title={title} />;

  return (
    <MaterialAppBarTitle
      title={title}
      subtitle={boardLabel}
      onPress={onPress}
      accessibilityHint={accessibilityHint}
      badge={badge}
      showcaseAnchor={showcaseAnchor}
    />
  );
}
