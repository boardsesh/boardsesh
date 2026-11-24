import { z } from 'zod';
import {
  KIOSK_DEFAULT_LEADERBOARD_PERIOD,
  KIOSK_DEFAULT_THEME,
  KIOSK_LAYOUT_VERSION,
  KIOSK_LEADERBOARD_PERIODS,
  KIOSK_THEMES,
  MAX_KIOSK_BOARDS,
} from './constants';

/**
 * One board slot in a kiosk. Modelled as an object (rather than a bare uuid) so a
 * later PR can hang additive per-slot options off it — e.g. a `variant` to pick a
 * different render for the same board count — without a version bump. The slot's
 * position in the `boards` array is its on-screen order; there is no slot id.
 */
export const KioskBoardSlotSchema = z.object({
  boardUuid: z.uuid(),
});

export type KioskBoardSlot = z.infer<typeof KioskBoardSlotSchema>;

/**
 * The optional leaderboard rail. `boardUuid: null` scopes the ranking to every
 * board on the kiosk; a non-null value scopes it to a single board (which the
 * layout refine below requires to be one of the kiosk's boards). `period` picks
 * the window — the live session ranking or a day/week/month leaderboard.
 */
export const KioskLeaderboardSchema = z.object({
  boardUuid: z.uuid().nullable().default(null),
  period: z.enum(KIOSK_LEADERBOARD_PERIODS).default(KIOSK_DEFAULT_LEADERBOARD_PERIOD),
});

export type KioskLeaderboard = z.infer<typeof KioskLeaderboardSchema>;

/**
 * Strict writer schema — the shape the backend validates every `create/updateGymKiosk`
 * mutation against, and what the manage-UI serialises. An empty `boards` array is
 * valid on purpose: a kiosk is created first (so the owner gets a shareable URL)
 * and configured second, and the TV renders a "not set up yet" placeholder until a
 * board is assigned. The preset (single/dual/triple/quad) is derived from
 * `boards.length`, never stored. `leaderboard: null` means the rail is off.
 *
 * The `superRefine` adds two cross-field rules the object schema can't express:
 *  - no board may appear twice (two slots showing the same wall is always a mistake);
 *  - a single-board leaderboard must point at a board the kiosk actually shows,
 *    so the rail can't rank a wall that isn't on screen.
 *
 * Reading persisted layouts (which may predate the running code) goes through
 * `parseKioskLayoutLenient` instead, which repairs rather than rejects.
 */
export const KioskLayoutSchema = z
  .object({
    version: z.literal(KIOSK_LAYOUT_VERSION),
    boards: z.array(KioskBoardSlotSchema).max(MAX_KIOSK_BOARDS),
    leaderboard: KioskLeaderboardSchema.nullable().default(null),
    // Per-kiosk toggle: when true, every board renders its own "install
    // Boardsesh" QR (a deep link to that board) so climbers on the wall can get
    // the app and feed the screen. Additive + defaulted, so older stored layouts
    // (and the lenient reader below) read it as false without a version bump.
    showInstallQr: z.boolean().default(false),
    theme: z.enum(KIOSK_THEMES).default(KIOSK_DEFAULT_THEME),
  })
  .superRefine((layout, ctx) => {
    const seen = new Set<string>();
    layout.boards.forEach((slot, index) => {
      if (seen.has(slot.boardUuid)) {
        ctx.addIssue({
          code: 'custom',
          message: 'A board can only appear once on a kiosk',
          path: ['boards', index, 'boardUuid'],
        });
      }
      seen.add(slot.boardUuid);
    });

    const leaderboardBoardUuid = layout.leaderboard?.boardUuid ?? null;
    if (leaderboardBoardUuid !== null && !seen.has(leaderboardBoardUuid)) {
      ctx.addIssue({
        code: 'custom',
        message: 'The leaderboard board must be one of the kiosk boards',
        path: ['leaderboard', 'boardUuid'],
      });
    }
  });

/**
 * The full kiosk layout. Type name kept as `KioskLayout` (unchanged from the
 * draft) so the db `$type<KioskLayout>` import in `gym-kiosks.ts` doesn't move.
 */
export type KioskLayout = z.infer<typeof KioskLayoutSchema>;

/** The default empty layout a freshly created kiosk row stores. */
export function emptyKioskLayout(): KioskLayout {
  return {
    version: KIOSK_LAYOUT_VERSION,
    boards: [],
    leaderboard: null,
    showInstallQr: false,
    theme: KIOSK_DEFAULT_THEME,
  };
}

