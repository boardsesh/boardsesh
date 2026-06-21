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

// Only DOUBLE-quote delimiters (straight, curly, guillemets). Climb names are
// always double-quoted, and a curly apostrophe (’ U+2019) or straight ' inside a
// name — "Carlo’s Blowtorch", "Bucky Barnes’ Lost Arm" — must NOT count as a
// closing quote, or the name gets truncated at the apostrophe.
const OPEN_QUOTES = '"“«';
const CLOSE_QUOTES = '"”»';
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

  // Detect angle + board only in the text AFTER the quoted name. The canonical
  // caption is `"name" @ angle° on the X Board`, so the trailing region is the
  // authoritative source — and this stops a climb literally named "Tension
  // Board" or "Project @ 30" from poisoning the board/angle.
  const rest = caption.slice(nameMatch.index + nameMatch[0].length);
  const angleMatch = ANGLE.exec(rest);
  const rawAngle = angleMatch ? Number(angleMatch[1]) : null;
  const angle = rawAngle != null && rawAngle >= 0 && rawAngle <= 90 ? rawAngle : null;

  return { climbName, angle, boardType: detectBoard(rest) };
}
