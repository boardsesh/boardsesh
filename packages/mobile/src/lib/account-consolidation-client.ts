import { parseAccountConsolidationReceipt } from '@boardsesh/auth-protocol/account-consolidation';
import {
  transitionConsolidatedOwner,
  type ConsolidationTransitionJournal,
} from '@boardsesh/auth-protocol/account-consolidation-transition';
import { setSigningOut, beginGlobalPurge } from '@boardsesh/offline-sync';
import { clearUserData, getDatabaseHandle } from '../db';
import { userIdFromJwt } from './jwt-user-id';
import {
  advanceAuthConsolidationEpoch,
  captureAuthCredentialGeneration,
  clearConsolidationStageForGeneration,
  getAuthToken,
  isAuthCredentialGenerationCurrent,
  readConsolidationStage,
  storeTokensForGeneration,
  writeConsolidationStageForGeneration,
} from './auth-store';

interface StagedConsolidation {
  readonly receipt: ConsolidationTransitionJournal;
  readonly jwt: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
}
let pauseGeneration: number | null = null;
let onCompleted: (() => void) | null = null;
let recovery: Promise<void> | null = null;

export function setOnAccountConsolidated(callback: (() => void) | null): void {
  onCompleted = callback;
}

function decodeStage(contents: string | null): StagedConsolidation | null {
  if (contents === null) return null;
  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== 'object' || parsed === null || !('receipt' in parsed))
    throw new Error('Invalid consolidation stage');
  const stage = parsed as Record<string, unknown>;
  const journal = stage.receipt;
  if (typeof journal !== 'object' || journal === null) throw new Error('Invalid consolidation journal');
  const fields = journal as Record<string, unknown>;
  const receipt = parseAccountConsolidationReceipt(journal, String(fields.fromUserId), String(fields.toUserId));
  if (
    !receipt ||
    (fields.phase !== 'prepared' && fields.phase !== 'credentials-published') ||
    typeof stage.jwt !== 'string' ||
    typeof stage.refreshToken !== 'string' ||
    !stage.refreshToken ||
    typeof stage.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(stage.expiresAt)) ||
    userIdFromJwt(stage.jwt) !== receipt.toUserId
  )
    throw new Error('Invalid consolidation staged credentials');
  return {
    receipt: { ...receipt, phase: fields.phase },
    jwt: stage.jwt,
    refreshToken: stage.refreshToken,
    expiresAt: stage.expiresAt,
  };
}

async function runTransition(
  stage: StagedConsolidation,
  ownerId: string,
  originalGeneration: number,
): Promise<number | null> {
  let activeStage = stage;
  let result: 'completed' | 'superseded';
  try {
    result = await transitionConsolidatedOwner(stage.receipt, {
      captureOwner: () => ({ userId: ownerId, generation: originalGeneration }),
      advanceEpoch: advanceAuthConsolidationEpoch,
      isCurrent: isAuthCredentialGenerationCurrent,
      async pauseAndDrain(generation) {
        if (!isAuthCredentialGenerationCurrent(generation)) return false;
        pauseGeneration = generation;
        // Do not await the mutation drainer: refresh may be running inside it.
        beginGlobalPurge();
        setSigningOut(true);
        return true;
      },
      async stageCredentials(_receipt, generation) {
        return writeConsolidationStageForGeneration(generation, JSON.stringify(activeStage));
      },
      async readJournal() {
        return decodeStage(await readConsolidationStage())?.receipt ?? null;
      },
      async writeJournal(receipt, generation) {
        activeStage = { ...activeStage, receipt };
        return writeConsolidationStageForGeneration(generation, JSON.stringify(activeStage));
      },
      async publishCredentials(generation) {
        const durable = decodeStage(await readConsolidationStage());
        if (!durable || durable.receipt.mergeId !== stage.receipt.mergeId)
          throw new Error('Consolidation stage missing');
        return storeTokensForGeneration(generation, durable.jwt, durable.refreshToken, durable.expiresAt);
      },
      async commitLocalOwnership(receipt, generation) {
        const database = getDatabaseHandle();
        if (!database) throw new Error('Consolidation database unavailable');
        await clearUserData(database, {
          fromUserId: receipt.fromUserId,
          toUserId: receipt.toUserId,
          isCurrent: () => isAuthCredentialGenerationCurrent(generation),
        });
        return clearConsolidationStageForGeneration(generation);
      },
      async resume(generation) {
        if (pauseGeneration === generation && isAuthCredentialGenerationCurrent(generation)) {
          pauseGeneration = null;
          setSigningOut(false);
          onCompleted?.();
        }
      },
    });
  } catch (error) {
    // A failure before the first durable stage cannot be resumed. Release only
    // this still-current owner pause; a failed read remains blocked for retry.
    const generation = originalGeneration + 1;
    if (pauseGeneration === generation && isAuthCredentialGenerationCurrent(generation)) {
      const durable = await readConsolidationStage();
      if (durable === null) {
        pauseGeneration = null;
        setSigningOut(false);
        onCompleted?.();
      }
    }
    throw error;
  }
  return result === 'completed' ? captureAuthCredentialGeneration() : null;
}

export async function acceptNativeAccountConsolidation(
  reply: {
    readonly jwt: string;
    readonly refreshToken: string;
    readonly expiresAt: string;
    readonly accountConsolidation: unknown;
  },
  previousJwt: string,
  expectedGeneration: number,
): Promise<number | null> {
  if (!isAuthCredentialGenerationCurrent(expectedGeneration)) return null;
  const fromUserId = userIdFromJwt(previousJwt);
  const toUserId = userIdFromJwt(reply.jwt);
  if (!fromUserId || !toUserId) throw new Error('Consolidation credential identity missing');
  const receipt = parseAccountConsolidationReceipt(reply.accountConsolidation, fromUserId, toUserId);
  if (!receipt) throw new Error('Consolidation response owner mismatch');
  const stage = decodeStage(JSON.stringify({ ...reply, receipt: { ...receipt, phase: 'prepared' } }));
  if (!stage) throw new Error('Consolidation credentials missing');
  return runTransition(stage, fromUserId, expectedGeneration);
}

/** Called before cached data can be served/drained on a cold start. */
export function resumePendingAccountConsolidation(): Promise<void> {
  if (recovery) return recovery;
  recovery = (async () => {
    const generation = captureAuthCredentialGeneration();
    const stage = decodeStage(await readConsolidationStage());
    if (!stage || !isAuthCredentialGenerationCurrent(generation)) return;
    const token = await getAuthToken();
    let ownerId = userIdFromJwt(token);
    if (!ownerId) {
      const database = getDatabaseHandle();
      const owner = await database?.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
        'local_user_id',
      ]);
      // Only the exact durable source owner can recover a partially published
      // credential triple without trusting an absent or incomplete live JWT.
      if (owner?.value !== stage.receipt.fromUserId) throw new Error('Consolidation recovery owner unavailable');
      ownerId = owner.value;
    }
    if (!isAuthCredentialGenerationCurrent(generation)) return;
    await runTransition(stage, ownerId, generation);
  })().finally(() => {
    recovery = null;
  });
  return recovery;
}
