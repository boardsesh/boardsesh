export type RssiStrength = 'strong' | 'good' | 'weak';

// CoreBluetooth reports 127 when it has no RSSI for a packet. Read as a number
// it would sort that board above every real reading.
export const RSSI_UNAVAILABLE = 127;

export function isUsableRssi(rssi: number | null | undefined): rssi is number {
  return typeof rssi === 'number' && Number.isFinite(rssi) && rssi < RSSI_UNAVAILABLE;
}

export function classifyRssiStrength(rssi: number): RssiStrength {
  if (rssi > -60) return 'strong';
  if (rssi > -80) return 'good';
  return 'weak';
}
