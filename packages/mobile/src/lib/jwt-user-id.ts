// Read the signed-in user id out of the JWT this device already holds.
//
// WARNING: this is an UNVERIFIED, client-side decode. It does not check the
// signature, the issuer, the audience, or the expiry — a tampered token would
// yield whatever id it claims. It exists for ONE job: classifying boards this
// device has already downloaded as "yours" vs "following" while offline, where
// the usual source (`useProfile`, a network query) cannot answer. Never feed the
// result into an authorization decision, a mutation payload, or anything the
// server trusts — the backend does its own `jwtVerify` on every request and that
// remains the only real answer to "who is this?".
//
// The claim itself is the same id: the backend signs `SignJWT({ sub: userId })`
// (packages/backend/src/handlers/native-auth.ts) with the id that later gets
// compared against `board.ownerId`.

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64url → bytes. Hand-rolled rather than `atob` because the JWT alphabet
 * uses `-`/`_` and drops padding, and because Hermes' `atob` availability
 * varies by runtime. Returns undefined for anything it can't decode.
 */
function base64UrlToBytes(segment: string): Uint8Array | undefined {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const bytes: number[] = [];
  let accumulator = 0;
  let bitsHeld = 0;
  for (const character of normalized) {
    if (character === '=') break;
    const sextet = BASE64_ALPHABET.indexOf(character);
    if (sextet === -1) return undefined;
    accumulator = (accumulator << 6) | sextet;
    bitsHeld += 6;
    if (bitsHeld >= 8) {
      bitsHeld -= 8;
      bytes.push((accumulator >> bitsHeld) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * bytes → string, decoding UTF-8 by hand. Hermes ships `TextDecoder`, but this
 * module also runs under the web build and under Vitest's jsdom, and a decoder
 * that throws on a malformed sequence would defeat the never-throw contract
 * above. 25 lines buys "works everywhere, fails soft".
 */
function utf8Decode(bytes: Uint8Array): string {
  let decoded = '';
  let index = 0;
  while (index < bytes.length) {
    const leadByte = bytes[index];
    let codePoint: number;
    let continuationCount: number;
    if (leadByte < 0x80) {
      codePoint = leadByte;
      continuationCount = 0;
    } else if ((leadByte & 0xe0) === 0xc0) {
      codePoint = leadByte & 0x1f;
      continuationCount = 1;
    } else if ((leadByte & 0xf0) === 0xe0) {
      codePoint = leadByte & 0x0f;
      continuationCount = 2;
    } else if ((leadByte & 0xf8) === 0xf0) {
      codePoint = leadByte & 0x07;
      continuationCount = 3;
    } else {
      // Not a valid lead byte — substitute rather than throw; the caller only
      // cares whether a `sub` string survives.
      decoded += '�';
      index += 1;
      continue;
    }
    for (let offset = 1; offset <= continuationCount; offset += 1) {
      const continuationByte = bytes[index + offset];
      if (continuationByte === undefined || (continuationByte & 0xc0) !== 0x80) return decoded + '�';
      codePoint = (codePoint << 6) | (continuationByte & 0x3f);
    }
    decoded += String.fromCodePoint(codePoint);
    index += continuationCount + 1;
  }
  return decoded;
}

/**
 * The `sub` claim of a JWT, or undefined when the token is absent, malformed, or
 * carries no usable subject. Never throws — hostile or truncated input just
 * reads as "no id", which callers already handle.
 */
export function userIdFromJwt(token: string | null | undefined): string | undefined {
  if (!token) return undefined;
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;
  try {
    const payloadBytes = base64UrlToBytes(segments[1]);
    if (!payloadBytes || payloadBytes.length === 0) return undefined;
    const payload: unknown = JSON.parse(utf8Decode(payloadBytes));
    if (typeof payload !== 'object' || payload === null) return undefined;
    const subject = (payload as { sub?: unknown }).sub;
    return typeof subject === 'string' && subject.length > 0 ? subject : undefined;
  } catch {
    return undefined;
  }
}
