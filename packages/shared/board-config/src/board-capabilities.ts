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
   * was set at, so browsing any other angle finds no stats row for it, and search
   * should fall back to the climb's own set angle
   * (`packages/db/src/queries/climbs/search-climbs.ts`, issue #5405).
   *
   * **True on Woods only, and the reason is cost, not shape.** On Woods the effect
   * is total: 5,392 listed climbs share 5,398 stats rows between them, so browsing
   * 30° finds a row for 653 of them and the other 88% sank below every climb set at
   * 30° and rendered a blank grade with a "Project" subtitle.
   *
   * MoonBoard has exactly the same shape — 4,832 of 38,642 climbs on the 2016
   * layout have a row at 25° — and is nonetheless FALSE here. The fallback makes the
   * sort key a conditional over two joined rows, which no index can be stored in, so
   * the query loses the early termination that
   * `board_climb_stats_ascents_covering_v2_idx` gives it and has to rank the whole
   * layout. Measured on production:
   *
   *   woods layout 1 @30°       63 ms  ->   122 ms   (5.4k climbs)
   *   moonboard layout 2 @25°  6.8 ms  ->   729 ms   (92k climbs)
   *   moonboard layout 2 @40°  1.0 ms  ->   936 ms   (92k climbs)
   *   kilter layout 1 @40°     1.6 ms  -> 5,587 ms   (320k climbs)
   *
   * MoonBoard's own traffic settles it: 88% of its searches are at 40°, where
   * coverage is already 99% and nothing was broken, so turning it on there would buy
   * nothing and cost a second. Woods is small enough that doubling a 63 ms search is
   * affordable, and it is the board the bug was reported on.
   *
   * Turning the other boards on needs the query to regain early termination — two
   * index-ordered streams merged at the page boundary, which needs a new
   * `(board_type, ascensionist_count DESC, climb_uuid)` index because every existing
   * ascent/quality index is prefixed `(board_type, angle, …)`. Until that lands,
   * `ClimbSearchInput.crossAngleStats` opts a request in and the mobile flag behind
   * it MUST stay at 0%. Tracked in issue #5412.
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
  // Same angle-bound shape as Woods, held off on cost alone — see the field's doc.
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
