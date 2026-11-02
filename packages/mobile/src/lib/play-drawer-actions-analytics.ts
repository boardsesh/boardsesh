import type { PlayerBoardControl } from './player-buttons';
import type { ActionBarLayout } from '../components/play-drawer/action-bar-layout';
import type { WallControlState } from '../components/play-drawer/wall-control';

export type PlayDrawerActionsContext = {
  player_layout_version: 3;
  /** Comma-separated slots, with '-' for a reserved empty position. */
  player_primary_slots: string;
  /** Resolved secondary actions; visibility is reported separately. */
  player_secondary_actions: string;
  player_visible_actions: string;
  player_previous_next: boolean;
  player_board_control: PlayerBoardControl;
  player_tick_size: number;
  player_tick_visible: boolean;
  player_share_visible: boolean;
};

type DrawerAction = string | null;

/** Unlike Wall Control Shown's connect-only bulb gate, this describes the rendered UI. */
export function isPlayDrawerWallControlRendered(layout: ActionBarLayout, state: WallControlState): boolean {
  if (layout.trailingSlot === 'lightbulb') return true;
  if (state === null) return false;
  return (
    layout.primaryCenter === 'wallControl' ||
    layout.primaryCenter === 'wallControlFull' ||
    (typeof layout.secondaryRow !== 'string' && layout.secondaryRow.includes('wallControl'))
  );
}

export function buildPlayDrawerActionsContext({
  layout,
  boardControl,
  hasShare,
  wallControlVisible,
  primaryVisible = true,
  secondaryVisible = true,
}: {
  layout: ActionBarLayout;
  boardControl: PlayerBoardControl;
  hasShare: boolean;
  wallControlVisible: boolean;
  primaryVisible?: boolean;
  secondaryVisible?: boolean;
}): PlayDrawerActionsContext {
  let primary: DrawerAction[];
  switch (layout.primaryCenter) {
    case 'tick':
      primary = [
        layout.leadingSlot,
        layout.showPreviousNext ? 'previous' : layout.innerLeadingSlot,
        'tick',
        layout.showPreviousNext ? 'next' : layout.innerTrailingSlot,
        layout.trailingSlot,
      ];
      break;
    case 'wallControl':
      primary = [layout.showPreviousNext ? 'previous' : null, 'wallControl', layout.showPreviousNext ? 'next' : null];
      break;
    case 'wallControlFull':
      primary = ['wallControl'];
      break;
    case 'confirm':
      primary = ['keepTheirs', 'putOnWall'];
      break;
    case 'none':
      primary = [];
      break;
  }
  const offered = (action: DrawerAction): DrawerAction => {
    if (action === 'share' && !hasShare) return null;
    if ((action === 'wallControl' || action === 'lightbulb') && !wallControlVisible) return null;
    return action;
  };
  primary = primary.map(offered);
  const secondary = (
    layout.secondaryRow === 'confirm'
      ? ['keepTheirs', 'putOnWall']
      : layout.secondaryRow === 'workoutOutcome'
        ? ['fell', 'sent']
        : layout.secondaryRow.filter((action) => action !== 'spacer')
  )
    .map(offered)
    .filter((action): action is string => action !== null);
  const visible = [...(primaryVisible ? primary : []), ...(secondaryVisible ? secondary : [])].filter(
    (action): action is string => action !== null,
  );
  return {
    player_layout_version: 3,
    player_primary_slots: primary.map((action) => action ?? '-').join(','),
    player_secondary_actions: secondary.join(','),
    player_visible_actions: [...new Set(visible)].join(','),
    player_previous_next: layout.showPreviousNext,
    player_board_control: boardControl,
    player_tick_size: layout.primaryCenter === 'tick' ? 56 : 0,
    player_tick_visible: visible.includes('tick'),
    player_share_visible: visible.includes('share'),
  };
}
