// BLE scan timing constants, shared across the web and mobile adapters (and
// their tests) so the two platforms can't drift apart. Pure values — no React,
// no platform APIs.

// How long a reconnect-by-serial waits for the stored board to advertise before
// falling back to the picker. Short enough that a missing board surfaces the
// picker quickly; long enough that a present board (which advertises within a
// second or two) reconnects silently without the picker ever flashing.
export const SERIAL_RECONNECT_GRACE_MS = 4_000;

// How long the overall scan runs before it stops to avoid indefinite battery
// drain. By this point a reconnect-by-serial has already handed off to the
// picker (the grace window is much shorter).
export const SCAN_TIMEOUT_MS = 30_000;
