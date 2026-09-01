import { SCREENSHOT_BOARDS } from './screenshot-mode';

/**
 * Which of the account's boards a screenshot slot renders.
 *
 * Position alone can't answer that: `myBoards` comes back ordered
 * `isOwned DESC, createdAt DESC`, so `boards[0]` is "the newest board I own" and
 * shifts under the capture every time the account follows or adds a wall — which
 * is how a MoonBoard ended up as the wall in the App Store hero shots. The
 * capture asks for boards by name instead (`SCREENSHOT_BOARDS`), and only falls
 * back to a position when nothing matches.
 *
 * Screenshot-only: every caller reaches this from an inlined
 * `EXPO_PUBLIC_SCREENSHOT_MODE === '1'` branch, so it dead-strips from normal
 * builds along with them.
 */

/** The `UserBoard` fields selection needs — kept structural so tests can pass literals. */
export type ScreenshotSelectableBoard = {
  name: string;
  layoutName?: string | null;
  boardType: string;
  layoutId: number;
  sizeId: number;
  angle: number;
  createdAt: string;
};

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Match one selector against the roster.
 *
 * Name first so a personal wall ("Marco's Kilterboard") wins over a stock layout
 * that happens to share a word, then layout name so a selector like
 * "Tension Board 2" finds the right wall whatever the account calls it. Exact
 * matches for both are tried before either substring pass, so a selector can
 * never be stolen by a longer name that merely contains it.
 */
export function matchScreenshotBoard<Board extends ScreenshotSelectableBoard>(
  boards: readonly Board[],
  selector: string,
): Board | null {
  const wanted = normalize(selector);
  if (!wanted) return null;
  return (
    boards.find((board) => normalize(board.name) === wanted) ??
    boards.find((board) => normalize(board.layoutName) === wanted) ??
    boards.find((board) => normalize(board.name).includes(wanted)) ??
    boards.find((board) => normalize(board.layoutName).includes(wanted)) ??
    null
  );
}

/** One line per resolved slot, so a capture run is debuggable from the log the orchestrator tees. */
function describe(board: ScreenshotSelectableBoard): string {
  return `${board.name} (${board.boardType} L${board.layoutId} S${board.sizeId} @${board.angle}°)`;
}

/**
 * The board for screenshot slot `index`, by `SCREENSHOT_BOARDS[index]`.
 *
 * Falls back to `createdAt`-ascending position — the same order the old
 * `?screenshotBoardIndex=` path used — when the slot has no selector or the
 * selector matches nothing, and logs a WARN in the latter case:
 * `assertScreenshotRenderIntegrity` in `scripts/mobile-screenshots.ts` fails the
 * run on that line rather than let a wrong wall reach the store.
 */
export function resolveScreenshotBoard<Board extends ScreenshotSelectableBoard>(
  boards: readonly Board[],
  index: number,
): Board | null {
  const selector = SCREENSHOT_BOARDS[index];
  if (selector) {
    const matched = matchScreenshotBoard(boards, selector);
    if (matched) {
      console.log(`[screenshot] board[${index}] "${selector}" -> ${describe(matched)}`);
      return matched;
    }
    console.log(
      `[screenshot] WARN board[${index}] selector "${selector}" matched nothing in ${boards.length} board(s); using position`,
    );
  }
  const byOldestFirst = [...boards].sort(
    (first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
  );
  return byOldestFirst[index] ?? null;
}
