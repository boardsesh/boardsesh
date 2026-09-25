// One table for the per-board feature switches.
//
// Every board we support answers a slightly different set of questions: an
// Aurora board has hardware placements, a crowd grade, a create-climb path, a
// Swift encoder and a public `<board>boardapp.com` page; the code-driven boards
// (MoonBoard, Woods) each have some of that and not the rest. Those answers used
// to live as one-off predicates scattered across the mobile app
// (`lacksCrowdGrade`, `supportsClimbCreation`, `supportsHoldFilters`,
// `supportsNativeBoardControl`), which meant adding a board was a hunt for every
// `boardName !== 'woods'` in the tree. They are one table now: read a capability
// here, and a new board is one row.
//
// A capability leaves the table once every board answers yes to it — `holdFilters`
// did, when Woods learned to answer a hold/zone search off its own geometry
// (boardsesh/boardsesh#4748). A future board that can't reintroduces the row.
//
// Deliberately NOT in here:
//  - `isSizeScopedBoard` — mirrored into offline-sync by design, so it stays
//    where the sync engine can duplicate it without importing this package.
//  - `preferWriteWithResponse` — a BLE transport option (which GATT write type
//    the firmware accepts), not a product capability. It lives with the adapter
//    factory.

import type { BoardName } from '@boardsesh/shared-schema';

