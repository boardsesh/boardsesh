import { and, eq } from 'drizzle-orm';
import { auroraCredentials, providerSyncControls } from '@boardsesh/db/schema';
import { rotateLinkGeneration } from '@boardsesh/db/queries';
import { decrypt, encrypt } from '@boardsesh/crypto';
import {
  AuroraClimbingClient,
  MAX_CREDENTIAL_FAILURES,
  isAuroraBoardName,
  isAuroraRequestError,
  type AuroraBoardName,
} from '@boardsesh/aurora-sync/api';
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

type Credential = typeof auroraCredentials.$inferSelect;
type CredentialTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Short locks always follow generation -> credential, matching relink and fenced sync. */
async function withLockedCredential<Result>(
  userId: string,
  boardType: AuroraLiveBoardName,
  binding: AuroraLiveCredentialBinding,
  signal: AbortSignal,
  operation: (transaction: CredentialTransaction, credential: Credential) => Promise<Result>,
  initializeLegacyControl = false,
): Promise<Result> {
  return db.transaction(async (transaction) => {
    signal.throwIfAborted();
    let [control] = await transaction
      .select()
      .from(providerSyncControls)
      .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, boardType)))
      .for('update')
      .limit(1);
    let initializedLegacyControl = false;
    if (!control && initializeLegacyControl && binding.linkGeneration === null) {
      // Establish the fence before taking the credential lock. A racing relink
      // that created the row first must win rather than being treated as ours.
      const inserted = await transaction
        .insert(providerSyncControls)
        .values({ userId, boardType, linked: true })
        .onConflictDoNothing()
        .returning({ linkGeneration: providerSyncControls.linkGeneration });
      initializedLegacyControl = inserted.length === 1;
      [control] = await transaction
        .select()
        .from(providerSyncControls)
        .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, boardType)))
        .for('update')
        .limit(1);
    }
    if (
      (control && !control.linked) ||
      (!initializedLegacyControl && (control?.linkGeneration ?? null) !== binding.linkGeneration)
    )
      throw new AuroraLiveCredentialChangedError();
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
    return operation(transaction, credential);
  });
}

const pendingRefreshes = new Map<string, Promise<string>>();

/** Snapshot -> unlocked HTTP login -> identity/generation/token-CAS commit. */
export async function getAuroraLiveToken(
  userId: string,
  boardType: AuroraLiveBoardName,
  binding: AuroraLiveCredentialBinding,
  signal: AbortSignal,
  rejectedToken?: string,
): Promise<string> {
  if (!isAuroraLiveBoardName(boardType)) throw new AuroraLiveCredentialChangedError();
  const snapshot = await withLockedCredential(
    userId,
    boardType,
    binding,
    signal,
    async (_transaction, credential) => credential,
  );
  const storedToken = snapshot.auroraToken ? decrypt(snapshot.auroraToken) : null;
  if (storedToken && storedToken !== rejectedToken) return storedToken;
  if (!snapshot.encryptedUsername || !snapshot.encryptedPassword) throw new AuroraLiveCredentialChangedError();
  // Coalesce concurrent walls on this process without holding pool connections or row locks.
  const key = JSON.stringify([
    userId,
    boardType,
    String(binding.credentialId),
    binding.linkGeneration,
    binding.upstreamUserId,
    snapshot.auroraToken,
  ]);
  const pending = pendingRefreshes.get(key);
  if (pending) {
    const token = await pending;
    signal.throwIfAborted();
    return token;
  }
  const refresh = async (): Promise<string> => {
    const client = new AuroraClimbingClient({ boardName: boardType });
    let session: Awaited<ReturnType<AuroraClimbingClient['signIn']>>;
    try {
      session = await client.signIn(decrypt(snapshot.encryptedUsername!), decrypt(snapshot.encryptedPassword!), {
        signal,
      });
    } catch (error) {
      if (signal.aborted || !isAuroraRequestError(error) || error.code !== 'invalid_credentials') throw error;
      const winner = await withLockedCredential(
        userId,
        boardType,
        binding,
        signal,
        async (transaction, credential) => {
          if (credential.auroraToken !== snapshot.auroraToken) {
            if (!credential.auroraToken) throw new AuroraLiveCredentialChangedError();
            return decrypt(credential.auroraToken);
          }
          if (
            credential.encryptedUsername !== snapshot.encryptedUsername ||
            credential.encryptedPassword !== snapshot.encryptedPassword
          )
            throw new AuroraLiveCredentialChangedError();
          const credentialFailureCount = credential.credentialFailureCount + 1;
          const expired = credentialFailureCount >= MAX_CREDENTIAL_FAILURES;
          // Match routine sync's tolerance for one anomalous login refusal.
          // At the shared threshold, fence any already-running sync writer.
          if (expired) await rotateLinkGeneration(transaction, { userId, boardType, linked: true });
          await transaction
            .update(auroraCredentials)
            .set({
              auroraToken: expired ? null : credential.auroraToken,
              syncStatus: expired ? 'expired' : 'error',
              syncError: expired
                ? 'Aurora rejected the saved password. Reconnect this account to resume sync.'
                : 'Aurora refused a login attempt. Sync will retry.',
              credentialFailureCount,
              lastCredentialFailureAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(auroraCredentials.id, binding.credentialId));
          return null;
        },
        true,
      );
      if (winner) return winner;
      throw error;
    }
    signal.throwIfAborted();
    if (!session.token || session.user_id !== binding.upstreamUserId) throw new AuroraLiveCredentialChangedError();
    return withLockedCredential(userId, boardType, binding, signal, async (transaction, credential) => {
      if (credential.auroraToken !== snapshot.auroraToken) {
        if (!credential.auroraToken) throw new AuroraLiveCredentialChangedError();
        return decrypt(credential.auroraToken);
      }
      if (
        credential.encryptedUsername !== snapshot.encryptedUsername ||
        credential.encryptedPassword !== snapshot.encryptedPassword
      )
        throw new AuroraLiveCredentialChangedError();
      await transaction
        .update(auroraCredentials)
        .set({
          auroraToken: encrypt(session.token!),
          credentialFailureCount: 0,
          lastCredentialFailureAt: null,
          updatedAt: new Date(),
        })
        .where(eq(auroraCredentials.id, binding.credentialId));
      return session.token!;
    });
  };
  const operation = refresh();
  pendingRefreshes.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pendingRefreshes.get(key) === operation) pendingRefreshes.delete(key);
  }
}
