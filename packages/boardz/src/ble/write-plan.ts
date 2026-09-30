import { INTER_CHUNK_DELAY_MS, MAX_BLUETOOTH_MESSAGE_SIZE, effectiveChunkSizeForMtu } from '@boardsesh/ble-protocol';
import { isKilterBuiltBox } from '@boardsesh/ble-protocol/aurora';
import type { BoardFamily } from './device-filter';

// A Kilter-built box gets 100 ms between acknowledged chunks, like its own app
// (kilterBoxChunkDelay in Boardsesh's BoardBleManager.swift).
const KILTER_BOX_CHUNK_DELAY_MS = 100;

export type WritePlan = {
  withoutResponse: boolean;
  /** Bytes per GATT write. */
  chunkSize: number;
  /** Pause between chunks, on top of any acknowledgement. */
  chunkDelayMs: number;
};

/**
 * How to send a packet to one controller. Follows Boardsesh's native iOS path,
 * the one its iPhone app drives boards with (BoardBleEncoding.effectiveChunkSize
 * and BoardBleManager's pacing): acknowledged writes always go 20 bytes at a
 * time, and only unacknowledged Aurora writes grow with the negotiated MTU.
 */
export function writePlan(input: {
  family: BoardFamily;
  deviceName: string | null;
  /** The negotiated ATT MTU. */
  mtu: number;
  /** What the write characteristic advertises, when ble-plx knows. */
  writableWithoutResponse: boolean | undefined;
}): WritePlan {
  if (input.family === 'woods') {
    // The Woods controller rebuilds the message from 20-byte chunks up to its
    // `,!` terminator, and its spec (§8) wants every chunk acknowledged, whatever
    // the characteristic advertises. Same as Boardsesh's native writer.
    return { withoutResponse: false, chunkSize: MAX_BLUETOOTH_MESSAGE_SIZE, chunkDelayMs: INTER_CHUNK_DELAY_MS };
  }
  if (input.family === 'moonboard') {
    // Newer (Nordic UART) boxes take unacknowledged writes; the original
    // RedBearLab box only advertises acknowledged ones.
    return {
      withoutResponse: input.writableWithoutResponse ?? true,
      chunkSize: MAX_BLUETOOTH_MESSAGE_SIZE,
      chunkDelayMs: INTER_CHUNK_DELAY_MS,
    };
  }
  if (isKilterBuiltBox(input.deviceName ?? undefined)) {
    // A bare "Kilter Board" name: iOS silently drops unacknowledged writes to it.
    return {
      withoutResponse: false,
      chunkSize: MAX_BLUETOOTH_MESSAGE_SIZE,
      chunkDelayMs: KILTER_BOX_CHUNK_DELAY_MS,
    };
  }
  // Every other Aurora box takes unacknowledged writes, whatever its
  // characteristic claims: some iOS versions under-report the property.
  return {
    withoutResponse: true,
    chunkSize: effectiveChunkSizeForMtu(input.mtu),
    chunkDelayMs: INTER_CHUNK_DELAY_MS,
  };
}