export type BoardCapabilities = {
  /**
   * The board has a crowd/consensus grade behind it, so the nightly Boardsesh
   * grade job has ascent data to compute from.
   *
   * False on MoonBoard (no standardized community grade) and Woods (its app
   * ships only the setter's V number). The play drawer skips the grade fetch
   * entirely for those and explains the gap instead of showing an empty section.
   */
  crowdGrade: boolean;
  /**
   * A climb on this board carries its grade and its ascents at the ONE angle it
   * was set at, so browsing any other angle finds no stats row for it. On Woods the
   * shape is total: 5,392 listed climbs share 5,398 stats rows between them, so
   * browsing 30° finds a row for 653 of them.
   *
   * What the queries do about it (`packages/db/src/queries/climbs/effective-stats.ts`
   * and its offline mirror in `packages/mobile/src/db/queries/search-climbs-local.ts`):
   *
   *   - **Search is restricted to the browsed angle by default** (issue #5642): it
   *     keeps a climb set at that angle, one with no set angle recorded, or one with
   *     a stats row there. A climb set at 40° is a different problem, not the same
   *     problem steeper, and a climber browsing 30° wants the 30° climbs.
   *   - **`ClimbSearchInput.crossAngleStats: true` opts into #5413's resolution**
   *     (issue #5405): every angle's climbs are listed, and each one is graded and
   *     ranked by the row at its own set angle when the browsed angle has none. A
   *     by-name search does the same by itself, so a climb is findable by name at
   *     any angle. Omitted means off, on every board.
   *   - **The climb detail read always resolves cross-angle**, so a climb opened at
   *     an angle it was not set at shows its set-angle grade rather than a blank one.
   *
   * On a board where this is false none of the three applies: search reads the
   * browsed angle only, lists every climb, and `crossAngleStats: true` is still the
   * one way into cross-angle resolution.
   *
   * **True on Woods only.** MoonBoard has exactly the same shape — 4,832 of 38,642
   * climbs on the 2016 layout have a row at 25° — and was held off while this flag
   * forced cross-angle resolution, on cost. That resolution makes the sort key a
   * conditional over two joined rows, which no index can be stored in, so the query
   * loses the early termination that `board_climb_stats_ascents_covering_v2_idx`
   * gives it and has to rank the whole layout. Measured on production:
   *
   *   woods layout 1 @30°       63 ms  ->   122 ms   (5.4k climbs)
   *   moonboard layout 2 @25°  6.8 ms  ->   729 ms   (92k climbs)
   *   moonboard layout 2 @40°  1.0 ms  ->   936 ms   (92k climbs)
   *   kilter layout 1 @40°     1.6 ms  -> 5,587 ms   (320k climbs)
   *
   * Since #5642 the flag no longer forces that; turning MoonBoard on now would mean
   * restricting its browse to the set angle by default, which is a product call
   * nobody has made. The numbers still price `crossAngleStats: true` itself: regaining
   * early termination needs two index-ordered streams merged at the page boundary,
   * which needs a new `(board_type, ascensionist_count DESC, climb_uuid)` index
   * because every existing ascent/quality index is prefixed `(board_type, angle, …)`.
   * Until that lands, the mobile flag that opts non-Woods boards in MUST stay at 0%.
   * Tracked in issue #5412.
   */
  angleBoundClimbs: boolean;
  /**
   * New climbs can be set on the board from inside Boardsesh (create / fork /
   * edit).
   *
   * True everywhere now. Woods was the last holdout: the editor paints holds
   * through `getCreateBoardHolds`, which reported the Aurora family for it, and
   * a Woods board has no `board_placements` rows. Both were answered by #4750 —
   * `getCreateBoardHolds` reports `'woods'` off the code-driven geometry
   * (`getWoodsRenderData`), and the shared role machine already encodes the
   * Woods wire roles (`p{loc}r{code}`, spec §6) because
   * `STATE_TO_PRIMARY_CODE.woods` has carried them since the catalog import.
   *
   * The row stays in the table: a future board can arrive with a catalog and no
   * way to author on it, which is exactly the state Woods shipped in.
   */
  climbCreation: boolean;
  /**
   * The board's climbs state BOTH climb rules (matching, feet) as data, so the
   * play drawer prints both under the climb's subtitle instead of showing only
   * the exceptions.
   *
   * True on Woods only. The Woods app states both rules on every problem and its
   * catalogue carries them per climb, so a Woods climber reads "Matching
   * allowed · Marked holds only" as part of the problem. Aurora and MoonBoard
   * climbs carry the same tokens, but their apps (and ours, for years) show only
   * the departures from the default — a no-match glyph, a method badge — and
   * spelling out two extra lines under every Kilter climb would bury the grade
   * and the setter under boilerplate nobody asked for.
   */
  explicitClimbRules: boolean;
  /**
   * A climb on this board can hold more than one frame (a route / circuit that
   * steps through hold sets), so the editor offers duplicate/delete/step frame
   * controls.
   *
   * False on Woods. Its wire format is one flat `p{loc}r{code}` run per message
   * and `getWoodsBluetoothPacket` throws `WoodsMultiFrameError` on the comma a
   * second frame introduces (spec §5) — so a two-frame Woods climb would save
   * fine and then refuse to light the wall. The controls are hidden rather than
   * left to fail, the same way Create was before #4750.
   */
  multiFrameClimbs: boolean;
  /**
   * Native code can encode and drive the board without going through JS.
   *
   * The Live Activity widget's Previous/Next App Intents encode and write the
   * wall packet natively from Swift (`BoardBleEncoding`), which drives the
   * Aurora family, MoonBoard, and — since #3314 — Woods.
   *
   * This is the static PRODUCT capability: "some Boardsesh binary drives this
   * board natively". Because JS rides OTA onto older binaries, every consumer
   * must ALSO ask the running binary via `nativeBleSupportsBoard`
   * (packages/mobile/src/lib/ble/native-ios-adapter.ts) before routing a board
   * to the native path — a pre-#3314 Swift layer would encode a Woods packet
   * as Aurora and light the wrong holds.
   */
  nativeBoardControl: boolean;
  /**
   * The board has an official `<board>boardapp.com` climb page to deep-link out
   * to.
   *
   * Only the Aurora boards do. The code-driven boards (MoonBoard, Woods) would
   * otherwise get a URL at a domain that does not exist and the row would open a
   * browser on an error page. Kilter is an Aurora board that no longer publishes
   * one, so the URL builder drops it separately — this flag is about the family
   * having such a site at all.
   */
  auroraAppLink: boolean;
};

/**
 * What an Aurora board can do — everything. Also the answer for an unknown or
 * absent board name: it is what every caller did before this table existed
 * (`boardName !== 'woods'`, i.e. true for anything unrecognised), so a typo'd or
 * not-yet-resolved board keeps today's behaviour rather than silently losing
 * features. Callers that genuinely care about a missing board already guard on
 * it separately.
 */
