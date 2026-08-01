import { deleteSecureValue, readSecureValue, writeSecureValue } from './secure-store-io';
import type { UserStorageOwner } from './user-storage-owner';

export const SESSION_ID_KEY = 'boardsesh_active_session_id';

export async function getStoredSessionId(_owner?: UserStorageOwner | null): Promise<string | null> {
  try {
    return await readSecureValue(SESSION_ID_KEY);
  } catch {
    return null;
  }
}

export async function setStoredSessionId(sessionId: string, _owner?: UserStorageOwner | null): Promise<void> {
  await writeSecureValue(SESSION_ID_KEY, sessionId);
}

export async function clearStoredSessionId(_owner?: UserStorageOwner | null): Promise<void> {
  await deleteSecureValue(SESSION_ID_KEY);
}

/**
 * Id of the session THIS DEVICE started (as opposed to joined). Written by
 * createSessionWithConfig, cleared at the clearSession teardown boundary.
 *
 * Device provenance is the only signal that tells the phone which started a
 * party apart from the same climber's second phone. It deliberately is NOT
 * derived from the roster: the backend keys participants by
 * `client.userId || connectionId`, so one signed-in climber on two devices
 * collapses into a single participant row — every roster-derived signal
 * (`SessionUser.isLeader`, `connectionState`, distinct-user counts) is
 * participant-scoped and structurally blind to the second device. The
 * per-connection `Session.isLeader` from the JOIN response looks like the free
 * answer but historically was not: `upsertLocalParticipant` ORs leadership
 * across a participant's connections (sticky true), and the
 * SessionRosterSnapshot handler used to re-derive our own top-level flag from
 * that participant row, so the second device was told `isLeader: true` by its
 * very first roster snapshot (#3502's follow-up, fixed for the top-level flag
 * in #3952). The roster row itself (`SessionUser.isLeader`) is still
 * participant-scoped by design and stays structurally blind to which device is
 * which — this provenance-based approach remains the right one for device-level
 * UI.
 *
 * This drives EMPHASIS ONLY — which action a confirmation sheet leads with —
 * never whether an action is available. That is what makes losing it harmless:
 * a reinstall wipes SecureStore, the creator's original phone falls back to
 * leading with Leave, and End is still one tap away. A signal that degrades
 * toward offering the destructive action would be worse than no signal at all.
 */
export const CREATED_SESSION_ID_KEY = 'boardsesh_created_session_id';

export async function getStoredCreatedSessionId(): Promise<string | null> {
  try {
    return await readSecureValue(CREATED_SESSION_ID_KEY);
  } catch {
    return null;
  }
}

export async function setStoredCreatedSessionId(sessionId: string): Promise<void> {
  await writeSecureValue(CREATED_SESSION_ID_KEY, sessionId);
}

export async function clearStoredCreatedSessionId(): Promise<void> {
  await deleteSecureValue(CREATED_SESSION_ID_KEY);
}
