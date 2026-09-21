/**
 * Captures for the /help topic pages.
 *
 * Unlike `marketing-screenshots.ts` these are not platform-switched: a help page
 * explains one flow, and swapping the phone under the reader mid-explanation
 * costs more than it buys. One capture per shot, shot at iPhone width.
 */
export type HelpShot =
  | 'discover'
  | 'playlist-detail'
  | 'live-sessions'
  | 'session-detail'
  | 'setters'
  | 'logbook'
  | 'board-sheet'
  | 'board-view'
  | 'climb-actions';

export type HelpCapture = { src: string; width: number; height: number };

const CAPTURE_WIDTH = 736;
const CAPTURE_HEIGHT = 1600;

/** One source per shot. Widen the signature only when a complete, reviewed capture set justifies it. */
export function helpScreenshot(shot: HelpShot): HelpCapture {
  return { src: `/images/help/${shot}.webp`, width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT };
}
