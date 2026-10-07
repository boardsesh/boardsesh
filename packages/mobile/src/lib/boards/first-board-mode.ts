// The board picker's first-board mode (#5654): what the launch gate opens for a
// new account with no board. It is the ordinary `/boards` route with two params,
// so a bind from it goes through the same `useActivateBoard` path as every other
// pick, and `source: 'onboarding'` closes out first-run exactly as the old
// board step did (the activation event, the Climbs reveal banner, the seen flag).
//
// Climbs' "Pick your board" empty state reaches the same "Where do you climb?"
// block through its own `source`, `no_board`. That entry is NOT onboarding: the
// empty state shows for anyone with no board bound, at any account age, so a
// bind from it is an ordinary board switch, with no activation event and no
// reveal banner.

/** The value `firstBoard` carries when the picker is in first-board mode. */
const FIRST_BOARD_PARAM_VALUE = '1';

/** Where the launch gate sends a new account with no board. */
export const FIRST_BOARD_PICKER_HREF = {
  pathname: '/boards',
  params: { source: 'onboarding', firstBoard: FIRST_BOARD_PARAM_VALUE },
} as const;

/** The picker's `source` when Climbs' "Pick your board" empty state opened it. */
export const NO_BOARD_PICKER_SOURCE = 'no_board';

/**
 * What the climber tapped on Climbs' no-board state to open the picker: "Find
 * my board" (`cta`, on the placard or docked under the preview), the big lit
 * board at the top of the preview (`preview_hero`), or a climb in the list
 * below it (`preview_row`). Carried as the `trigger` route param and reported
 * on `Board Picker Opened`, so a climb tap that ends in a closed picker can be
 * told from a deliberate "Find my board".
 */
export type NoBoardPickerTrigger = 'cta' | 'preview_row' | 'preview_hero';

const NO_BOARD_PICKER_TRIGGERS: readonly string[] = [
  'cta',
  'preview_row',
  'preview_hero',
] satisfies readonly NoBoardPickerTrigger[];

/** Where Climbs' no-board state sends the climber, tagged with what they tapped. */
export function noBoardPickerHref(trigger: NoBoardPickerTrigger) {
  return {
    pathname: '/boards',
    params: { source: NO_BOARD_PICKER_SOURCE, trigger },
  } as const;
}

/**
 * The picker's `trigger` param as a known value, or null. Null is every opening
 * that is not Climbs' no-board entry, a link from a build that predates the
 * param, and any value this build does not know.
 */
export function noBoardPickerTrigger(params: { source?: string; trigger?: string }): NoBoardPickerTrigger | null {
  if (!isNoBoardEntry(params)) return null;
  const { trigger } = params;
  return trigger !== undefined && NO_BOARD_PICKER_TRIGGERS.includes(trigger) ? (trigger as NoBoardPickerTrigger) : null;
}

/**
 * The builder route's `preset` param when "My own board" opened it: open with a
 * layout and size chosen (see `presetBoardConfig`). Lives here, with the other
 * picker params, so the picker does not load the board catalogue to name it.
 */
export const BUILDER_PRESET_PARAM_VALUE = '1';

/**
 * How the climber reached the "Where do you climb?" block, carried on its
 * analytics: the launch gate opened it by itself, or they tapped "Find my board"
 * on Climbs.
 */
export type FirstBoardEntry = 'launch_gate' | 'no_board';

/**
 * Whether `/boards` was opened in first-board mode. Both params have to agree:
 * the mode is an onboarding surface, and a stray `firstBoard` on an ordinary
 * picker link must not turn the climber's board list into a first-run screen.
 */
export function isFirstBoardMode(params: { source?: string; firstBoard?: string }): boolean {
  return params.source === 'onboarding' && params.firstBoard === FIRST_BOARD_PARAM_VALUE;
}

/**
 * Whether `/boards` was opened from Climbs' "Pick your board" empty state. The
 * picker shows "Where do you climb?" for it only when the climber has no boards
 * at all; someone whose active board was merely cleared gets their list.
 */
export function isNoBoardEntry(params: { source?: string }): boolean {
  return params.source === NO_BOARD_PICKER_SOURCE;
}
