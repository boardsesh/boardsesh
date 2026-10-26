// A small PNG reader and writer in plain TypeScript, for the round avatar
// (`round-avatar.ts`). UIKit draws a bar item's image as it is, so the photo
// must already carry a round alpha mask, and no installed module can draw one
// without native code. The reader takes what UIKit's `pngData()` writes:
// 8-bit grey, grey+alpha, RGB or RGBA, not interlaced. The writer stores the
// pixels uncompressed (zlib "stored" blocks): an 84px avatar is about 28KB.

/** Straight (not premultiplied) RGBA, 4 bytes a pixel, rows top to bottom. */
export type RgbaImage = { width: number; height: number; pixels: Uint8Array };

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS_BY_COLOR_TYPE: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

// ── Base64 ──────────────────────────────────────────────────────────────────

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const lookup = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index++) lookup[BASE64_ALPHABET.charCodeAt(index)] = index;
  return lookup;
})();

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let byteIndex = 0;
  let buffer = 0;
  let bufferedBits = 0;
  for (let charIndex = 0; charIndex < clean.length; charIndex++) {
    buffer = (buffer << 6) | BASE64_LOOKUP[clean.charCodeAt(charIndex)];
    bufferedBits += 6;
    if (bufferedBits >= 8) {
      bufferedBits -= 8;
      bytes[byteIndex++] = (buffer >> bufferedBits) & 0xff;
    }
  }
  return bytes.subarray(0, byteIndex);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const triple = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    output +=
      BASE64_ALPHABET[(triple >> 18) & 63] +
      BASE64_ALPHABET[(triple >> 12) & 63] +
      BASE64_ALPHABET[(triple >> 6) & 63] +
      BASE64_ALPHABET[triple & 63];
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const single = bytes[index] << 16;
    output += `${BASE64_ALPHABET[(single >> 18) & 63]}${BASE64_ALPHABET[(single >> 12) & 63]}==`;
  } else if (remaining === 2) {
    const double = (bytes[index] << 16) | (bytes[index + 1] << 8);
    output += `${BASE64_ALPHABET[(double >> 18) & 63]}${BASE64_ALPHABET[(double >> 12) & 63]}${BASE64_ALPHABET[(double >> 6) & 63]}=`;
  }
  return output;
}

// ── Checksums ───────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let entry = 0; entry < 256; entry++) {
    let crc = entry;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[entry] = crc >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let low = 1;
  let high = 0;
  for (const byte of bytes) {
    low = (low + byte) % 65521;
    high = (high + low) % 65521;
  }
  return ((high << 16) | low) >>> 0;
}

// ── Inflate (RFC 1951), after zlib's puff.c ─────────────────────────────────

const MAX_CODE_BITS = 15;
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

type Huffman = { counts: Uint16Array; symbols: Uint16Array };

function buildHuffman(lengths: ArrayLike<number>, symbolCount: number): Huffman {
  const counts = new Uint16Array(MAX_CODE_BITS + 1);
  for (let symbol = 0; symbol < symbolCount; symbol++) counts[lengths[symbol]]++;
  const offsets = new Uint16Array(MAX_CODE_BITS + 1);
  for (let length = 1; length < MAX_CODE_BITS; length++) offsets[length + 1] = offsets[length] + counts[length];
  const symbols = new Uint16Array(symbolCount);
  for (let symbol = 0; symbol < symbolCount; symbol++) {
    if (lengths[symbol] !== 0) symbols[offsets[lengths[symbol]]++] = symbol;
  }
  return { counts, symbols };
}

const FIXED_TABLES = (() => {
  const lengths = new Uint8Array(288 + 30);
  for (let symbol = 0; symbol < 144; symbol++) lengths[symbol] = 8;
  for (let symbol = 144; symbol < 256; symbol++) lengths[symbol] = 9;
  for (let symbol = 256; symbol < 280; symbol++) lengths[symbol] = 7;
  for (let symbol = 280; symbol < 288; symbol++) lengths[symbol] = 8;
  for (let symbol = 288; symbol < 318; symbol++) lengths[symbol] = 5;
  return { literals: buildHuffman(lengths, 288), distances: buildHuffman(lengths.subarray(288), 30) };
})();

