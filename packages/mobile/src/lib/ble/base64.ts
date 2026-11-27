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

/** Decode a react-native-ble-plx characteristic value without routing through
 * a text encoding. Quantum controller broadcasts contain arbitrary UUID and
 * CRC bytes, so every byte must survive unchanged. */
export function base64ToUint8Array(base64?: string | null): Uint8Array | undefined {
  if (!base64) return undefined;
  try {
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0) & 0xff);
  } catch {
    return undefined;
  }
}

// ble-plx surfaces advertisement manufacturer/service data as base64. Normalize
// to lowercase hex so the recon payload matches the native iOS path (which
// hex-encodes on the Swift side). Returns undefined for null/empty/undecodable
// input so callers can drop the field rather than emit an empty string.
export function base64ToHex(base64?: string | null): string | undefined {
  if (!base64) return undefined;
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return undefined;
  }
  if (binary.length === 0) return undefined;
  let hex = '';
  for (let charIndex = 0; charIndex < binary.length; charIndex++) {
    hex += (binary.charCodeAt(charIndex) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

// ble-plx `Device.serviceData` is `{ uuid: base64 } | null`. Normalize each
// value to hex, matching the native iOS recon payload. Returns undefined when
// there's nothing usable so callers omit the field.
export function serviceDataToHex(serviceData?: Record<string, string> | null): Record<string, string> | undefined {
  if (!serviceData) return undefined;
  const mapped: Record<string, string> = {};
  for (const [uuid, base64] of Object.entries(serviceData)) {
    const hex = base64ToHex(base64);
    if (hex !== undefined) mapped[uuid] = hex;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}
