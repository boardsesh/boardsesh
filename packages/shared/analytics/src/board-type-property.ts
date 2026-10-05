// `boardType` on the climbing outcome events (#6027).
//
// `Tick Logged`, `Set Active Climb` and `Climb Created` used to say which
// layout they happened on and nothing about which board. A spray wall's layout
// id is minted when the wall is created, so a layout id cannot tell a spray
// session from a Kilter one in PostHog, and a spray-first climber's whole first
// week was invisible to any activation measure.
//
// The value is a CLOSED set: the nine board types, or null. Nothing else can
// get through, which is what keeps this inside the spray telemetry rule that no
// event may identify a wall (`docs/spray-walls.md`, "Telemetry"). A wall's
// name, slug or uuid passed here by mistake comes out as null, not as a value.
//
// The property is named `boardType` to match `Board Created`, the event these
// three are joined to. `Wall Taken` and `Board Route Handoff` call the same
// value `boardName`; they are older and keep their name.

/**
 * The board types an event may name. Kept in step with `SUPPORTED_BOARDS` in
 * `@boardsesh/shared-schema` by a parity test in the mobile package: this
 * package has no dependencies, and one string list is not a reason to add one.
 */
export const ANALYTICS_BOARD_TYPES = [
  'kilter',
  'tension',
  'moonboard',
  'decoy',
  'touchstone',
  'grasshopper',
  'soill',
  'woods',
  'spray',
] as const;

export type AnalyticsBoardType = (typeof ANALYTICS_BOARD_TYPES)[number];

export type BoardTypeProperty = { boardType: AnalyticsBoardType | null };

const knownBoardTypes: ReadonlySet<string> = new Set(ANALYTICS_BOARD_TYPES);

function isAnalyticsBoardType(boardName: string): boardName is AnalyticsBoardType {
  return knownBoardTypes.has(boardName);
}

/**
 * The `boardType` prop for an event fired on `boardName`. Null when the board
 * is unknown at the call site (no active board yet) or is not one of the nine,
 * so the prop is always present and a missing board reads as null rather than
 * as an event from an older build.
 */
export function boardTypeProperty(boardName: string | null | undefined): BoardTypeProperty {
  return { boardType: boardName != null && isAnalyticsBoardType(boardName) ? boardName : null };
}
