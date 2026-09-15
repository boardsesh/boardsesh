/**
 * Incremental SHA-256, so a 31 MB model file can be verified a megabyte at a
 * time (epic #5346, SW-02).
 *
 * Why not `expo-crypto`: its `digest()` is one-shot — it takes the whole
 * payload as a single `BufferSource` and there is no update/finalize pair, so
 * verifying a model means holding the entire file in memory next to whatever
 * else the download is doing. This runs in bounded memory instead: the caller
 * reads a chunk, hands it over, and drops it.
 *
 * Why not `expo-file-system`'s `md5`: MD5 is what the manifest does NOT publish,
 * and it would not be the thing to trust for "is this the file SW-01 signed"
 * even if it did.
 *
 * Plain FIPS 180-4. The test file checks it against the published vectors and
 * against a chunk-boundary sweep, because the only bug that matters here is one
 * that shows up on a particular split of the same bytes.
 */

/** First 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/** Fractional parts of the square roots of the first eight primes. */
const INITIAL_STATE = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Streaming SHA-256. Feed it `update(chunk)` as often as you like, then `digestHex()`. */
export class Sha256 {
  private readonly state = Uint32Array.from(INITIAL_STATE);
  private readonly block = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private blockLength = 0;
  /** Total message length in BITS, kept as a float — exact to 2^53, i.e. 1 PB. */
  private totalBits = 0;
  private finished = false;

  update(chunk: Uint8Array): this {
    if (this.finished) throw new Error('Sha256: update() after digest()');
    this.totalBits += chunk.length * 8;
    let offset = 0;
    // Top up a partial block first, then consume whole blocks straight out of
    // the chunk so a megabyte read costs one copy per 64 bytes, not two.
    if (this.blockLength > 0) {
      const wanted = Math.min(64 - this.blockLength, chunk.length);
      this.block.set(chunk.subarray(0, wanted), this.blockLength);
      this.blockLength += wanted;
      offset = wanted;
      if (this.blockLength === 64) {
        this.compress(this.block, 0);
        this.blockLength = 0;
      }
    }
    while (offset + 64 <= chunk.length) {
      this.compress(chunk, offset);
      offset += 64;
    }
    if (offset < chunk.length) {
      this.block.set(chunk.subarray(offset), 0);
      this.blockLength = chunk.length - offset;
    }
    return this;
  }

  digestHex(): string {
    if (!this.finished) {
      this.finished = true;
      const bits = this.totalBits;
      // 0x80, then zeroes, then the 64-bit big-endian bit length.
      this.block[this.blockLength] = 0x80;
      this.blockLength += 1;
      if (this.blockLength > 56) {
        this.block.fill(0, this.blockLength);
        this.compress(this.block, 0);
        this.blockLength = 0;
      }
      this.block.fill(0, this.blockLength, 56);
      // Split rather than BigInt: Hermes has BigInt, but the high word is at
      // most 2^21 here and a float divide says so without allocating.
      const high = Math.floor(bits / 0x100000000);
      const low = bits >>> 0;
      const view = new DataView(this.block.buffer, this.block.byteOffset, 64);
      view.setUint32(56, high, false);
      view.setUint32(60, low, false);
      this.compress(this.block, 0);
    }
    let hex = '';
    for (const word of this.state) hex += word.toString(16).padStart(8, '0');
    return hex;
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const { schedule, state } = this;
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      schedule[index] = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = schedule[index - 15];
      const recent = schedule[index - 2];
      const s0 = (rotr(previous, 7) ^ rotr(previous, 18) ^ (previous >>> 3)) >>> 0;
      const s1 = (rotr(recent, 17) ^ rotr(recent, 19) ^ (recent >>> 10)) >>> 0;
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const choose = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + sigma1 + choose + K[index] + schedule[index]) >>> 0;
      const sigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
}

/** One-shot convenience for small payloads (a manifest, a test vector). */
export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).digestHex();
}
