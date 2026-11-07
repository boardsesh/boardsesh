import { createHash } from 'node:crypto';
import { decryptLegacyWebJwe } from '../legacy-web-jwe';

export interface NegativeWebOAuthActor {
  readonly userId: string;
  readonly lineageHash: string;
  readonly expiresAtSeconds: number;
}

export class InvalidWebOAuthActorError extends Error {
  constructor() {
    super('Invalid web OAuth actor');
  }
}

/** Negative browser binding only. Neither cookie iat nor this row grants freshness. */
export async function readNegativeWebOAuthActor(
  cookie: string | null,
  secret: string,
): Promise<NegativeWebOAuthActor | null> {
  if (cookie === null) return null;
  if (cookie.split('.').length !== 5) throw new InvalidWebOAuthActorError();
  try {
    const { payload, protectedHeader } = await decryptLegacyWebJwe(cookie, secret, 15);
    if (
      protectedHeader.alg !== 'dir' ||
      protectedHeader.enc !== 'A256GCM' ||
      typeof payload.sub !== 'string' ||
      !payload.sub.trim() ||
      payload.sub.length > 1024 ||
      Buffer.from(payload.sub, 'utf8').toString('utf8') !== payload.sub ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.iat) ||
      (payload.iat as number) < 0 ||
      ['sourceProof', 'currentStoreWebSource', 'authPublication', 'webSessionSource'].some((name) =>
        Object.hasOwn(payload, name),
      )
    )
      throw new InvalidWebOAuthActorError();
    const lineage = payload.authSessionId === undefined ? payload.jti : payload.authSessionId;
    if (
      typeof lineage !== 'string' ||
      !lineage.trim() ||
      lineage.length > 1024 ||
      Buffer.from(lineage, 'utf8').toString('utf8') !== lineage
    )
      throw new InvalidWebOAuthActorError();
    return {
      userId: payload.sub,
      lineageHash: createHash('sha256')
        .update(JSON.stringify(['web-oauth-actor-v1', payload.sub, lineage]))
        .digest('hex'),
      expiresAtSeconds: payload.exp as number,
    };
  } catch {
    throw new InvalidWebOAuthActorError();
  }
}

export function webOAuthActorStillValid(actor: NegativeWebOAuthActor | null): boolean {
  return actor === null || Math.floor(Date.now() / 1000) < actor.expiresAtSeconds + 15;
}
