// Recover the climb a shared reel is about from its caption. Boardsesh's own
// "share your beta" caption embeds the climb name in double quotes
// (`"Purple Nurple" @ 40° on the Kilter Board.`), and a climber may add their own
// words before/after — so we pull whatever sits inside the quotes and match that
// against their logbook. Pure + dependency-free so the backend resolver and any
// client run identical logic.

// Quoted names shorter than this (after normalization) are too generic to trust
// as a climb match. 4 keeps out stray `"up"`, `"yes"`, `"g2"`-style quotes.
export const MIN_MATCHABLE_NAME_LENGTH = 4;

// A quoted name longer than this isn't a climb name (someone quoted a sentence);
// skip it rather than push an oversized value into the name lookup.
const MAX_MATCHABLE_NAME_LENGTH = 120;

// Content between straight or curly double quotes. Global so matchAll finds every
// quoted segment in the caption.
const QUOTED_SEGMENT = /["“”]([^"“”]+)["“”]/g;

/** The minimal shape the matcher reads off a logged climb / ascent. */
export type CaptionMatchableClimb = {
  climbName: string;
  climbUuid: string;
};

/**
 * Lowercase, strip diacritics, and reduce to single-spaced alphanumerics so a
 * quoted `"Café Crux"` and a climb name `Café Crux` compare cleanly.
 */
function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the quoted climb-name candidate(s) out of a caption — the raw (trimmed)
 * text inside each pair of double quotes, de-duped (by normalized form) and with
 * too-short / too-long segments dropped. Returns [] when the caption has no
 * usable quoted name (e.g. a non-Boardsesh reel). Raw text is preserved so the
 * caller can do a (diacritic-faithful) name lookup.
 */
export function extractQuotedClimbNames(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of caption.matchAll(QUOTED_SEGMENT)) {
    const raw = match[1].trim();
    if (raw.length > MAX_MATCHABLE_NAME_LENGTH) continue;
    const normalized = normalizeForMatch(raw);
    if (normalized.length < MIN_MATCHABLE_NAME_LENGTH) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(raw);
  }
  return names;
}

/**
 * Find which of the climber's logged climbs the shared reel is about: the climbs
 * whose name exactly matches (normalized) a quoted name in the caption. De-dupes
 * by climb and ranks longer (more specific) names first. Returns [] when the
 * caption has no quoted name or nothing matches. Generic over the row shape so
 * callers keep their full type on the way out; only `climbName` + `climbUuid`
 * are read.
 */
export function matchClimbsToCaption<T extends CaptionMatchableClimb>(
  caption: string | null | undefined,
  climbs: T[],
): T[] {
  const quotedNames = new Set(extractQuotedClimbNames(caption).map(normalizeForMatch));
  if (quotedNames.size === 0) return [];

  const seen = new Set<string>();
  const scored: { climb: T; score: number }[] = [];

  for (const climb of climbs) {
    const name = normalizeForMatch(climb.climbName);
    if (!quotedNames.has(name)) continue;
    if (seen.has(climb.climbUuid)) continue;
    seen.add(climb.climbUuid);
    scored.push({ climb, score: name.length });
  }

  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.climb);
}
