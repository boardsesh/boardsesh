import { describe, expect, it } from 'vitest';
import { writePlan } from './write-plan';

describe('writePlan', () => {
  it('sends MoonBoard UART boxes 20 unacknowledged bytes at a time', () => {
    expect(
      writePlan({ family: 'moonboard', deviceName: 'MoonBoard A', mtu: 185, writableWithoutResponse: true }),
    ).toEqual({ withoutResponse: true, chunkSize: 20, chunkDelayMs: 5 });
  });

  it('acknowledges every 20-byte write to a Woods box, whatever it advertises', () => {
    expect(writePlan({ family: 'woods', deviceName: 'Woods Board', mtu: 185, writableWithoutResponse: true })).toEqual({
      withoutResponse: false,
      chunkSize: 20,
      chunkDelayMs: 5,
    });
  });

  it('acknowledges every write to the original RedBearLab MoonBoard box', () => {
    expect(writePlan({ family: 'moonboard', deviceName: null, mtu: 23, writableWithoutResponse: false })).toEqual({
      withoutResponse: false,
      chunkSize: 20,
      chunkDelayMs: 5,
    });
  });

  it('sizes unacknowledged Aurora chunks from the MTU, capped at 244 bytes', () => {
    expect(
      writePlan({ family: 'aurora', deviceName: 'Tension Board#12345@3', mtu: 247, writableWithoutResponse: false }),
    ).toEqual({ withoutResponse: true, chunkSize: 244, chunkDelayMs: 5 });
    expect(
      writePlan({ family: 'aurora', deviceName: 'Kilter Board#751737@3', mtu: 512, writableWithoutResponse: true })
        .chunkSize,
    ).toBe(244);
    expect(
      writePlan({ family: 'aurora', deviceName: 'Kilter Board#751737@3', mtu: 23, writableWithoutResponse: true })
        .chunkSize,
    ).toBe(20);
  });

  it('paces a Kilter-built box like its own app: acknowledged, 20 bytes, 100 ms apart', () => {
    expect(
      writePlan({ family: 'aurora', deviceName: 'Kilter Board', mtu: 247, writableWithoutResponse: true }),
    ).toEqual({ withoutResponse: false, chunkSize: 20, chunkDelayMs: 100 });
  });
});