export interface LenientKioskLayoutResult {
  /** The layout with only the slots + rail that still validate under the current code. */
  layout: KioskLayout;
  /** How many stored board slots were dropped (malformed, duplicate, or over the cap). */
  droppedBoardCount: number;
  /** Whether a stored leaderboard was dropped or its single-board scope widened to all boards. */
  droppedLeaderboard: boolean;
}

/**
 * Forward-compatible reader for a persisted `layout` jsonb. This is the contract
 * that lets us evolve the schema without breaking already-open TVs running older
 * JS: rather than reject a whole layout when one slot is off, it repairs the
 * layout and renders what's left.
 *
 * Rules:
 * - A top-level `version` this code doesn't recognise (a future breaking bump) is
 *   uninterpretable, so return an empty layout rather than guess — but still
 *   report what was discarded (best-effort: the stored board count, and whether a
 *   leaderboard was present) so a caller that surfaces "your layout was dropped"
 *   warnings doesn't read the wholesale discard as "nothing dropped". Non-object
 *   input yields an empty layout with zero drop flags, never a throw.
 * - `safeParse` each board slot independently, drop the invalid ones, dedupe by
 *   `boardUuid` keeping the first occurrence, and cap at `MAX_KIOSK_BOARDS`.
 * - A malformed leaderboard is dropped to `null` (`droppedLeaderboard: true`).
 * - A single-board leaderboard whose board didn't survive the slot repair is
 *   widened to `boardUuid: null` (rail kept, scoped to all boards) rather than
 *   dropped — a valid rail shouldn't vanish just because it named a since-removed
 *   board. That widening also sets `droppedLeaderboard: true`.
 *
 * The strict `KioskLayoutSchema` remains the write-time gate; this is read-time only.
 */
export function parseKioskLayoutLenient(value: unknown): LenientKioskLayoutResult {
  if (typeof value !== 'object' || value === null) {
    return { layout: emptyKioskLayout(), droppedBoardCount: 0, droppedLeaderboard: false };
  }

  const record = value as {
    version?: unknown;
    boards?: unknown;
    leaderboard?: unknown;
    showInstallQr?: unknown;
    theme?: unknown;
  };

  if (record.version !== KIOSK_LAYOUT_VERSION) {
    // Wholesale discard: the layout is uninterpretable under this code, but the
    // drop flags must still tell the caller that stored config was lost.
    return {
      layout: emptyKioskLayout(),
      droppedBoardCount: Array.isArray(record.boards) ? record.boards.length : 0,
      droppedLeaderboard: record.leaderboard !== null && record.leaderboard !== undefined,
    };
  }

  // Booleans need no repair: an absent field or any non-`true` value (including a
  // malformed one) reads as false — the safe off default for a new toggle.
  const showInstallQr = record.showInstallQr === true;
  // Only an explicit light selection changes existing TVs' appearance. Unknown
  // future theme values degrade to the same dark default as legacy layouts.
  const theme = record.theme === 'light' ? 'light' : KIOSK_DEFAULT_THEME;

  const boards: KioskBoardSlot[] = [];
  let droppedBoardCount = 0;
  const seen = new Set<string>();

  const candidateBoards = Array.isArray(record.boards) ? record.boards : [];
  for (const candidate of candidateBoards) {
    const parsed = KioskBoardSlotSchema.safeParse(candidate);
    if (!parsed.success) {
      droppedBoardCount += 1;
      continue;
    }
    if (seen.has(parsed.data.boardUuid) || boards.length >= MAX_KIOSK_BOARDS) {
      // Duplicate slot, or one past the cap — both are dropped.
      droppedBoardCount += 1;
      continue;
    }
    seen.add(parsed.data.boardUuid);
    boards.push(parsed.data);
  }

  let leaderboard: KioskLeaderboard | null = null;
  let droppedLeaderboard = false;

  if (record.leaderboard !== null && record.leaderboard !== undefined) {
    const parsedLeaderboard = KioskLeaderboardSchema.safeParse(record.leaderboard);
    if (!parsedLeaderboard.success) {
      droppedLeaderboard = true;
    } else if (parsedLeaderboard.data.boardUuid !== null && !seen.has(parsedLeaderboard.data.boardUuid)) {
      // Named a board that didn't survive the slot repair: keep the rail, widen it
      // to all boards rather than let a valid leaderboard disappear.
      leaderboard = { ...parsedLeaderboard.data, boardUuid: null };
      droppedLeaderboard = true;
    } else {
      leaderboard = parsedLeaderboard.data;
    }
  }

  return {
    layout: { version: KIOSK_LAYOUT_VERSION, boards, leaderboard, showInstallQr, theme },
    droppedBoardCount,
    droppedLeaderboard,
  };
}
