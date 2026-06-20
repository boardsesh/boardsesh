// Pure, DB-free classification core for instagramBetaScan. Kept separate from
// the resolver module (instagram-beta-import.ts) so unit tests can exercise it
// without importing the db client (which connects at module load). The resolver
// does the I/O — caption parse + the two queries — and hands the assembled
// inputs to classifyScanPosts here.
import {
  getInstagramMediaId,
  parseInstagramBetaCaption,
  type InstagramBetaScanResult,
  type InstagramScanPostInput,
} from '@boardsesh/shared-schema';

// A climb row as the classifier needs it. Mirrors the `board_climbs` columns
// the resolution + dedup step reads — nothing more, so the pure classifier
// stays trivially constructable in tests without a DB row shape.
export type ScanClimbRow = {
  uuid: string;
  name: string;
  boardType: string;
  layoutId: number;
  setterUsername: string | null;
  isListed: boolean | null;
  isDraft: boolean | null;
  angle: number | null;
};

// A scanned post after caption parsing — the unit the classifier operates on.
// `parsedName` is null when the caption was absent or didn't look like a beta
// post; `resolvedBoardType` is the board we resolve against (caption override
// wins over the input default).
export type ParsedScanPost = {
  shortcode: string;
  link: string;
  hadCaption: boolean;
  parsedName: string | null;
  parsedAngle: number | null;
  resolvedBoardType: string;
};

export function normalizeName(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

// Group key for climbsByName lookups: a name is only unique within a board, so
// the resolution map is keyed on (boardType, lower-cased name).
export function climbNameKey(boardType: string, name: string): string {
  return `${boardType} ${normalizeName(name)}`;
}

// Build the IG-shortcode set of stored beta links so dedup uses the same
// identity attachBetaLink writes. Non-Instagram links (TikTok et al.) have no
// shortcode and never collide with a scanned IG post.
export function existingShortcodeSet(existingLinks: { climbUuid: string; link: string }[]): {
  shortcodes: Set<string>;
  climbByShortcode: Map<string, string>;
} {
  const shortcodes = new Set<string>();
  const climbByShortcode = new Map<string, string>();
  for (const { climbUuid, link } of existingLinks) {
    const shortcode = getInstagramMediaId(link);
    if (!shortcode) continue;
    shortcodes.add(shortcode);
    // First writer wins as the representative climb for an already-linked post.
    if (!climbByShortcode.has(shortcode)) {
      climbByShortcode.set(shortcode, climbUuid);
    }
  }
  return { shortcodes, climbByShortcode };
}

// Resolve a parsed name to its candidate climbs, preferring listed climbs: a
// delisted/draft duplicate must never win resolution when a listed one exists.
// When several listed climbs share a name the post stays ambiguous and the user
// picks one in the UI.
function matchesForPost(post: ParsedScanPost, climbsByName: Map<string, ScanClimbRow[]>): ScanClimbRow[] {
  if (post.parsedName === null) return [];
  const all = climbsByName.get(climbNameKey(post.resolvedBoardType, post.parsedName)) ?? [];
  const listed = all.filter((climb) => climb.isListed === true && climb.isDraft !== true);
  return listed.length > 0 ? listed : all;
}

// Parse each scraped post's caption and resolve the board to query against:
// the caption-detected board overrides the input default, falling back to it.
export function parseScanPosts(posts: InstagramScanPostInput[], defaultBoardType: string): ParsedScanPost[] {
  return posts.map((post) => {
    const caption = post.caption ?? null;
    const parsed = parseInstagramBetaCaption(caption);
    return {
      shortcode: post.shortcode,
      link: `https://www.instagram.com/p/${post.shortcode}/`,
      hadCaption: caption !== null && caption.trim() !== '',
      parsedName: parsed?.climbName ?? null,
      parsedAngle: parsed?.angle ?? null,
      resolvedBoardType: parsed?.boardType ?? defaultBoardType,
    };
  });
}

// Pure classification: turn parsed posts + the name→climbs map + the set of
// already-attached shortcodes into the four result buckets. DB-free so it's
// unit-testable without a database.
export function classifyScanPosts(
  posts: ParsedScanPost[],
  climbsByName: Map<string, ScanClimbRow[]>,
  existingShortcodes: Set<string>,
  climbByExistingShortcode: Map<string, string>,
): InstagramBetaScanResult {
  const result: InstagramBetaScanResult = {
    scanned: posts.length,
    parsed: 0,
    missing: [],
    alreadyLinked: [],
    ambiguous: [],
    unmatched: [],
  };

  for (const post of posts) {
    // No caption at all — nothing to act on.
    if (!post.hadCaption) {
      result.unmatched.push({ shortcode: post.shortcode, link: post.link, parsedName: null, reason: 'no-caption' });
      continue;
    }
    // Caption present but the parser couldn't pull a quoted climb name.
    if (post.parsedName === null) {
      result.unmatched.push({ shortcode: post.shortcode, link: post.link, parsedName: null, reason: 'not-parsed' });
      continue;
    }

    result.parsed += 1;
    const matches = matchesForPost(post, climbsByName);

    // Shortcode already attached anywhere on the board — report it as
    // already-linked before considering match count (mirrors the script's
    // shortcode-first branch). Prefer the single name match as the
    // representative climb, else any name match, else the climb the existing
    // link points at.
    if (existingShortcodes.has(post.shortcode)) {
      const representative = matches[0]?.uuid ?? climbByExistingShortcode.get(post.shortcode) ?? '';
      const climbName = matches[0]?.name ?? post.parsedName;
      result.alreadyLinked.push({
        shortcode: post.shortcode,
        link: post.link,
        climbUuid: representative,
        climbName,
        boardType: post.resolvedBoardType,
        angle: post.parsedAngle,
      });
      continue;
    }

    if (matches.length === 1) {
      const climb = matches[0];
      result.missing.push({
        shortcode: post.shortcode,
        link: post.link,
        climbUuid: climb.uuid,
        climbName: climb.name,
        boardType: post.resolvedBoardType,
        angle: post.parsedAngle,
      });
    } else if (matches.length > 1) {
      result.ambiguous.push({
        shortcode: post.shortcode,
        link: post.link,
        parsedName: post.parsedName,
        boardType: post.resolvedBoardType,
        angle: post.parsedAngle,
        candidates: matches.map((climb) => ({
          climbUuid: climb.uuid,
          name: climb.name,
          layoutId: climb.layoutId,
          setterUsername: climb.setterUsername,
        })),
      });
    } else {
      result.unmatched.push({
        shortcode: post.shortcode,
        link: post.link,
        parsedName: post.parsedName,
        reason: 'no-climb',
      });
    }
  }

  return result;
}
