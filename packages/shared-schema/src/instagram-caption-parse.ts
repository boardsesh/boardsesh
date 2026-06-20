/**
 * Parse a climb-beta Instagram caption into its structured parts.
 *
 * Inverts the share caption that Boardsesh (and the Kilter/Tension apps) emit,
 * e.g. `"Air Bender" @ 40° on the Kilter Board.` — see buildInstagramCaption in
 * packages/web/app/lib/instagram-posting.ts. Tolerant of missing degree signs,
 * missing "on the … Board", and curly/guillemet quotes. Returns null when no
 * quoted climb name is present (i.e. not a beta post we can act on).
 */
export type ParsedBetaCaption = {
  climbName: string;
  angle: number | null;
  boardType: 'kilter' | 'tension' | null;
};

const OPEN_QUOTES = '"“‟«‹‚‘';
const CLOSE_QUOTES = '"”„»›’';
// First quoted run, 1–120 chars, non-greedy so it stops at the first closing quote.
const QUOTED_NAME = new RegExp(`[${OPEN_QUOTES}]([^${OPEN_QUOTES}${CLOSE_QUOTES}]{1,120}?)[${CLOSE_QUOTES}]`);
// `@ 40°` / `@40` / `@ 40 deg`. Requires 1–2 digits right after @, with the
// `(?!\d)` boundary so a longer numeric run (e.g. a handle like `@123climber`)
// is skipped rather than read as a two-digit angle; `@kilterboard` never matches
// because the first char after @ must be a digit.
const ANGLE = /@\s*(\d{1,2})(?!\d)\s*(?:°|deg|degrees)?/i;

function detectBoard(caption: string): 'kilter' | 'tension' | null {
  const lower = caption.toLowerCase();
  if (/tension\s*board|tensionboard|tensionclimbing/.test(lower)) return 'tension';
  if (/kilter\s*board|kilterboard|kiltergrips/.test(lower)) return 'kilter';
  return null;
}

export function parseInstagramBetaCaption(caption: string | null | undefined): ParsedBetaCaption | null {
  if (!caption) return null;
  const nameMatch = QUOTED_NAME.exec(caption);
  if (!nameMatch) return null;
  const climbName = nameMatch[1].trim();
  if (!climbName) return null;

  const angleMatch = ANGLE.exec(caption);
  const rawAngle = angleMatch ? Number(angleMatch[1]) : null;
  const angle = rawAngle != null && rawAngle >= 0 && rawAngle <= 90 ? rawAngle : null;

  return { climbName, angle, boardType: detectBoard(caption) };
}