class InflateState {
  private inputIndex = 0;
  private bitBuffer = 0;
  private bitCount = 0;
  output: Uint8Array;
  outputLength = 0;

  constructor(
    private readonly input: Uint8Array,
    expectedSize: number,
  ) {
    this.output = new Uint8Array(Math.max(expectedSize, 1024));
  }

  bits(need: number): number {
    let value = this.bitBuffer;
    while (this.bitCount < need) {
      if (this.inputIndex >= this.input.length) throw new Error('inflate: input ran out');
      value |= this.input[this.inputIndex++] << this.bitCount;
      this.bitCount += 8;
    }
    this.bitBuffer = value >>> need;
    this.bitCount -= need;
    return value & ((1 << need) - 1);
  }

  emit(byte: number): void {
    if (this.outputLength === this.output.length) {
      const grown = new Uint8Array(this.output.length * 2);
      grown.set(this.output);
      this.output = grown;
    }
    this.output[this.outputLength++] = byte;
  }

  stored(): void {
    this.bitBuffer = 0;
    this.bitCount = 0;
    if (this.inputIndex + 4 > this.input.length) throw new Error('inflate: stored header ran out');
    const length = this.input[this.inputIndex] | (this.input[this.inputIndex + 1] << 8);
    const complement = this.input[this.inputIndex + 2] | (this.input[this.inputIndex + 3] << 8);
    if (length !== (~complement & 0xffff)) throw new Error('inflate: stored length mismatch');
    this.inputIndex += 4;
    if (this.inputIndex + length > this.input.length) throw new Error('inflate: stored block ran out');
    for (let index = 0; index < length; index++) this.emit(this.input[this.inputIndex++]);
  }

  decode(huffman: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= MAX_CODE_BITS; length++) {
      code |= this.bits(1);
      const count = huffman.counts[length];
      if (code - count < first) return huffman.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('inflate: bad code');
  }

  codes(literals: Huffman, distances: Huffman): void {
    for (;;) {
      let symbol = this.decode(literals);
      if (symbol < 256) {
        this.emit(symbol);
        continue;
      }
      if (symbol === 256) return;
      symbol -= 257;
      if (symbol >= 29) throw new Error('inflate: bad length');
      const length = LENGTH_BASE[symbol] + this.bits(LENGTH_EXTRA[symbol]);
      const distanceSymbol = this.decode(distances);
      if (distanceSymbol >= 30) throw new Error('inflate: bad distance');
      const distance = DISTANCE_BASE[distanceSymbol] + this.bits(DISTANCE_EXTRA[distanceSymbol]);
      if (distance > this.outputLength) throw new Error('inflate: distance too far back');
      for (let copied = 0; copied < length; copied++) this.emit(this.output[this.outputLength - distance]);
    }
  }

  dynamic(): void {
    const literalCount = this.bits(5) + 257;
    const distanceCount = this.bits(5) + 1;
    const codeLengthCount = this.bits(4) + 4;
    if (literalCount > 286 || distanceCount > 30) throw new Error('inflate: bad counts');
    const lengths = new Uint8Array(320);
    for (let index = 0; index < codeLengthCount; index++) lengths[CODE_LENGTH_ORDER[index]] = this.bits(3);
    const lengthCode = buildHuffman(lengths, 19);
    lengths.fill(0);
    let index = 0;
    while (index < literalCount + distanceCount) {
      let symbol = this.decode(lengthCode);
      if (symbol < 16) {
        lengths[index++] = symbol;
        continue;
      }
      let repeated = 0;
      if (symbol === 16) {
        if (index === 0) throw new Error('inflate: repeat with no length');
        repeated = lengths[index - 1];
        symbol = 3 + this.bits(2);
      } else if (symbol === 17) {
        symbol = 3 + this.bits(3);
      } else {
        symbol = 11 + this.bits(7);
      }
      if (index + symbol > literalCount + distanceCount) throw new Error('inflate: too many lengths');
      while (symbol-- > 0) lengths[index++] = repeated;
    }
    const literals = buildHuffman(lengths, literalCount);
    const distances = buildHuffman(lengths.subarray(literalCount), distanceCount);
    this.codes(literals, distances);
  }
}

