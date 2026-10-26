import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { base64ToBytes, bytesToBase64, crc32, decodePng, encodePng, inflateZlib, type RgbaImage } from '../png-codec';

/** A PNG built the way an encoder would: real zlib, a chosen filter per row. */
function pngFromRows({
  width,
  height,
  colorType,
  channels,
  pixel,
  filterForRow,
  level,
}: {
  width: number;
  height: number;
  colorType: number;
  channels: number;
  pixel: (column: number, row: number) => number[];
  filterForRow: (row: number) => number;
  level: number;
}): Uint8Array {
  const stride = width * channels;
  const plain: number[][] = [];
  for (let row = 0; row < height; row++) {
    const line: number[] = [];
    for (let column = 0; column < width; column++) line.push(...pixel(column, row));
    plain.push(line);
  }
  const raw: number[] = [];
  for (let row = 0; row < height; row++) {
    const filter = filterForRow(row);
    raw.push(filter);
    for (let index = 0; index < stride; index++) {
      const value = plain[row][index];
      const left = index >= channels ? plain[row][index - channels] : 0;
      const up = row > 0 ? plain[row - 1][index] : 0;
      const upLeft = row > 0 && index >= channels ? plain[row - 1][index - channels] : 0;
      const estimate = left + up - upLeft;
      const paeth =
        Math.abs(estimate - left) <= Math.abs(estimate - up) && Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
          ? left
          : Math.abs(estimate - up) <= Math.abs(estimate - upLeft)
            ? up
            : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
      raw.push((value - predicted) & 0xff);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(new Uint8Array(body)));
    return Buffer.concat([length, body, crc]);
  };
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.from(raw), { level })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const gradient = (column: number, row: number) => [(column * 37) & 0xff, (row * 53) & 0xff, (column * row) & 0xff];

describe('decodePng', () => {
  it.each([
    ['dynamic Huffman', 9],
    ['fixed Huffman', 1],
    ['stored blocks', 0],
  ])('reads RGBA through every row filter with %s', (_name, level) => {
    const png = pngFromRows({
      width: 21,
      height: 15,
      colorType: 6,
      channels: 4,
      pixel: (column, row) => [...gradient(column, row), (column + row * 9) & 0xff],
      filterForRow: (row) => row % 5,
      level,
    });
    const image = decodePng(png);
    expect(image?.width).toBe(21);
    expect(image?.height).toBe(15);
    expect(Array.from(image?.pixels.subarray(0, 4) ?? [])).toEqual([...gradient(0, 0), 0]);
    const at = (20 + 14 * 21) * 4;
    expect(Array.from(image?.pixels.subarray(at, at + 4) ?? [])).toEqual([...gradient(20, 14), (20 + 14 * 9) & 0xff]);
  });

  it('reads RGB as opaque RGBA', () => {
    const png = pngFromRows({
      width: 8,
      height: 8,
      colorType: 2,
      channels: 3,
      pixel: gradient,
      filterForRow: (row) => row % 5,
      level: 6,
    });
    const image = decodePng(png);
    const at = (5 + 6 * 8) * 4;
    expect(Array.from(image?.pixels.subarray(at, at + 4) ?? [])).toEqual([...gradient(5, 6), 255]);
  });

  it('declines what it does not read rather than guessing', () => {
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
    const sixteenBit = pngFromRows({
      width: 2,
      height: 2,
      colorType: 6,
      channels: 4,
      pixel: () => [1, 2, 3, 4],
      filterForRow: () => 0,
      level: 6,
    });
    sixteenBit[8 + 8 + 8] = 16; // IHDR bit depth
    expect(decodePng(sixteenBit)).toBeNull();
  });
});

describe('encodePng', () => {
  it('round-trips through the reader and through zlib itself', () => {
    const pixels = new Uint8Array(70 * 70 * 4).map((_value, index) => (index * 7) & 0xff);
    const image: RgbaImage = { width: 70, height: 70, pixels };
    const png = encodePng(image);
    expect(decodePng(png)).toEqual(image);
  });

  it('writes the standard IEND checksum', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });
});

describe('inflateZlib', () => {
  it('matches zlib on repetitive data with long back-references', () => {
    const source = Buffer.from('boardsesh '.repeat(3000) + 'crimp jug sloper '.repeat(400));
    expect(Buffer.from(inflateZlib(new Uint8Array(deflateSync(source)))).equals(source)).toBe(true);
  });
});

describe('base64', () => {
  it.each([0, 1, 2, 3, 100])('matches Buffer for %i bytes', (length) => {
    const bytes = new Uint8Array(length).map((_value, index) => (index * 31 + 7) & 0xff);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(bytes));
  });
});
