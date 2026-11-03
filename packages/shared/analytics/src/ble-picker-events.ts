/**
 * Release-watch props for `BLE Picker Devices Resolved` (2.7). The event fires
 * once per picker session that showed its list, so these ride it instead of a
 * new event: no extra event per session, and the 2.6 sessions read as "absent"
 * on every one of them.
 *
 * Read with the event's resolution counts (`devicesTotal`, `noneMatchedSelectedType`,
 * and from #7202 `targetMatchedDevices` / `targetUnknownDevices` /
 * `targetOtherDevices`) to tell an empty room from a board the list hid, and
 * a newcomer's first picker from a regular's.
 */
export type BlePickerSessionInput = {
  /** The list first showed filtered to a known gym or saved board. */
  targetFiltered: boolean;
  /** The climber tapped "Search for any board" (in the search, or on the filtered list). */
  searchedAnyBoard: boolean;
  /**
   * Boards the list showed when it closed: while filtered, the target's own plus
   * the unidentified ones of its type (#7202); every board found otherwise.
   */
  listedCount: number;
  /** "Your board isn't in the list" showed: boards were found, none of them the target. */
  targetNotListedSeen: boolean;
  /** The picker's troubleshooting tips (hardware, location permission or Location services) showed. */
  tipsSeen: boolean;
  /** `Date.now()` when the tips first showed; null when they never did. */
  tipsSeenAt: number | null;
  /** The climber closed the picker with "Browse for now" (no board; picks open as previews). */
  browsedForNow: boolean;
  /** `Date.now()` when the list first showed. */
  openedAt: number;
  /** `Date.now()` when the session closed. */
  closedAt: number;
  /** This phone had never connected to a board; null while that is not known yet. */
  phoneNeverConnected: boolean | null;
  /** The control whose tap opened this picker (`Board Connect Tapped`'s surface), or null with no tap before it. */
  entrySurface: string | null;
};

export type BlePickerSessionProps = {
  targetFiltered: boolean;
  searchedAnyBoard: boolean;
  listedCount: number;
  targetNotListedSeen: boolean;
  tipsSeen: boolean;
  /**
   * Milliseconds from the list showing to the tips first showing, never
   * negative; null when the tips never showed. From 2026-11 the tips come in 5 s
   * into the scan, so a list that came up straight from the tap reads about
   * 5,000, and one that took over from a saved-board search reads near 0.
   */
  tipsShownAtMs: number | null;
  browsedForNow: boolean;
  /** Whole seconds from the list showing to the session closing, never negative. */
  secondsOpen: number;
  phoneNeverConnected: boolean | null;
  entrySurface: string | null;
};

/** The release-watch props for one picker session. */
export function blePickerSessionProps(input: BlePickerSessionInput): BlePickerSessionProps {
  return {
    targetFiltered: input.targetFiltered,
    searchedAnyBoard: input.searchedAnyBoard,
    listedCount: Math.max(0, Math.floor(input.listedCount)),
    targetNotListedSeen: input.targetNotListedSeen,
    tipsSeen: input.tipsSeen,
    tipsShownAtMs: input.tipsSeenAt === null ? null : Math.max(0, Math.round(input.tipsSeenAt - input.openedAt)),
    browsedForNow: input.browsedForNow,
    secondsOpen: Math.max(0, Math.round((input.closedAt - input.openedAt) / 1000)),
    phoneNeverConnected: input.phoneNeverConnected,
    entrySurface: input.entrySurface,
  };
}