const AURORA_CAPABILITIES: BoardCapabilities = {
  crowdGrade: true,
  angleBoundClimbs: false,
  climbCreation: true,
  explicitClimbRules: false,
  multiFrameClimbs: true,
  nativeBoardControl: true,
  auroraAppLink: true,
};

/**
 * MoonBoard: code-driven geometry with handwritten hold maps, a Swift encoder,
 * an in-app create/import flow and `board_placements` rows seeded by
 * `backfill-moonboard-hardware.ts`. What it lacks is a standardized community
 * grade and a `moonboardapp.com` climb page.
 */
const MOONBOARD_CAPABILITIES: BoardCapabilities = {
  crowdGrade: false,
  // Same angle-bound shape as Woods, still off — see the field's doc for why.
  angleBoundClimbs: false,
  climbCreation: true,
  explicitClimbRules: false,
  multiFrameClimbs: true,
  nativeBoardControl: true,
  auroraAppLink: false,
};

/**
 * Woods: a code-driven catalog — browse, search, light up, tick and (since
 * #4750) author. `nativeBoardControl` became true with the Swift Woods encoder
 * (#3314) — binaries older than that are screened out at the consumer sites by
 * `nativeBleSupportsBoard`. `crowdGrade` stays false until there is community
 * grade data behind it.
 */
const WOODS_CAPABILITIES: BoardCapabilities = {
  crowdGrade: false,
  angleBoundClimbs: true,
  climbCreation: true,
  explicitClimbRules: true,
  multiFrameClimbs: false,
  nativeBoardControl: true,
  auroraAppLink: false,
};

/**
 * Spray walls: a climber's own wall, photographed rather than catalogued. Its
 * holds live in `spray_wall_holds` and its catalogue layout is created at
 * runtime, so it is the first board whose geometry is per-wall data.
 *
 * `climbCreation` is the whole point — a wall with no climbs on it is a photo.
 * Everything else is false: there is no hardware (`nativeBoardControl` — no
 * LEDs, no firmware, nothing to encode), no vendor site to deep-link to
 * (`auroraAppLink`), no crowd grade model (`crowdGrade` — the setter's grade is
 * required on publish instead), and no multi-frame climbs. `explicitClimbRules`
 * stays false so a spray climb reads like a Kilter one: only the departures from
 * the default are printed.
 *
 * Mirroring is off too, but that is `boardSupportsMirroring`'s answer, not a row
 * here: a spray wall is a photograph of one physical wall and has no mirror
 * geometry to reflect holds through.
 */
const SPRAY_CAPABILITIES: BoardCapabilities = {
  crowdGrade: false,
  // A wall's angle is fixed at creation, so every climb on it is set — and
  // browsed — at that one angle. There is no other angle for a stats row to be
  // missing at or for a climb to belong to, so neither the browsed-angle
  // restriction nor the cross-angle fallback has anything to do here.
  angleBoundClimbs: false,
  climbCreation: true,
  explicitClimbRules: false,
  multiFrameClimbs: false,
  nativeBoardControl: false,
  auroraAppLink: false,
};

// Typed as a total Record over BoardName, so adding a board to SUPPORTED_BOARDS
// without deciding what it can do is a compile error rather than a silent
// fallthrough to the Aurora defaults.
const CAPABILITIES_BY_BOARD: Record<BoardName, BoardCapabilities> = {
  kilter: AURORA_CAPABILITIES,
  tension: AURORA_CAPABILITIES,
  decoy: AURORA_CAPABILITIES,
  touchstone: AURORA_CAPABILITIES,
  grasshopper: AURORA_CAPABILITIES,
  soill: AURORA_CAPABILITIES,
  moonboard: MOONBOARD_CAPABILITIES,
  woods: WOODS_CAPABILITIES,
  spray: SPRAY_CAPABILITIES,
};

/**
 * The feature switches for one board. Case-insensitive, and unknown/undefined
 * names get the Aurora defaults (see `AURORA_CAPABILITIES`).
 */
export function getBoardCapabilities(boardName: string | undefined): BoardCapabilities {
  if (!boardName) return AURORA_CAPABILITIES;
  const capabilities: BoardCapabilities | undefined = CAPABILITIES_BY_BOARD[boardName.toLowerCase() as BoardName];
  return capabilities ?? AURORA_CAPABILITIES;
}
