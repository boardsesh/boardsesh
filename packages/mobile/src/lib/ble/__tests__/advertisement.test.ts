import { describe, it, expect } from 'vitest';
import { base64ToHex, serviceDataToHex } from '../base64';
import { manufacturerCompanyId, parseSerialFromAdvertisement } from '../advertisement';

describe('base64ToHex', () => {
  it('decodes base64 advertisement bytes to lowercase hex', () => {
    // bytes [0x4c, 0x00, 0x02, 0x15] → "4c000215"
    expect(base64ToHex('TAACFQ==')).toBe('4c000215');
  });

  it('returns undefined for null/undefined/empty/undecodable input', () => {
    expect(base64ToHex(undefined)).toBeUndefined();
    expect(base64ToHex(null)).toBeUndefined();
    expect(base64ToHex('')).toBeUndefined();
  });
});

describe('serviceDataToHex', () => {
  it('maps each uuid value from base64 to hex', () => {
    expect(serviceDataToHex({ 'd9b1fad4-0d22-4d20-8521-04166b28cd24': 'AQI=' })).toEqual({
      'd9b1fad4-0d22-4d20-8521-04166b28cd24': '0102',
    });
  });

  it('drops empty/undecodable entries and returns undefined when nothing remains', () => {
    expect(serviceDataToHex(null)).toBeUndefined();
    expect(serviceDataToHex(undefined)).toBeUndefined();
    expect(serviceDataToHex({ 'some-uuid': '' })).toBeUndefined();
  });
});

describe('manufacturerCompanyId', () => {
  it('reads the 16-bit little-endian company id from the hex payload', () => {
    // 0x004c (Apple) → low 0x4c, high 0x00
    expect(manufacturerCompanyId('4c000215')).toBe(0x004c);
    // 0x0157 → low 0x57, high 0x01
    expect(manufacturerCompanyId('5701abcd')).toBe(0x0157);
  });

  it('returns undefined when there are not two bytes to read', () => {
    expect(manufacturerCompanyId(undefined)).toBeUndefined();
    expect(manufacturerCompanyId('')).toBeUndefined();
    expect(manufacturerCompanyId('4c')).toBeUndefined();
  });
});

describe('parseSerialFromAdvertisement', () => {
  it('is an unimplemented seam that returns undefined for now', () => {
    expect(parseSerialFromAdvertisement({ manufacturerData: '4c000215' }, 'aurora')).toBeUndefined();
  });
});
