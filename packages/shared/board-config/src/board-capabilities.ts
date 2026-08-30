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
   * New climbs can be set on the board from inside Boardsesh (create / fork /
   * edit).
   *
   * False on Woods: the create-climb editor paints holds through
   * `getCreateBoardHolds`, whose `family` falls through to `'aurora'` for
   * anything that isn't MoonBoard — so a Woods draft would be saved with Aurora
   * role codes instead of the Woods wire roles (`p{loc}r{code}`, spec §6) the
   * board's LEDs and our own frames parser speak. It would also be published
   * against a board with no `board_placements` rows behind it, which the hold
   * filters and the setter surfaces both read.
   *
   * So Create / Fork / Edit are HIDDEN for Woods rather than left to fail:
   * browsing, lighting up and ticking the imported Woods catalog all work.
   * Setting your own Woods climbs is boardsesh/boardsesh#4750.
   */
  climbCreation: boolean;
  /**
   * Native code can encode and drive the board without going through JS.
   *
   * The Live Activity widget's Previous/Next App Intents encode and write the
   * wall packet natively from Swift (`BoardBleEncoding`), which has no Woods
   * encoder and would fall through to the Aurora one — lighting the wrong holds,
   * or nothing at all. Until the Swift side learns Woods
   * (boardsesh/boardsesh#3314) the wall-driving widget controls must not be
   * offered for it, and the adapter factory keeps Woods on `RNBleAdapter` even
   * on iOS: the JS write path is the only one that can encode a Woods board
   * today.
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
  climbCreation: true,
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
  climbCreation: true,
  nativeBoardControl: true,
  auroraAppLink: false,
};

/**
 * Woods: a static catalog import — browse, search, light up and tick all work.
 * Each remaining `false` has its own follow-up: #4750 (create), #3314 (the Swift
 * encoder).
 */
const WOODS_CAPABILITIES: BoardCapabilities = {
  crowdGrade: false,
  climbCreation: false,
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
