// Compares the installed BINARY's version against a floor, for features that
// must not reach binaries older than the one they shipped in even though the JS
// that carries them arrives on every binary by OTA.
//
// Pass `expo-application`'s `nativeApplicationVersion`: it is read from the
// compiled app (CFBundleShortVersionString / versionName), so no OTA can move
// it. `Constants.expoConfig` is whatever the running update declares instead.

/** Parse `1.2.3` into comparable parts. Non-numeric or long versions answer null. */
function parseVersion(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null;
  // No `length === 0` guard: `String.split` never returns an empty array. A
  // non-numeric segment is what the NaN check below catches.
  const parts = value.trim().split('.');
  if (parts.length > 3) return null;
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some(Number.isNaN)) return null;
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
}

/**
 * Whether `nativeVersion` is at or past `minimum`. A short version is
 * zero-padded (`2.6` is `2.6.0`). Anything unreadable, including a pre-release
 * suffix, answers false: every caller treats an unknown binary as too old.
 */
export function isNativeVersionAtLeast(nativeVersion: string | null | undefined, minimum: string): boolean {
  const version = parseVersion(nativeVersion);
  const floor = parseVersion(minimum);
  if (!version || !floor) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] > floor[index]) return true;
    if (version[index] < floor[index]) return false;
  }
  return true;
}
