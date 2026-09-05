// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// BLE scan timing constants, shared across the web and mobile adapters (and
// their tests) so the two platforms can't drift apart. Pure values — no React,
// no platform APIs.

// How long a reconnect-by-serial waits for the stored board to advertise before
// falling back to the picker. Long enough that a present board reconnects
// silently without the picker ever flashing, short enough that a genuinely
// absent board still surfaces the picker well inside the scan window.
//
// Was 4s, but Aurora boxes routinely take longer than that to re-advertise
// after a link loss, so the "silent" reconnect degraded into the device picker
// on most mid-session reconnects (#3609). During this window the lightbulb shows
// its pending state and no picker is mounted, so a longer grace is just a
// slightly longer "connecting…", not a worse experience. Kept well below
// SCAN_TIMEOUT_MS so a truly-gone board still reaches the picker with plenty of
// live-scan time to spare.
export const SERIAL_RECONNECT_GRACE_MS = 10_000;

// How long the overall scan runs before it stops to avoid indefinite battery
// drain. By this point a reconnect-by-serial has already handed off to the
// picker (the grace window is much shorter).
export const SCAN_TIMEOUT_MS = 30_000;
