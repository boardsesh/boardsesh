import {
  getAllLayouts,
  getLayout,
  getProductSize,
  getSetsForLayoutAndSize,
  getSizesForLayoutId,
} from '@boardsesh/board-constants/product-sizes';
import {
  getMoonBoardDetails,
  getWoodsBoardDetails,
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  MOONBOARD_SIZE,
  WOODS_LAYOUTS,
  WOODS_SETS,
  WOODS_SIZES,
  type MoonBoardLayoutKey,
} from '@boardsesh/board-config';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';

export type BuildReadableClimbViewPathArgs = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  climbUuid: string;
  climbName?: string | null;
};

const supportedBoardNames = new Set<string>(SUPPORTED_BOARDS);
const boardNamePrefixRegex = new RegExp(`^(?:${SUPPORTED_BOARDS.join('|')})\\s*(?:board)?\\s*`, 'i');

function toBoardName(boardName: string): BoardName | null {
  return supportedBoardNames.has(boardName) ? (boardName as BoardName) : null;
}

function parseSetIds(setIds: string): number[] | null {
  const setIdSegments = setIds.split(',').map((setId) => setId.trim());
  if (setIdSegments.length === 0) return null;

  const setIdValues = setIdSegments.map((setId) => Number(setId));
  if (setIdSegments.some((setId) => setId.length === 0)) return null;
  if (setIdValues.some((setId) => !Number.isInteger(setId) || setId <= 0)) return null;

  return setIdValues;
}

// The slug generators below are the single definition of the canonical board
// URL vocabulary. `packages/web/app/lib/url-utils.ts` re-exports them rather
// than keeping its own copies — web and the Expo app must emit byte-identical
// URLs or a link stops working when it crosses hosts.

