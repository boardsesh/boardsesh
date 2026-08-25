/**
 * Board-family capability predicates for the BLE layer.
 *
 * Kept apart from the adapters so UI code (the Live Activity bridge) can ask
 * the question without importing anything that touches `react-native-ble-plx`
 * or the live-activity native module at import time.
 */

/**
 * True when the board can be driven from native code without going through JS.
 *
 * The Live Activity widget's Previous/Next App Intents encode and write the
 * wall packet natively from Swift (`BoardBleEncoding`), which has no Woods
 * encoder and would fall through to the Aurora one — lighting the wrong holds,
 * or nothing at all. Until the Swift side learns Woods (#3314), the
 * wall-driving widget controls must not be offered for it.
 *
 * Same reason the adapter factory keeps Woods on `RNBleAdapter` even on iOS:
 * the JS write path is the only one that can encode a Woods board today.
 *
 * Undefined (no board selected yet) answers `true`: callers that care about a
 * missing board already guard on it, and every other board keeps the native
 * path it has always had.
 */
export function supportsNativeBoardControl(boardName: string | undefined): boolean {
  return boardName !== 'woods';
}
