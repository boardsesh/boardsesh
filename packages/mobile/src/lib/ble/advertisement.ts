// Pure helpers for the undocumented BLE advertisement payload we capture for
// reconnaissance (see `advertisement-recon.ts` and the `AdvertisementRecon`
// type). Kept side-effect-free so they're trivially unit-testable and reusable
// across the connect telemetry and the scan-recon paths.

import type { AdvertisementRecon, BoardScanFamily } from './types';

// BLE manufacturer data leads with a 16-bit little-endian company identifier
// (Bluetooth SIG assigned number). Decode it from the hex payload as a
// convenience dimension so PostHog can group boxes by vendor without parsing the
// raw hex. Returns undefined when there aren't 2 bytes to read.
export function manufacturerCompanyId(manufacturerDataHex?: string): number | undefined {
  if (!manufacturerDataHex || manufacturerDataHex.length < 4) return undefined;
  const low = parseInt(manufacturerDataHex.slice(0, 2), 16);
  const high = parseInt(manufacturerDataHex.slice(2, 4), 16);
  if (Number.isNaN(low) || Number.isNaN(high)) return undefined;
  return low + (high << 8);
}

// Future seam (intentionally unimplemented): recover a controller serial from the
// advertisement payload for boxes that dropped the `#serial@apiLevel` name suffix
// (newer Kilter-built boxes). We don't know the byte layout yet — the point of
// the `BLE Advertisement Recon` PostHog capture is to reveal it. Once it's known,
// implement here and wire as a fallback after `parseSerialNumber(name)`.
export function parseSerialFromAdvertisement(_recon: AdvertisementRecon, _family: BoardScanFamily): string | undefined {
  return undefined;
}
