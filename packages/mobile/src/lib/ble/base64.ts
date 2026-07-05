// react-native-ble-plx writes take base64 strings, not byte arrays. This is the
// one place that conversion lives so the board adapter and the Rogue-timer
// controller encode frames identically.
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
    binary += String.fromCharCode(bytes[byteIndex]);
  }
  return btoa(binary);
}