export function generateSlugFromText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function generateDescriptionSlug(description: string): string {
  return description
    .toLowerCase()
    .replace(/led\s*kit/gi, '')
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function generateLayoutSlug(layoutName: string): string {
  const baseSlug = layoutName
    .toLowerCase()
    .trim()
    .replace(boardNamePrefixRegex, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (baseSlug === 'original-layout') {
    return 'original';
  }

  if (baseSlug.startsWith('2-')) {
    return baseSlug.replace('2-', 'two-');
  }

  return baseSlug;
}

export function generateSizeSlug(sizeName: string, description?: string): string {
  const sizeMatch = sizeName.match(/(\d+)\s*x\s*(\d+)/i);
  const baseSlug = sizeMatch ? `${sizeMatch[1]}x${sizeMatch[2]}` : generateSlugFromText(sizeName);

  if (description?.trim()) {
    const descriptionSlug = generateDescriptionSlug(description);
    if (descriptionSlug) {
      return `${baseSlug}-${descriptionSlug}`;
    }
  }

  return baseSlug;
}

/**
 * The part of a size name that {@link generateSizeSlug} throws away — everything
 * either side of the `12 x 12` dimensions. That discarded text is what
 * distinguishes the one genuinely ambiguous pair in the catalogue (Kilter
 * layout 1: "12 x 12 with kickboard" and "12 x 12 without kickboard", both
 * described "Square", both slugged `12x12-square`), so it is what
 * {@link resolveSizeSlug} appends to break the tie.
 */
function sizeNameQualifierSlug(sizeName: string): string {
  return generateSlugFromText(sizeName.replace(/(\d+)\s*x\s*(\d+)/i, ' '));
}

/**
 * Every size on a layout paired with the slug a URL should carry for it. Built
 * in one pass so neither direction re-derives per candidate: the base slugs are
 * computed once, then only the sizes that share one get a qualifier.
 */
function sizeSlugsForLayout(boardName: BoardName, layoutId: number): { id: number; slug: string; base: string }[] {
  const sizesOnLayout = getSizesForLayoutId(boardName, layoutId);
  const firstIdByBaseSlug = new Map<string, number>();
  const bases = sizesOnLayout.map((size) => {
    const base = generateSizeSlug(size.name, size.description);
    if (!firstIdByBaseSlug.has(base)) firstIdByBaseSlug.set(base, size.id);
    return { size, base };
  });

  return bases.map(({ size, base }) => {
    // The first match keeps the bare slug — that is what every existing link
    // already resolves to.
    if (firstIdByBaseSlug.get(base) === size.id) return { id: size.id, slug: base, base };
    const qualifier = sizeNameQualifierSlug(size.name);
    return { id: size.id, slug: qualifier ? `${base}-${qualifier}` : `${base}-size-${size.id}`, base };
  });
}

/**
 * The size slug to put in a URL, disambiguated against the other sizes on the
 * same layout.
 *
 * `generateSizeSlug` alone is lossy: two sizes on one layout can produce the
 * same slug, and the second one was simply unreachable — every `12x12-square`
 * link resolved to "with kickboard", so a "without kickboard" board could not be
 * shared at all. Resolvers on both hosts pick the first match (web's
 * `findSizeBySlug`, and {@link resolveBoardSegmentsToIds} here).
 *
 * The fix keeps that first match on the bare slug forever — so **no existing
 * URL changes meaning or stops working** — and gives only the shadowed sizes a
 * qualifier suffix. New links to a previously-unaddressable board are exact;
 * every link already in the wild, indexed, or pasted in a chat keeps resolving
 * exactly as before.
 */
export function resolveSizeSlug(boardName: BoardName, layoutId: number, sizeId: number): string | null {
  return sizeSlugsForLayout(boardName, layoutId).find((entry) => entry.id === sizeId)?.slug ?? null;
}

/**
 * Size slugs that must keep resolving forever, keyed by board and then by size
 * id.
 *
 * A size slug is built from upstream text: the dimensions and description feed
 * {@link generateSizeSlug}, and the qualifier {@link sizeSlugsForLayout} appends
 * comes from the size *name*. That text moves — upstream renames sizes (the July
 * 2026 sync audit caught several), and we ourselves correct upstream typos in
 * the description (#4554). Either way the slug generated afterwards and the slug
 * already sitting in every shared link, chat message and search index are
 * different strings. Nothing about a link in the wild changes when the text
 * moves, so pinning is the only thing that keeps it working: a shipped form is
 * recorded here by *id* the moment it changes, and resolves from then on
 * whatever the size ends up being called.
 *
 * Consulted only after the generated slugs, so an alias can never shadow a live
 * one. Append-only — deleting an entry 404s links that are already out there.
 */
export const PERMANENT_SIZE_SLUG_ALIASES: Partial<Record<BoardName, Readonly<Record<number, readonly string[]>>>> = {
  kilter: {
    // Kilter layout 1 size 7, "12 x 14": Aurora describes it "Commerical", and
    // that misspelling was folded straight into the size slug, so every link
    // minted before #4554 carries `12x14-commerical`. The description is now
    // corrected at the generator, so the generated slug is `12x14-commercial`
    // and the old form only keeps resolving from here. PostHog counted 629
    // pageviews from 325 people on `12x14-commerical` URLs in the 180 days to
    // 2026-08-16, across /list, /view, /playlists and the /es and /fr variants —
    // delete this entry and all of those links 404. Unlike the pins below this
    // is a BARE slug rather than a qualified one, which needs nothing special:
    // generated slugs are still matched first, so it cannot shadow a live one.
    7: ['12x14-commerical'],
    // Kilter layout 1 size 10, "12 x 12 with kickboard": owns the bare
    // `12x12-square` slug by being first on the layout. Pinned so an upstream
    // RENAME of the size (generated slug changes, bare form stops matching)
    // keeps every bare link in the wild resolving here. Note the pin cannot
    // guard against a lower-id 12x12 size appearing on the layout — generated
    // slugs are checked first by design, so the newcomer would win the bare
    // form; only the size-slug uniqueness test would catch that.
    10: ['12x12-square'],
    // Kilter layout 1 size 27, "12 x 12 without kickboard": shadowed by size
    // 10, so 27 is only ever addressable through its qualified form.
    27: ['12x12-square-without-kickboard'],
  },
};

/**
 * The size id a pinned slug names, with no reference to what the size is called
 * upstream today. Exported so the permanence contract in
 * {@link PERMANENT_SIZE_SLUG_ALIASES} can be asserted on its own, independently
 * of whatever qualifier the current board data happens to generate.
 */
export function resolvePermanentSizeSlugAlias(boardName: BoardName, sizeSlug: string): number | null {
  const aliasesForBoard = PERMANENT_SIZE_SLUG_ALIASES[boardName];
  if (!aliasesForBoard) return null;

  for (const [sizeId, aliases] of Object.entries(aliasesForBoard)) {
    if (aliases.includes(sizeSlug)) return Number(sizeId);
  }
  return null;
}

/**
 * Inverse of {@link resolveSizeSlug}. Accepts a qualified slug, the bare legacy
 * one (which keeps resolving to the first match), and any form pinned in
 * {@link PERMANENT_SIZE_SLUG_ALIASES}. Exported so the web app's
 * `getSizeBySlug` resolves the qualified form identically — a link has to mean
 * the same board on both hosts.
 */
export function resolveSizeSlugToId(boardName: BoardName, layoutId: number, sizeSlug: string): number | null {
  const entries = sizeSlugsForLayout(boardName, layoutId);
  const generatedMatch =
    entries.find((entry) => entry.slug === sizeSlug) ?? entries.find((entry) => entry.base === sizeSlug);
  if (generatedMatch) return generatedMatch.id;

  const pinnedSizeId = resolvePermanentSizeSlugAlias(boardName, sizeSlug);
  // A pinned slug still only means this board config if that size is actually on
  // the layout the URL named — the table is keyed by board, not by layout.
  return pinnedSizeId != null && entries.some((entry) => entry.id === pinnedSizeId) ? pinnedSizeId : null;
}

/**
 * Slug for a single set name. Isolated from {@link generateSetSlug} so the
 * reverse direction ({@link resolveBoardSegmentsToIds}) can slugify each
 * candidate set and compare, instead of re-deriving the naming heuristics.
 * Round-tripping is then correct by construction rather than by two
 * hand-matched rule sets.
 */
export function generateSetNameSlug(name: string): string {
  const lowercaseName = name.toLowerCase().trim();

  const hasAux = lowercaseName.includes('auxiliary') || lowercaseName.includes('aux');
  const hasMain = lowercaseName.includes('mainline') || lowercaseName.includes('main');
  const hasKickerVariant = lowercaseName.includes('kickboard') || lowercaseName.includes('kicker');

  if (hasAux && hasKickerVariant) {
    return 'aux-kicker';
  }
  if (hasMain && hasKickerVariant) {
    return 'main-kicker';
  }
  if (hasAux) {
    return 'aux';
  }
  if (hasMain) {
    return 'main';
  }

  const result = lowercaseName.replace(/\s+ons?$/i, '').replace(/\s+/g, '-');

  if (result.startsWith('bolt')) {
    return 'bolt';
  }
  if (result.startsWith('screw')) {
    return 'screw';
  }

  return result;
}

export function generateSetSlug(setNames: string[]): string {
  return setNames
    .map(generateSetNameSlug)
    .sort((leftSetSlug, rightSetSlug) => rightSetSlug.localeCompare(leftSetSlug))
    .join('_');
}

function buildClimbSegment(climbUuid: string, climbName?: string | null): string {
  if (climbName?.trim()) {
    const climbSlug = generateSlugFromText(climbName.trim());
    if (climbSlug) {
      return `${climbSlug}-${climbUuid}`;
    }
  }

  return climbUuid;
}

function buildNumericClimbViewPath({
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  climbUuid,
  climbName,
}: BuildReadableClimbViewPathArgs): string {
  return `/${boardName}/${layoutId}/${sizeId}/${setIds}/${angle}/view/${buildClimbSegment(climbUuid, climbName)}`;
}

function resolveReadableBoardSegments({
  boardName,
  layoutId,
  sizeId,
  setIds,
}: Pick<BuildReadableClimbViewPathArgs, 'boardName' | 'layoutId' | 'sizeId' | 'setIds'>): {
  boardName: BoardName;
  layoutSlug: string;
  sizeSlug: string;
  setSlug: string;
} | null {
  const boardType = toBoardName(boardName);
  if (!boardType) return null;

  const setIdValues = parseSetIds(setIds);
  if (!setIdValues) return null;

  if (boardType === 'moonboard') {
    try {
      const moonBoardDetails = getMoonBoardDetails({ layout_id: layoutId, set_ids: setIdValues });
      if (moonBoardDetails.size_id !== sizeId || moonBoardDetails.set_names.length !== setIdValues.length) return null;

      return {
        boardName: boardType,
        layoutSlug: generateLayoutSlug(moonBoardDetails.layout_name),
        sizeSlug: generateSizeSlug(moonBoardDetails.size_name, moonBoardDetails.size_description),
        setSlug: generateSetSlug(moonBoardDetails.set_names),
      };
    } catch {
      return null;
    }
  }

  if (boardType === 'woods') {
    try {
      const woodsDetails = getWoodsBoardDetails({ size_id: sizeId });
      if (woodsDetails.layout_id !== layoutId) return null;
      // Woods ships one synthetic hold set, so anything but exactly that set
      // names holds the board doesn't have — emit the numeric form instead of a
      // readable URL that would resolve back to a different config.
      const woodsSetIds = new Set<number>(woodsDetails.set_ids);
      if (woodsSetIds.size !== setIdValues.length || setIdValues.some((setId) => !woodsSetIds.has(setId))) {
        return null;
      }

      return {
        boardName: boardType,
        layoutSlug: generateLayoutSlug(woodsDetails.layout_name),
        sizeSlug: generateSizeSlug(woodsDetails.size_name),
        setSlug: generateSetSlug(woodsDetails.set_names),
      };
    } catch {
      return null;
    }
  }

  const layout = getLayout(boardType, layoutId);
  const size = getProductSize(boardType, sizeId);
  const availableSets = getSetsForLayoutAndSize(boardType, layoutId, sizeId);
  const selectedSetNames = availableSets.filter((set) => setIdValues.includes(set.id)).map((set) => set.name);

  if (!layout || !size || selectedSetNames.length !== setIdValues.length) {
    return null;
  }

  // Layout-aware, so a size that shares its slug with another on the same layout
  // still gets an addressable URL (see resolveSizeSlug).
  const sizeSlug = resolveSizeSlug(boardType, layoutId, sizeId);
  if (!sizeSlug) return null;

  return {
    boardName: boardType,
    layoutSlug: generateLayoutSlug(layout.name),
    sizeSlug,
    setSlug: generateSetSlug(selectedSetNames),
  };
}

export function buildReadableClimbViewPath(args: BuildReadableClimbViewPathArgs): string {
  const readableSegments = resolveReadableBoardSegments(args);
  if (!readableSegments) {
    return buildNumericClimbViewPath(args);
  }

  return `/${readableSegments.boardName}/${readableSegments.layoutSlug}/${readableSegments.sizeSlug}/${readableSegments.setSlug}/${args.angle}/view/${buildClimbSegment(args.climbUuid, args.climbName)}`;
}

/**
 * Like {@link buildReadableClimbViewPath} but `null` — rather than the numeric
 * fallback — when the config can't be resolved to readable segments. Callers
 * that want to choose their own fallback (web's `tryConstructSlugViewUrl`) need
 * to tell "resolved" from "gave up" apart.
 */
export function tryBuildReadableClimbViewPath(args: BuildReadableClimbViewPathArgs): string | null {
  return resolveReadableBoardSegments(args) ? buildReadableClimbViewPath(args) : null;
}

export type BuildReadableBoardPathArgs = Pick<
  BuildReadableClimbViewPathArgs,
  'boardName' | 'layoutId' | 'sizeId' | 'setIds' | 'angle'
>;

/** `null`-on-unresolvable counterpart of {@link buildReadableClimbListPath}. */
export function tryBuildReadableClimbListPath(args: BuildReadableBoardPathArgs): string | null {
  return resolveReadableBoardSegments(args) ? buildReadableClimbListPath(args) : null;
}

/** `/kilter/original/12x12-square/screw_bolt/40/list`, numeric-form fallback. */
export function buildReadableClimbListPath(args: BuildReadableBoardPathArgs): string {
  return `${buildReadableBoardBasePath(args)}/list`;
}

/** The board prefix shared by every board surface (no trailing surface segment). */
export function buildReadableBoardBasePath({
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
}: BuildReadableBoardPathArgs): string {
  const readableSegments = resolveReadableBoardSegments({ boardName, layoutId, sizeId, setIds });
  if (!readableSegments) {
    return `/${boardName}/${layoutId}/${sizeId}/${setIds}/${angle}`;
  }
  return `/${readableSegments.boardName}/${readableSegments.layoutSlug}/${readableSegments.sizeSlug}/${readableSegments.setSlug}/${angle}`;
}

// --- Parse direction -------------------------------------------------------
//
// The inverse of the builders above. Both the Next app and the Expo app serve
// the same canonical board URLs, so the SPA needs to turn one back into a board
// config with no server round-trip: named layout/size/set slugs all resolve
// against the static `@boardsesh/board-constants` + MoonBoard tables.

/** A board config recovered from a URL. `setIds` stays the comma-joined form. */
export type ParsedBoardConfigPath = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

/** A climb URL: a board config plus the climb it points at. */
export type ParsedClimbRoutePath = ParsedBoardConfigPath & {
  climbUuid: string;
  /** `view` and `play` are the same destination; kept so callers can log which was shared. */
  surface: 'view' | 'play';
};

const numericSegmentRegex = /^\d+$/;
/**
 * Anchored to the end of the segment because {@link buildClimbSegment} always
 * puts the uuid last (`<name-slug>-<uuid>`). Unanchored, the first 32-hex run
 * won — and a climb whose *name* slugs to a contiguous 32-character hex run
 * ("Beefcafe0ff1ce…" and friends do exist) handed back the name fragment, so a
 * perfectly valid shared link queried a uuid nobody has and rendered
 * not-found. A bare uuid still matches: the whole segment is then the run at
 * the end.
 *
 * Two shapes, because the catalogue holds two. Aurora climbs carry a 32-char
 * unbroken hex uuid; every MoonBoard climb carries a dashed 36-char RFC-4122
 * uuid (`9fe54099-6fdd-5adb-b82f-2d7bcb10d4ad`) — measured on the dev image:
 * 142,566 MoonBoard rows, all dashed, and no other board has one. With only the
 * 32-char form, no MoonBoard climb URL parsed: the whole `<name>-<uuid>` segment
 * was handed on as the uuid, so the climb query missed and the page 404'd, while
 * the same page reached by its bare uuid rendered a `<link rel="canonical">`
 * pointing straight at that 404.
 *
 * The dashed alternative cannot steal a match from an Aurora segment: its final
 * group must be preceded by a `-`, and the character 12 back from the end of a
 * 32-hex uuid is always a hex digit.
 */
const climbUuidRegex = /(?:[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}|[0-9A-F]{32})$/i;

function isNumericSegment(value: string): boolean {
  return numericSegmentRegex.test(value);
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Strip the origin, query, hash and a leading path locale, then split into
 * segments. Mirrors the tolerance of `parseBoardPath` in
 * `@boardsesh/board-config`: no board name is two characters, so a bare
 * `/^[a-z]{2}$/` test can't swallow a real segment.
 */
function toRouteSegments(path: string): string[] {
  if (!path) return [];
  // Hash and query come off *before* the scheme sniff. A relative path can carry
  // an absolute URL inside its query (`/kilter/…/view/<uuid>?next=https://x/y`);
  // sniffing for `://` first read that as the origin, cut everything up to the
  // query's own first slash, and threw the real path away.
  let pathname = path.split('#')[0].split('?')[0];

  const schemeIndex = pathname.indexOf('://');
  if (schemeIndex !== -1) {
    const afterScheme = pathname.slice(schemeIndex + 3);
    const firstSlash = afterScheme.indexOf('/');
    pathname = firstSlash === -1 ? '' : afterScheme.slice(firstSlash);
  }

  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length > 0 && /^[a-z]{2}$/.test(segments[0])) {
    segments.shift();
  }
  return segments;
}

/**
 * The climb UUID out of a `crimpy-thing-<uuid>` URL segment. Falls back to the
 * segment itself so a bare uuid (or an unrecognised value the caller wants to
 * surface in its own not-found) passes through unchanged.
 */
export function extractUuidFromClimbSegment(segment: string): string {
  const match = decodeSegment(segment).match(climbUuidRegex);
  return match ? match[0] : segment;
}

/** A slug with its hyphens dropped and case folded — see {@link moonBoardLayoutSlugForms}. */
function toHyphenlessSlug(value: string): string {
  return value.replace(/-/g, '').toLowerCase();
}

/**
 * Every layout-slug form a MoonBoard URL may legitimately carry, one entry per
 * layout, in the order `MOONBOARD_LAYOUTS` declares them — the same order the
 * web app's `getMoonBoardLayoutBySlug` walks, so both hosts pick the same layout
 * if two ever became ambiguous.
 *
 * Web accepts three forms and has since MoonBoard shipped, so older web builds
 * minted links in all of them:
 *
 *   - `generateLayoutSlug(layout.name)` — canonical, what we emit (`2016`)
 *   - the config key verbatim (`moonboard-2016`)
 *   - the config key however it is hyphenated, in any case (`moonboard2016`) —
 *     web compares the key and the incoming slug with hyphens stripped
 *
 * Only accepting the canonical form here 404'd every legacy MoonBoard link the
 * moment the Expo app started parsing these URLs, while www kept serving them.
 * The alternates are derived from the same two inputs web derives them from
 * (the key and the layout name) rather than hand-listed, so a new layout picks
 * up its legacy forms for free.
 */
const moonBoardLayoutSlugForms: {
  layoutKey: MoonBoardLayoutKey;
  layoutId: number;
  /** Matched verbatim: the canonical slug, and the config key. */
  exactForms: ReadonlySet<string>;
  /** Matched against the incoming slug once both have their hyphens dropped. */
  hyphenlessKey: string;
}[] = Object.entries(MOONBOARD_LAYOUTS).map(([layoutKey, layout]) => ({
  layoutKey: layoutKey as MoonBoardLayoutKey,
  layoutId: layout.id,
  exactForms: new Set([generateLayoutSlug(layout.name), layoutKey]),
  hyphenlessKey: toHyphenlessSlug(layoutKey),
}));

function resolveMoonBoardSegmentsToIds({
  layoutSlug,
  sizeSlug,
  setSlug,
}: {
  layoutSlug: string;
  sizeSlug: string;
  setSlug: string;
}): Omit<ParsedBoardConfigPath, 'angle'> | null {
  // MoonBoard's size segment carries no information: the board has exactly one
  // size, so every MoonBoard URL means `MOONBOARD_SIZE` whatever the segment
  // says. Web's `getMoonBoardSizeBySlug` ignores it outright, which is why links
  // minted before today's `standard-11x18-grid` form still resolve on www.
  // Matching that costs nothing — there is no other size to resolve to, so a
  // stale spelling can't point at the wrong board — but demanding the canonical
  // string turned those same links into not-founds in the Expo app.
  if (!sizeSlug) return null;

  for (const { layoutKey, layoutId, exactForms, hyphenlessKey } of moonBoardLayoutSlugForms) {
    if (!exactForms.has(layoutSlug) && hyphenlessKey !== toHyphenlessSlug(layoutSlug)) continue;

    // Sets stay exact, deliberately unlike web. `getMoonBoardSetsBySlug` splits
    // the slug on `-` (canonical set slugs join on `_`), substring-matches the
    // pieces against set names, and falls back to *every* set on the layout when
    // nothing matches — so it cannot tell one subset from another and would
    // light holds the URL never asked for. Both hosts generate set slugs with
    // the functions above, so anything either host emitted rebuilds exactly.
    const sets = MOONBOARD_SETS[layoutKey] ?? [];
    const setSlugParts = new Set(setSlug.split('_'));
    const selectedSets = sets.filter((set) => setSlugParts.has(generateSetNameSlug(set.name)));
    if (selectedSets.length === 0) continue;
    if (generateSetSlug(selectedSets.map((set) => set.name)) !== setSlug) continue;

    return {
      boardName: 'moonboard',
      layoutId,
      sizeId: MOONBOARD_SIZE.id,
      setIds: selectedSets.map((set) => set.id).join(','),
    };
  }

  return null;
}

/**
 * The Woods half of the parse direction. Woods carries no rows in the generated
 * layout/size/set tables, so the catalogue walk below finds nothing for it —
 * everything resolves off the static `woods-config` constants instead.
 *
 * Both the readable form this app emits (`original` / `8x10` | `12x12` /
 * `standard`) and the bare numeric ids resolve, because a URL can mix them: the
 * all-numeric path never reaches here, but `/woods/original/2/standard/40` does.
 * The accepted forms are kept in step with www's server-side parser
 * (`packages/web/app/lib/url-utils.server.ts`) — same segments, same casing
 * rules, same dashed size variants — so a link that opens on the website opens
 * in the app too. The set segment stays exact for the same reason MoonBoard's
 * does: a slug that doesn't rebuild is not a form either host emitted, so it
 * isn't authoritative about what's on the wall.
 */
function resolveWoodsSegmentsToIds({
  layoutSlug,
  sizeSlug,
  setSlug,
}: {
  layoutSlug: string;
  sizeSlug: string;
  setSlug: string;
}): Omit<ParsedBoardConfigPath, 'angle'> | null {
  // Slugs are lower-case by construction, but a hand-typed or link-shortened URL
  // can arrive upper-cased; www lower-cases every Woods segment before matching.
  const layoutSegment = layoutSlug.toLowerCase();
  const sizeSegment = sizeSlug.toLowerCase();
  const setSegment = setSlug.toLowerCase();

  const woodsLayout = WOODS_LAYOUTS.woods;
  if (layoutSegment !== generateLayoutSlug(woodsLayout.name) && layoutSegment !== String(woodsLayout.id)) return null;

  // Size: the numeric id ('1' / '2'), the dimension slug ('8x10' / '12x12'), or
  // its dashed variant ('8-10' / '12-12').
  const size = Object.values(WOODS_SIZES).find((candidate) => {
    const dimensionSlug = generateSizeSlug(candidate.name);
    return (
      sizeSegment === String(candidate.id) ||
      sizeSegment === dimensionSlug ||
      sizeSegment === dimensionSlug.replace('x', '-')
    );
  });
  if (!size) return null;

  const woodsSetIds = WOODS_SETS.map((woodsSet) => woodsSet.id);
  const canonicalSetSlug = generateSetSlug(WOODS_SETS.map((woodsSet) => woodsSet.name));
  // The one form www accepts that this resolver deliberately does not is the
  // EMPTY set segment. www needs it because a board path can be built with no
  // sets; here an empty segment can only come from a hand-edited slug URL, and
  // resolving it would mean inventing a set list the URL never named.
  if (setSegment !== canonicalSetSlug && setSegment !== woodsSetIds.join(',')) return null;

  return {
    boardName: 'woods',
    layoutId: woodsLayout.id,
    sizeId: size.id,
    setIds: woodsSetIds.join(','),
  };
}

/**
 * Inverse of {@link resolveReadableBoardSegments}: named URL slugs back to the
 * numeric board config. Resolution is generate-and-compare against the static
 * board tables — every candidate layout/size/set is slugified with the very
 * functions the builder uses, so a URL this app emitted always round-trips, and
 * an ambiguous or hand-edited one resolves to `null` rather than to the wrong
 * board.
 */
export function resolveBoardSegmentsToIds({
  boardName,
  layoutSlug,
  sizeSlug,
  setSlug,
}: {
  boardName: string;
  layoutSlug: string;
  sizeSlug: string;
  setSlug: string;
}): Omit<ParsedBoardConfigPath, 'angle'> | null {
  const boardType = toBoardName(boardName);
  if (!boardType) return null;

  if (boardType === 'moonboard') {
    return resolveMoonBoardSegmentsToIds({ layoutSlug, sizeSlug, setSlug });
  }

  if (boardType === 'woods') {
    return resolveWoodsSegmentsToIds({ layoutSlug, sizeSlug, setSlug });
  }

  const layout = getAllLayouts(boardType).find((candidate) => generateLayoutSlug(candidate.name) === layoutSlug);
  if (!layout) return null;

  // Accepts the qualified slug and the bare legacy one — see resolveSizeSlug.
  const sizeId = resolveSizeSlugToId(boardType, layout.id, sizeSlug);
  if (sizeId == null) return null;

  const setSlugParts = new Set(setSlug.split('_'));
  const selectedSets = getSetsForLayoutAndSize(boardType, layout.id, sizeId).filter((set) =>
    setSlugParts.has(generateSetNameSlug(set.name)),
  );
  if (selectedSets.length === 0) return null;
  // Reject anything that doesn't rebuild to the exact slug we were given: two
  // sets can share a slug, and a partial match would silently light the wrong
  // holds.
  if (generateSetSlug(selectedSets.map((set) => set.name)) !== setSlug) return null;

  return {
    boardName: boardType,
    layoutId: layout.id,
    sizeId,
    setIds: selectedSets.map((set) => set.id).join(','),
  };
}

/**
 * Parse the five board-config segments off the front of a route. Accepts both
 * canonical forms:
 *
 *   `/kilter/original/12x12-square/screw_bolt/40/...`  (named, what we emit)
 *   `/kilter/1/10/1,20/40/...`                         (legacy numeric IDs)
 *
 * The numeric branch requires *every* config segment to be numeric — real
 * layout slugs like `2020` exist, so a mixed path must go through slug
 * resolution or not at all. Returns the parsed board plus whatever route
 * segments follow it.
 */
export function parseBoardRoutePath(path: string): { board: ParsedBoardConfigPath; rest: string[] } | null {
  const segments = toRouteSegments(path);
  if (segments.length < 5) return null;

  const [boardName, layoutSegment, sizeSegment, setSegment, angleSegment] = segments.map(decodeSegment);
  if (!isNumericSegment(angleSegment) && !/^-\d+$/.test(angleSegment)) return null;
  const angle = Number(angleSegment);
  const rest = segments.slice(5);

  const allNumeric =
    isNumericSegment(layoutSegment) &&
    isNumericSegment(sizeSegment) &&
    setSegment.split(',').every((setId) => isNumericSegment(setId.trim()));

  if (allNumeric) {
    const boardType = toBoardName(boardName);
    if (!boardType) return null;
    return {
      board: {
        boardName: boardType,
        layoutId: Number(layoutSegment),
        sizeId: Number(sizeSegment),
        setIds: setSegment
          .split(',')
          .map((setId) => setId.trim())
          .join(','),
        angle,
      },
      rest,
    };
  }

  const resolved = resolveBoardSegmentsToIds({
    boardName,
    layoutSlug: layoutSegment,
    sizeSlug: sizeSegment,
    setSlug: setSegment,
  });
  if (!resolved) return null;

  return { board: { ...resolved, angle }, rest };
}

/** `/{board}/{layout}/{size}/{sets}/{angle}/list` → board config. */
export function parseBoardListPath(path: string): ParsedBoardConfigPath | null {
  const parsed = parseBoardRoutePath(path);
  if (!parsed || parsed.rest.length !== 1 || parsed.rest[0] !== 'list') return null;
  return parsed.board;
}

/** `/{board}/…/{angle}/view|play/{climbSlug-uuid}` → board config + climb uuid. */
export function parseClimbRoutePath(path: string): ParsedClimbRoutePath | null {
  const parsed = parseBoardRoutePath(path);
  if (!parsed || parsed.rest.length !== 2) return null;

  const [surface, climbSegment] = parsed.rest;
  if (surface !== 'view' && surface !== 'play') return null;

  const climbUuid = extractUuidFromClimbSegment(climbSegment);
  if (!climbUuid) return null;

  return { ...parsed.board, climbUuid, surface };
}
