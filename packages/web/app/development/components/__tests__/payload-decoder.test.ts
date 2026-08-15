import { describe, it, expect } from 'vite-plus/test';

// The web re-export shims went with the deleted LED control stack (W-16); the
// encoders themselves live in the shared package the ESP32 rig still decodes
// against, so this round-trip imports them directly.
import { getAuroraBluetoothPacket } from '@boardsesh/ble-protocol/aurora';
import { getMoonboardBluetoothPacket } from '@boardsesh/ble-protocol/moonboard';
import { splitMessages } from '@boardsesh/ble-protocol/transport';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';

import { decodeOnce, PayloadDecoder } from '../payload-decoder';

const KILTER_LAYOUT = 1;
const KILTER_SIZE = 10;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return out;
}

describe('PayloadDecoder — Aurora v3 single frame', () => {
  it('round-trips a small Kilter climb back to the original frames string', () => {
    const placements = getLedPlacements('kilter', KILTER_LAYOUT, KILTER_SIZE);
    const frames = 'p1379r44p1395r44p1447r45p1464r45';
    const { packet } = getAuroraBluetoothPacket(frames, placements, 'kilter', 3);
    expect(packet.length).toBeGreaterThan(0);

    const decoded = decodeOnce(packet, { board: 'kilter', layoutId: KILTER_LAYOUT, sizeId: KILTER_SIZE });
    expect(decoded).not.toBeNull();
    expect(decoded!.board).toBe('kilter');
    if (decoded!.board === 'moonboard') throw new Error('expected aurora frame');
    expect(decoded!.apiLevel).toBe(3);
    expect(decoded!.framesString).toBe(frames);
  });

  it('accepts the validated 12x12 captured payload and recovers the source frames', () => {
    // Same fixture used in bluetooth-packet.test.ts — keeps the decoder
    // honest against bytes from the real Aurora app, not just our encoder.
    const captured = fromHex('010dbb02544400e3dc01e30000f42100f403');
    const decoded = decodeOnce(captured, { board: 'kilter', layoutId: KILTER_LAYOUT, sizeId: KILTER_SIZE });
    if (!decoded || decoded.board === 'moonboard') throw new Error('expected aurora frame');
    expect(decoded.framesString).toBe('p1379r44p1395r44p1447r45p1464r45');
  });
});

describe('PayloadDecoder — Aurora v3 multi-frame', () => {
  it('reassembles 200 LEDs split across R/Q/S frames into one decoded snapshot', () => {
    // Build a synthetic placement map that directly maps placementIds 0..199
    // to LED positions 0..199 — keeps the test focused on multi-frame
    // accumulation, not on real-board geometry.
    const placements: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 200; i++) {
      placements[i] = i;
      frames += `p${i}r42`;
    }
    const { packet } = getAuroraBluetoothPacket(frames, placements, 'kilter', 3);
    // Sanity: the encoder should have produced multiple framed messages.
    expect(packet.length).toBeGreaterThan(254);

    // Feed in 20-byte BLE-sized chunks the way a real phone would write.
    const decoder = new PayloadDecoder({ board: 'kilter', layoutId: KILTER_LAYOUT, sizeId: KILTER_SIZE });
    // Use a placement map override: monkey-patch reverse lookup by passing a
    // matching layout/size — for this synthetic test we instead just assert
    // the LED positions we recovered match what we sent.
    let collected: ReturnType<typeof decoder.push> = [];
    for (const chunk of splitMessages(packet)) {
      const out = decoder.push(chunk);
      if (out.length > 0) collected = out;
    }
    expect(collected).toHaveLength(1);
    const result = collected[0];
    if (result.board === 'moonboard') throw new Error('expected aurora frame');
    expect(result.leds).toHaveLength(200);
    const positions = result.leds.map((l) => l.position).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });
});

describe('PayloadDecoder — Aurora v2', () => {
  it('round-trips a Tension v2 climb (with v2 power scaling)', () => {
    // Use a small synthetic placement map so the v2 power scale stays at 1.0.
    const placements: Record<number, number> = { 1: 10, 2: 256, 3: 500 };
    const frames = 'p1r1p2r1p3r1';
    const { packet } = getAuroraBluetoothPacket(frames, placements, 'tension', 2);

    const decoder = new PayloadDecoder({ board: 'tension', layoutId: 0, sizeId: 0 });
    const out = decoder.push(packet);
    expect(out).toHaveLength(1);
    if (out[0].board === 'moonboard') throw new Error('expected aurora frame');
    expect(out[0].apiLevel).toBe(2);
    expect(out[0].leds.map((l) => l.position).sort((a, b) => a - b)).toEqual([10, 256, 500]);
  });
});

