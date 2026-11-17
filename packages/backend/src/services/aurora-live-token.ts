import { and, eq } from 'drizzle-orm';
import { auroraCredentials, providerSyncControls } from '@boardsesh/db/schema';
import { decrypt, encrypt } from '@boardsesh/crypto';
import { AuroraClimbingClient, isAuroraBoardName, type AuroraBoardName } from '@boardsesh/aurora-sync/api';
import { db } from '../db/client';

export type AuroraLiveBoardName = Exclude<AuroraBoardName, 'kilter'>;
export function isAuroraLiveBoardName(boardType: string): boardType is AuroraLiveBoardName {
  return boardType !== 'kilter' && isAuroraBoardName(boardType);
}

export type AuroraLiveCredentialBinding = {
  credentialId: bigint;
  linkGeneration: string | null;
  upstreamUserId: number;
};

export class AuroraLiveCredentialChangedError extends Error {
  constructor() {
    super('Aurora account link changed');
    this.name = 'AuroraLiveCredentialChangedError';
  }
}

/** Lock the generation before the credential, matching link/unlink and fenced sync writes. */
export async function getAuroraLiveToken(
  userId: string,
  boardType: AuroraLiveBoardName,
  binding: AuroraLiveCredentialBinding,
  signal: AbortSignal,
  rejectedToken?: string,
): Promise<string> {
  if (!isAuroraLiveBoardName(boardType)) throw new AuroraLiveCredentialChangedError();
  return db.transaction(async (transaction) => {
    signal.throwIfAborted();
    const [control] = await transaction
      .select()
      .from(providerSyncControls)
      .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, boardType)))
      .for('share')
      .limit(1);
    if ((control && !control.linked) || (control?.linkGeneration ?? null) !== binding.linkGeneration) {
      throw new AuroraLiveCredentialChangedError();
    }
    const [credential] = await transaction
      .select()
      .from(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, boardType)))
      .for('update')
      .limit(1);
    if (
      !credential ||
      credential.id !== binding.credentialId ||
      credential.auroraUserId !== binding.upstreamUserId ||
      !['pending', 'active', 'error'].includes(credential.syncStatus)
    )
      throw new AuroraLiveCredentialChangedError();
    signal.throwIfAborted();
    // Another poller/sync may already have replaced the rejected session while we waited.
    const storedToken = credential.auroraToken ? decrypt(credential.auroraToken) : null;
    if (storedToken && storedToken !== rejectedToken) return storedToken;
    if (!credential.encryptedUsername || !credential.encryptedPassword) throw new AuroraLiveCredentialChangedError();
    const client = new AuroraClimbingClient({ boardName: boardType });
    const session = await client.signIn(decrypt(credential.encryptedUsername), decrypt(credential.encryptedPassword), {
      signal,
    });
    signal.throwIfAborted();
    if (!session.token || session.user_id !== binding.upstreamUserId) throw new AuroraLiveCredentialChangedError();
    await transaction
      .update(auroraCredentials)
      .set({ auroraToken: encrypt(session.token), updatedAt: new Date() })
      .where(eq(auroraCredentials.id, binding.credentialId));
    return session.token;
  });
}
