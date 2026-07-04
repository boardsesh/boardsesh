/**
 * Parse a board config's comma-separated `setIds` string into the number[] that
 * `getBoardRenderData` / `getBoardAspectRatio` expect.
 *
 * Empty tokens are dropped BEFORE `Number()` on purpose: `Number('')` is `0` (a
 * finite value), so an empty or trailing-comma string would otherwise yield a
 * bogus `[0]` and slip past a `length === 0` guard, calling the render helpers
 * with an invalid set. Trimming + dropping empties makes `''` → `[]` so callers
 * fall back cleanly. Set ids are positive integers, so `'0'`/`'-3'`/`'1.5'` are
 * dropped too — in lockstep with the sibling parsers in `DeviceCard` and
 * `bluetooth-provider`. Pure, so it unit-tests without react-native.
 */
export function parseSetIds(setIds: string): number[] {
  return setIds
    .split(',')
    .map((setIdText) => setIdText.trim())
    .filter((setIdText) => setIdText.length > 0)
    .map((setIdText) => Number(setIdText))
    .filter((setIdValue) => Number.isInteger(setIdValue) && setIdValue > 0);
}
