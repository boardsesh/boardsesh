import {
  DEVICE_TOKEN_SECRET_ENV,
  mintDeviceToken,
  readDeviceTokenSecret,
  verifyDeviceToken,
  type DeviceTokenClaims,
} from '@boardsesh/auth-protocol/device-token';
import { logger } from '../utils/logger';

type Environment = Readonly<Record<string, string | undefined>>;

let invalidSecretLogged = false;

export function __resetDeviceTokenStateForTests(): void {
  invalidSecretLogged = false;
}

function secretOrNull(environment: Environment): string | null {
  const read = readDeviceTokenSecret(environment);
  if ('secret' in read) return read.secret;
  if (read.problem === 'invalid' && !invalidSecretLogged) {
    invalidSecretLogged = true;
    // Names the variable, never its value.
    logger.error(`Device tokens off: ${DEVICE_TOKEN_SECRET_ENV} is too short, padded or reused`);
  }
  return null;
}

/**
 * A fresh device token for a successful native sign-in, or undefined when
 * device tokens are off (#7656). Never throws: a sign-in that succeeded is
 * never failed by its token.
 */
export async function mintNativeDeviceToken(
  userId: string,
  environment: Environment = process.env,
): Promise<string | undefined> {
  try {
    const secret = secretOrNull(environment);
    if (secret === null) return undefined;
    return (await mintDeviceToken({ userId, secret })).token;
  } catch {
    logger.warn('[DeviceToken] Mint skipped', { code: 'DEVICE_TOKEN_MINT_FAILED' });
    return undefined;
  }
}

/**
 * The reply with an additive `deviceToken` for its `userId` when device tokens
 * are on, otherwise the reply unchanged. Released apps and watches ignore
 * fields they do not know.
 */
export async function withNativeDeviceToken<Reply extends { readonly userId: string }>(
  reply: Reply,
  environment: Environment = process.env,
): Promise<Reply & { deviceToken?: string }> {
  const deviceToken = await mintNativeDeviceToken(reply.userId, environment);
  return deviceToken === undefined ? reply : { ...reply, deviceToken };
}

/**
 * The claims of a token a client presented for `userId`, or null when it is
 * absent, forged, expired, minted for another account, or tokens are off.
 * The password guess limit calls it before a compare (`password-guess-limit.ts`). A
 * verified token charges the account's shared device bucket
 * (`passwordGuessAccountSubject(userId)`), never one keyed on its token id:
 * refresh and exchange mint a new id on every reply.
 */
export async function verifyPresentedDeviceToken(
  token: unknown,
  userId: string,
  environment: Environment = process.env,
): Promise<DeviceTokenClaims | null> {
  const secret = secretOrNull(environment);
  if (secret === null) return null;
  return verifyDeviceToken(token, { userId, secret });
}