describe('PayloadDecoder — MoonBoard ASCII', () => {
  it('decodes a single-shot MoonBoard payload back to the original frames', () => {
    const frames = 'p1r42p2r43p198r44';
    const { packet } = getMoonboardBluetoothPacket(frames);
    const decoded = decodeOnce(packet, { board: 'moonboard', layoutId: 0, sizeId: 0 });
    if (!decoded || decoded.board !== 'moonboard') throw new Error('expected moonboard frame');
    // MoonBoard reverse-mapping is sort-stable on holdId, so the round-tripped
    // string should match exactly.
    expect(decoded.framesString).toBe(frames);
  });

  it('handles an empty MoonBoard payload (no holds lit)', () => {
    const packet = new TextEncoder().encode('l##');
    const decoded = decodeOnce(packet, { board: 'moonboard', layoutId: 0, sizeId: 0 });
    if (!decoded || decoded.board !== 'moonboard') throw new Error('expected moonboard frame');
    expect(decoded.leds).toHaveLength(0);
    expect(decoded.framesString).toBe('');
  });

  it('reassembles MoonBoard payloads split across multiple BLE writes', () => {
    // The phone splits any payload > 20 bytes into 20-byte BLE chunks via
    // splitMessages, including MoonBoard. A climb with several holds easily
    // exceeds that. Drive a payload through the decoder one BLE-sized slice
    // at a time and assert we get exactly one frame at the end.
    const frames = 'p1r42p2r43p10r43p20r43p50r43p100r43p150r43p198r44';
    const { packet } = getMoonboardBluetoothPacket(frames);
    expect(packet.length).toBeGreaterThan(20);

    const decoder = new PayloadDecoder({ board: 'moonboard', layoutId: 0, sizeId: 0 });
    let collected: ReturnType<typeof decoder.push> = [];
    for (const chunk of splitMessages(packet)) {
      const out = decoder.push(chunk);
      if (out.length > 0) collected = collected.concat(out);
    }
    expect(collected).toHaveLength(1);
    if (collected[0].board !== 'moonboard') throw new Error('expected moonboard frame');
    expect(collected[0].framesString).toBe(frames);
  });
});

describe('PayloadDecoder — resilience', () => {
  it('drops noise bytes before SOH instead of breaking the stream', () => {
    const placements = getLedPlacements('kilter', KILTER_LAYOUT, KILTER_SIZE);
    const frames = 'p1379r44';
    const { packet } = getAuroraBluetoothPacket(frames, placements, 'kilter', 3);

    const noisy = new Uint8Array([0xff, 0xfe, ...packet]);
    const decoder = new PayloadDecoder({ board: 'kilter', layoutId: KILTER_LAYOUT, sizeId: KILTER_SIZE });
    const out = decoder.push(noisy);
    expect(out).toHaveLength(1);
    if (out[0].board === 'moonboard') throw new Error('expected aurora frame');
    expect(out[0].framesString).toBe(frames);
  });

  it('does not emit until a partial frame is completed by a follow-up chunk', () => {
    const placements = getLedPlacements('kilter', KILTER_LAYOUT, KILTER_SIZE);
    const frames = 'p1379r44p1395r44';
    const { packet } = getAuroraBluetoothPacket(frames, placements, 'kilter', 3);
    const decoder = new PayloadDecoder({ board: 'kilter', layoutId: KILTER_LAYOUT, sizeId: KILTER_SIZE });
    // Cut the packet roughly in half — no frame should emit yet.
    const half = Math.floor(packet.length / 2);
    expect(decoder.push(packet.subarray(0, half))).toHaveLength(0);
    const rest = decoder.push(packet.subarray(half));
    expect(rest).toHaveLength(1);
    if (rest[0].board === 'moonboard') throw new Error('expected aurora frame');
    expect(rest[0].framesString).toBe(frames);
  });
});
