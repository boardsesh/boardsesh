// BLE scan timing constants, shared across the web and mobile adapters (and
// their tests) so the two platforms can't drift apart. Pure values — no React,
// no platform APIs.

// How long a reconnect to the saved board (by serial, or by device id for a
// MoonBoard) keeps auto-selecting it before the picker switches to the full
// list. Since #5658 the picker is on screen for this whole window, in a
// "searching for your board" state with a "Search for any board" way out, so
// the window is no longer a blank wait. It only decides when the list takes over
// from the search. (A connect started while the app is in the background, from
// the Android notification bulb, still shows nothing until the list.)
//
// Was 4s, but Aurora boxes routinely take longer than that to re-advertise
// after a link loss, so most mid-session reconnects fell through to the list
// instead of reconnecting to the saved board (#3609). Kept well below
// SCAN_TIMEOUT_MS so a truly-gone board still reaches the list with plenty of
// live-scan time to spare.
export const SERIAL_RECONNECT_GRACE_MS = 10_000;

// How long the overall scan runs before it stops to avoid indefinite battery
// drain. By this point a reconnect to the saved board has already switched the
// picker to the list (the grace window is much shorter).
export const SCAN_TIMEOUT_MS = 30_000;
