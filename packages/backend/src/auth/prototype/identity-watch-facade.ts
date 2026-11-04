import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type Redis from 'ioredis';
import type { createPrototypeNativeFacade } from './identity-native-facade';

export const PROTOTYPE_WATCH_CODE_TTL_SECONDS = 300;
export const PROTOTYPE_WATCH_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_CODE_ALLOCATION_ATTEMPTS = 5;

export class PrototypeWatchPairingError extends Error {
  constructor(readonly status: 400 | 401 | 503) {
    super(status === 503 ? 'Watch pairing temporarily unavailable' : 'Invalid or expired pairing code');
    this.name = 'PrototypeWatchPairingError';
  }
}

const pairingBindingSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

type NativeFacade = ReturnType<typeof createPrototypeNativeFacade>;
type PairingRedis = Pick<Redis, 'status' | 'set' | 'getdel'>;

function generateCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index++) {
    code += PROTOTYPE_WATCH_CODE_ALPHABET[randomInt(PROTOTYPE_WATCH_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Disposable Garmin protocol proof. Redis GETDEL proves a short-code binding;
 * the existing native facade rechecks canonical session ownership/revocation
 * under the shared lifecycle fence before issuing the unchanged token shape.
 * No production router or production Redis prefix uses this implementation.
 */
export function createPrototypeWatchFacade(
  nativeFacade: NativeFacade,
  redis: PairingRedis,
  namespace: string,
  codeGenerator: () => string = generateCode,
) {
  if (!/^boardsesh:ba01:watch:[a-zA-Z0-9:-]+:$/.test(namespace)) {
    throw new Error('Watch proof requires an explicit isolated BA-01 Redis namespace');
  }

  function ensureRedisReady() {
    if (redis.status !== 'ready') throw new PrototypeWatchPairingError(503);
  }

  async function createPairingCode(accessToken: string): Promise<{ code: string; expiresAt: string }> {
    const authenticated = await nativeFacade.validateAccessToken(accessToken);
    if (!authenticated) throw new PrototypeWatchPairingError(401);
    ensureRedisReady();
    const binding = JSON.stringify({ version: 1, ...authenticated });
    for (let attempt = 0; attempt < MAX_CODE_ALLOCATION_ATTEMPTS; attempt++) {
      const code = codeGenerator();
      if (
        code.length !== CODE_LENGTH ||
        code.split('').some((character) => !PROTOTYPE_WATCH_CODE_ALPHABET.includes(character))
      ) {
        throw new Error('Watch proof generator returned an invalid pairing code');
      }
      const stored = await redis.set(`${namespace}${code}`, binding, 'EX', PROTOTYPE_WATCH_CODE_TTL_SECONDS, 'NX');
      if (stored === 'OK')
        return { code, expiresAt: new Date(Date.now() + PROTOTYPE_WATCH_CODE_TTL_SECONDS * 1000).toISOString() };
    }
    throw new PrototypeWatchPairingError(503);
  }

  async function consumePairingCode(code: unknown) {
    if (typeof code !== 'string' || code.length === 0) throw new PrototypeWatchPairingError(400);
    const normalized = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (normalized.length !== CODE_LENGTH) throw new PrototypeWatchPairingError(400);
    ensureRedisReady();
    const consumed = await redis.getdel(`${namespace}${normalized}`);
    if (!consumed) throw new PrototypeWatchPairingError(401);
    let parsed: unknown;
    try {
      parsed = JSON.parse(consumed);
    } catch {
      throw new PrototypeWatchPairingError(401);
    }
    const binding = pairingBindingSchema.safeParse(parsed);
    if (!binding.success) throw new PrototypeWatchPairingError(401);
    return nativeFacade.issueForVerifiedSession(binding.data.userId, binding.data.sessionId);
  }

  return { createPairingCode, consumePairingCode };
}