/** Inflates a zlib stream (RFC 1950). `expectedSize` only presizes the output. */
export function inflateZlib(data: Uint8Array, expectedSize = 0): Uint8Array {
  if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) {
    throw new Error('inflate: not a zlib stream');
  }
  if (data[1] & 0x20) throw new Error('inflate: preset dictionary');
  const state = new InflateState(data.subarray(2), expectedSize);
  let last = 0;
  while (!last) {
    last = state.bits(1);
    const type = state.bits(2);
    if (type === 0) state.stored();
    else if (type === 1) state.codes(FIXED_TABLES.literals, FIXED_TABLES.distances);
    else if (type === 2) state.dynamic();
    else throw new Error('inflate: bad block type');
  }
  return state.output.subarray(0, state.outputLength);
}

// ── PNG ─────────────────────────────────────────────────────────────────────

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Decodes an 8-bit, non-interlaced PNG to RGBA, or `null` for anything else. */
export function decodePng(bytes: Uint8Array): RgbaImage | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idatParts: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      channels = CHANNELS_BY_COLOR_TYPE[colorType] ?? 0;
      if (bitDepth !== 8 || channels === 0 || interlace !== 0 || width === 0 || height === 0) return null;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (channels === 0 || idatParts.length === 0) return null;

  const compressed = new Uint8Array(idatParts.reduce((total, part) => total + part.length, 0));
  let written = 0;
  for (const part of idatParts) {
    compressed.set(part, written);
    written += part.length;
  }
  const stride = width * channels;
  let raw: Uint8Array;
  try {
    raw = inflateZlib(compressed, (stride + 1) * height);
  } catch {
    return null;
  }
  if (raw.length < (stride + 1) * height) return null;

  const unfiltered = new Uint8Array(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    for (let column = 0; column < stride; column++) {
      const value = raw[source + column];
      const left = column >= channels ? unfiltered[target + column - channels] : 0;
      const up = row > 0 ? unfiltered[target - stride + column] : 0;
      const upLeft = row > 0 && column >= channels ? unfiltered[target - stride + column - channels] : 0;
      let predicted: number;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else return null;
      unfiltered[target + column] = (value + predicted) & 0xff;
    }
  }

  const pixels = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (channels <= 2) {
      const grey = unfiltered[source];
      pixels[target] = grey;
      pixels[target + 1] = grey;
      pixels[target + 2] = grey;
      pixels[target + 3] = channels === 2 ? unfiltered[source + 1] : 255;
    } else {
      pixels[target] = unfiltered[source];
      pixels[target + 1] = unfiltered[source + 1];
      pixels[target + 2] = unfiltered[source + 2];
      pixels[target + 3] = channels === 4 ? unfiltered[source + 3] : 255;
    }
  }
  return { width, height, pixels };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) bytes[4 + index] = type.charCodeAt(index);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
  return bytes;
}

const STORED_BLOCK_MAX = 65535;

/** Encodes RGBA as a PNG whose pixels are stored uncompressed. */
export function encodePng({ width, height, pixels }: RgbaImage): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const blockCount = Math.max(1, Math.ceil(raw.length / STORED_BLOCK_MAX));
  const zlib = new Uint8Array(2 + raw.length + blockCount * 5 + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let offset = 2;
  for (let block = 0; block < blockCount; block++) {
    const start = block * STORED_BLOCK_MAX;
    const length = Math.min(STORED_BLOCK_MAX, raw.length - start);
    zlib[offset++] = block === blockCount - 1 ? 1 : 0;
    zlib[offset++] = length & 0xff;
    zlib[offset++] = (length >> 8) & 0xff;
    zlib[offset++] = ~length & 0xff;
    zlib[offset++] = (~length >> 8) & 0xff;
    zlib.set(raw.subarray(start, start + length), offset);
    offset += length;
  }
  new DataView(zlib.buffer).setUint32(offset, adler32(raw));

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const parts = [
    new Uint8Array(PNG_SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', zlib),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let written = 0;
  for (const part of parts) {
    png.set(part, written);
    written += part.length;
  }
  return png;
}
