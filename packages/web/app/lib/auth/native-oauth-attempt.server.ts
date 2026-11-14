import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createNativeOAuthAttemptCodec } from '@boardsesh/auth-protocol/native-oauth-attempt';
export {
  NATIVE_OAUTH_ATTEMPT_COOKIE,
  NATIVE_OAUTH_ATTEMPT_LIFETIME_MS,
  type NativeOAuthAttempt,
} from '@boardsesh/auth-protocol/native-oauth-attempt';

export const { signNativeOAuthAttempt, readNativeOAuthAttempt, nativeOAuthAttemptBinding } =
  createNativeOAuthAttemptCodec({
    encode: (text) => Buffer.from(text, 'utf8').toString('base64url'),
    decode: (encoded) => Buffer.from(encoded, 'base64url').toString('utf8'),
    hmac: (text, secret) => createHmac('sha256', secret).update(text).digest('base64url'),
    equal: (actual, expected) => {
      const actualBytes = Buffer.from(actual);
      const expectedBytes = Buffer.from(expected);
      return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
    },
    hash: (text) => createHash('sha256').update(text).digest('hex'),
  });
