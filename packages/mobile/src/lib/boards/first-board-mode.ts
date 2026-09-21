// The board picker's first-board mode (#5654): what the launch gate opens for a
// new account with no board. It is the ordinary `/boards` route with two params,
// so a bind from it goes through the same `useActivateBoard` path as every other
// pick, and `source: 'onboarding'` closes out first-run exactly as the old
// board step did (the activation event, the Climbs reveal banner, the seen flag).

/** The value `firstBoard` carries when the picker is in first-board mode. */
const FIRST_BOARD_PARAM_VALUE = '1';

/** Where the launch gate sends a new account with no board. */
export const FIRST_BOARD_PICKER_HREF = {
  pathname: '/boards',
  params: { source: 'onboarding', firstBoard: FIRST_BOARD_PARAM_VALUE },
} as const;

/**
 * Whether `/boards` was opened in first-board mode. Both params have to agree:
 * the mode is an onboarding surface, and a stray `firstBoard` on an ordinary
 * picker link must not turn the climber's board list into a first-run screen.
 */
export function isFirstBoardMode(params: { source?: string; firstBoard?: string }): boolean {
  return params.source === 'onboarding' && params.firstBoard === FIRST_BOARD_PARAM_VALUE;
}
