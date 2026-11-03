import { describe, expect, it } from 'vitest';
import { resolveActionBarLayout, type ActionBarLayoutInput } from '../../components/play-drawer/action-bar-layout';
import { buildPlayDrawerActionsContext, isPlayDrawerWallControlRendered } from '../play-drawer-actions-analytics';
import { DEFAULT_PLAYER_BUTTONS, DEFAULT_PLAYER_PREVIOUS_NEXT } from '../player-buttons';

const DEFAULT_LAYOUT_INPUT: ActionBarLayoutInput = {
  supportsMirroring: true,
  isAnonymous: false,
  commitButton: null,
  workoutOutcome: false,
  showLightbulb: true,
  hasWall: true,
  hasShare: true,
  angleAvailable: true,
  buttons: DEFAULT_PLAYER_BUTTONS,
  previousNext: DEFAULT_PLAYER_PREVIOUS_NEXT,
};

function contextFor(
  layoutChanges: Partial<ActionBarLayoutInput> = {},
  exposureChanges: {
    wallControlVisible?: boolean;
    primaryVisible?: boolean;
    secondaryVisible?: boolean;
  } = {},
) {
  const input = { ...DEFAULT_LAYOUT_INPUT, ...layoutChanges };
  return buildPlayDrawerActionsContext({
    layout: resolveActionBarLayout(input),
    boardControl: input.boardControl ?? 'wallButton',
    hasShare: input.hasShare,
    wallControlVisible: true,
    ...exposureChanges,
  });
}

describe('play drawer action exposure context', () => {
  it.each(['connect', 'lit', 'dark', 'crew'] as const)('counts the rendered bulb while %s', (state) => {
    const layout = resolveActionBarLayout({ ...DEFAULT_LAYOUT_INPUT, boardControl: 'lightbulb' });
    const context = buildPlayDrawerActionsContext({
      layout,
      boardControl: 'lightbulb',
      hasShare: true,
      wallControlVisible: isPlayDrawerWallControlRendered(layout, state),
    });
    expect(context.player_primary_slots).toBe('mirror,favorite,tick,share,lightbulb');
    expect(context.player_visible_actions.split(',')).toContain('lightbulb');
  });
  it('reports the default mirroring-board row and its actual visible actions', () => {
    expect(contextFor()).toEqual({
      player_layout_version: 3,
      player_primary_slots: 'mirror,favorite,tick,share,queue',
      player_secondary_actions: 'wallControl',
      player_visible_actions: 'mirror,favorite,tick,share,queue,wallControl',
      player_previous_next: false,
      player_board_control: 'wallButton',
      player_tick_size: 56,
      player_tick_visible: true,
      player_share_visible: true,
    });
  });

  it('uses Angle in place of unavailable Mirror on an adjustable board', () => {
    const context = contextFor({ supportsMirroring: false });
    expect(context.player_primary_slots).toBe('angle,favorite,tick,share,queue');
    expect(context.player_visible_actions).toBe('angle,favorite,tick,share,queue,wallControl');
    expect(context.player_visible_actions.split(',')).not.toContain('mirror');
  });

  it('distinguishes resolved positions from a primary row that is not visible', () => {
    const context = contextFor({}, { primaryVisible: false });
    expect(context.player_primary_slots).toBe('mirror,favorite,tick,share,queue');
    expect(context.player_visible_actions).toBe('wallControl');
    expect(context.player_tick_visible).toBe(false);
    expect(context.player_share_visible).toBe(false);
  });

  it('does not count secondary actions until the secondary row is visible', () => {
    const context = contextFor({ boardControl: 'lightbulb' }, { secondaryVisible: false });
    expect(context.player_primary_slots).toBe('mirror,favorite,tick,share,lightbulb');
    expect(context.player_secondary_actions).toBe('angle,playNext,queue');
    expect(context.player_visible_actions).toBe('mirror,favorite,tick,share,lightbulb');
    expect(context.player_visible_actions.split(',')).not.toContain('queue');
  });

  it('can report only a visible secondary row without exposing hidden primary actions', () => {
    const context = contextFor({ boardControl: 'lightbulb' }, { primaryVisible: false });
    expect(context.player_visible_actions).toBe('angle,playNext,queue');
    expect(context.player_tick_visible).toBe(false);
    expect(context.player_share_visible).toBe(false);
  });

  it('keeps a draft Share placeholder without counting Share as an exposure', () => {
    const context = contextFor({ hasShare: false });
    expect(context.player_primary_slots).toBe('mirror,favorite,tick,-,queue');
    expect(context.player_visible_actions).toBe('mirror,favorite,tick,queue,wallControl');
    expect(context.player_share_visible).toBe(false);
  });

  it('does not count a draft Share in the anonymous secondary row', () => {
    const context = contextFor({ isAnonymous: true, hasShare: false });
    expect(context.player_secondary_actions).toBe('angle');
    expect(context.player_visible_actions.split(',')).not.toContain('share');
    expect(context.player_share_visible).toBe(false);
  });

  it('reports Fell and Sent rather than a Tick hidden by the workout controls', () => {
    const context = contextFor({ workoutOutcome: true });
    expect(context.player_primary_slots).toBe('-,wallControl,-');
    expect(context.player_secondary_actions).toBe('fell,sent');
    expect(context.player_visible_actions).toBe('wallControl,fell,sent');
    expect(context.player_tick_size).toBe(0);
    expect(context.player_tick_visible).toBe(false);
    expect(context.player_share_visible).toBe(false);
  });

  it('does not count an undrawn wall control or bulb', () => {
    const wall = contextFor({}, { wallControlVisible: false });
    expect(wall.player_secondary_actions).toBe('');
    expect(wall.player_visible_actions).toBe('mirror,favorite,tick,share,queue');
    const bulb = contextFor({ boardControl: 'lightbulb' }, { wallControlVisible: false });
    expect(bulb.player_primary_slots).toBe('mirror,favorite,tick,share,-');
    expect(bulb.player_visible_actions).toBe('mirror,favorite,tick,share,angle,playNext,queue');
  });

  it('reports navigation arrows and excludes the actions they displace', () => {
    const context = contextFor({ previousNext: true });
    expect(context.player_primary_slots).toBe('mirror,previous,tick,next,queue');
    expect(context.player_visible_actions).toBe('mirror,previous,tick,next,queue,wallControl');
    expect(context.player_previous_next).toBe(true);
    expect(context.player_tick_visible).toBe(true);
    expect(context.player_share_visible).toBe(false);
  });

  it.each(['wallButton', 'lightbulb'] as const)(
    'does not claim a drawer Tick when the MiniPlayer delegates the row with %s',
    (boardControl) => {
      const context = contextFor({ miniPlayerMirrors: true, boardControl });
      expect(context.player_tick_visible).toBe(false);
      expect(context.player_tick_size).toBe(0);
      expect(context.player_share_visible).toBe(false);
      expect(context.player_visible_actions.split(',')).not.toContain('tick');
      expect(context.player_primary_slots).toBe(boardControl === 'wallButton' ? 'wallControl' : '');
    },
  );

  it('sends only primitive properties with comma-separated action positions', () => {
    const context = contextFor();
    expect(Object.values(context).every((property) => ['string', 'number', 'boolean'].includes(typeof property))).toBe(
      true,
    );
    expect(context.player_primary_slots.split(',')).toHaveLength(5);
  });
});
