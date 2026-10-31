import { randomUUID } from 'expo-crypto';
import type { SaveClimbInput, UpdateClimbInput } from '@boardsesh/shared-schema';
import type { SaveClimbResponse, UpdateClimbResponse } from '@boardsesh/board-react';
import {
  beginImmediateWrite,
  capturePurgeToken,
  climbMutationEntityKey,
  enqueue,
  getLatestClimbMutationKey,
  getLocalUserId,
  hasPurgeLanded,
  isScopeDownloadComplete,
  offlineBoardKey,
  purgeNamespaceKey,
  runLocalWriteWithRetry,
  type OfflineDatabase,
  type SqlExecutor,
} from '@boardsesh/offline-sync';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { readLocalUserId } from '../lib/local-user-id';
import { getSprayWall, sprayWallArchiveState } from '../lib/spray/spray-wall-registry';
import { isOfflineBoardEnabled } from '../settings';
import { notifyOutboxChanged } from './outbox-store';

function storedCharacteristics(input: {
  characteristics?: string[] | null;
  noMatch?: boolean | null;
  anyFeet?: boolean | null;
}): string {
  const characteristics = new Set(input.characteristics ?? []);
  if (input.noMatch) characteristics.add('no_match');
  else if (input.noMatch === false) characteristics.delete('no_match');
  if (input.anyFeet) characteristics.add('any_feet');
  else if (input.anyFeet === false) characteristics.delete('any_feet');
  return JSON.stringify([...characteristics]);
}

async function withClimbWrite(
  db: OfflineDatabase,
  userId: string,
  task: (transaction: SqlExecutor) => Promise<void>,
  generation: number,
  canWrite: () => boolean,
): Promise<void> {
  await runLocalWriteWithRetry(() =>
    db.withExclusiveTransactionAsync(async (transaction) => {
      await beginImmediateWrite(transaction, 1000);
      if (
        !canWrite() ||
        !isAuthCredentialGenerationCurrent(generation) ||
        (await getLocalUserId(transaction)) !== userId
      ) {
        throw new Error('Offline climb belongs to another account');
      }
      await task(transaction);
      if (!canWrite() || !isAuthCredentialGenerationCurrent(generation))
        throw new Error('Account changed while saving climb');
    }),
  );
  notifyOutboxChanged();
}

/** A saved wall is the prerequisite: its geometry and photo must survive a restart. */
export async function saveClimbLocal(db: OfflineDatabase, input: SaveClimbInput): Promise<SaveClimbResponse | null> {
  if (input.boardType !== 'spray') return null;
  const generation = captureAuthCredentialGeneration();
  const purgeToken = capturePurgeToken();
  const userId = await readLocalUserId();
  const wall = getSprayWall(input.layoutId);
  if (!userId || !wall) return null;
  if (sprayWallArchiveState('spray', input.layoutId)?.archivedAt) throw new Error('Archived walls are read only');
  const scope = { boardType: 'spray', layoutId: input.layoutId, sizeId: input.layoutId };
  if (!isOfflineBoardEnabled(scope) || !(await isScopeDownloadComplete(db, offlineBoardKey(scope)))) return null;
  const uuid = input.uuid ?? randomUUID().replace(/-/g, '').toUpperCase();
  input.uuid = uuid;
  const previouslySaved = await db.getFirstAsync<{ user_id: string; layout_id: number }>(
    'SELECT user_id, layout_id FROM board_climbs WHERE uuid = ?',
    [uuid],
  );
  if (previouslySaved) {
    if (previouslySaved.user_id !== userId || previouslySaved.layout_id !== input.layoutId)
      throw new Error('Climb identity belongs to another wall or account');
    if (!isAuthCredentialGenerationCurrent(generation)) throw new Error('Account changed while saving climb');
    return updateClimbLocal(db, {
      uuid,
      boardType: input.boardType,
      name: input.name,
      description: input.description,
      frames: input.frames,
      framesCount: input.framesCount,
      framesPace: input.framesPace,
      angle: input.angle,
      isDraft: input.isDraft,
      characteristics: input.characteristics,
      noMatch: input.noMatch,
      anyFeet: input.anyFeet,
      sizeId: input.sizeId,
      userGrade: input.userGrade,
      sprayWallUuid: input.sprayWallUuid,
    });
  }
  const now = new Date().toISOString();
  const payload = { ...input, sprayWallUuid: wall.wallUuid };
  await withClimbWrite(
    db,
    userId,
    async (transaction) => {
      await transaction.runAsync(
        `INSERT OR IGNORE INTO board_climbs
      (uuid, board_type, layout_id, user_id, setter_username, name, description, frames, frames_count,
       frames_pace, angle, is_draft, is_listed, created_at, published_at, compatible_size_ids,
       required_set_ids, characteristics, missing_hold_count, updated_at, sync_seq)
      VALUES (?, 'spray', ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 0, NULL, 0)`,
        [
          uuid,
          input.layoutId,
          userId,
          input.name,
          input.description ?? '',
          input.frames,
          input.framesCount ?? 1,
          input.framesPace ?? 0,
          wall.angle ?? input.angle,
          input.isDraft ? 1 : 0,
          input.isDraft ? 0 : 1,
          now,
          input.isDraft ? null : now,
          JSON.stringify([input.layoutId]),
          storedCharacteristics(input),
        ],
      );
      await enqueue(transaction, 'board_climbs', 'create', payload, `climb:create:${uuid}`, {
        entityKey: climbMutationEntityKey('spray', uuid),
        reviveDeadLetter: true,
      });
    },
    generation,
    () => !hasPurgeLanded(purgeToken, purgeNamespaceKey(scope)),
  );
  return { uuid, createdAt: now, publishedAt: input.isDraft ? null : now, isDraft: input.isDraft, delivery: 'queued' };
}

export async function updateClimbLocal(
  db: OfflineDatabase,
  input: UpdateClimbInput,
): Promise<UpdateClimbResponse | null> {
  if (input.boardType !== 'spray') return null;
  const generation = captureAuthCredentialGeneration();
  const purgeToken = capturePurgeToken();
  const userId = await readLocalUserId();
  const existing = await db.getFirstAsync<{
    user_id: string;
    layout_id: number;
    created_at: string | null;
    published_at: string | null;
    is_draft: number;
    characteristics: string | null;
  }>(
    "SELECT user_id, layout_id, created_at, published_at, is_draft, characteristics FROM board_climbs WHERE uuid = ? AND board_type = 'spray'",
    [input.uuid],
  );
  if (!userId || !existing || !getSprayWall(existing.layout_id)) return null;
  if (existing.user_id !== userId) throw new Error('Only the creator can edit this climb');
  if (sprayWallArchiveState('spray', existing.layout_id)?.archivedAt) throw new Error('Archived walls are read only');
  const scope = { boardType: 'spray', layoutId: existing.layout_id, sizeId: existing.layout_id };
  if (!isOfflineBoardEnabled(scope) || !(await isScopeDownloadComplete(db, offlineBoardKey(scope)))) return null;
  const now = new Date().toISOString();
  let isDraft = existing.is_draft === 1 && input.isDraft !== false;
  let publishedAt = existing.published_at ?? (isDraft ? null : now);
  const operationKey = `climb:update:${randomUUID()}`;
  const wall = getSprayWall(existing.layout_id)!;
  await withClimbWrite(
    db,
    userId,
    async (transaction) => {
      const current = await transaction.getFirstAsync<typeof existing>(
        "SELECT user_id, layout_id, created_at, published_at, is_draft, characteristics FROM board_climbs WHERE uuid = ? AND board_type = 'spray'",
        [input.uuid],
      );
      if (!current || current.user_id !== userId || current.layout_id !== existing.layout_id)
        throw new Error('Climb changed while saving');
      const stagedCreate = await transaction.getFirstAsync<{ status: string }>(
        "SELECT status FROM pending_mutations WHERE table_name = 'board_climbs' AND entity_key = ? AND operation = 'create' LIMIT 1",
        [climbMutationEntityKey('spray', input.uuid)],
      );
      isDraft =
        stagedCreate?.status === 'dead_letter'
          ? (input.isDraft ?? current.is_draft === 1)
          : current.is_draft === 1 && input.isDraft !== false;
      publishedAt = isDraft ? null : (current.published_at ?? now);
      const dependsOnKey = await getLatestClimbMutationKey(transaction, 'spray', input.uuid);
      const updates: string[] = [];
      const binds: (string | number | null)[] = [];
      const fields = {
        name: input.name,
        description: input.description,
        frames: input.frames,
        frames_count: input.framesCount,
        frames_pace: input.framesPace,
        angle: input.angle,
      };
      for (const [column, content] of Object.entries(fields)) {
        if (content !== undefined && content !== null) {
          updates.push(`${column} = ?`);
          binds.push(content);
        }
      }
      if (input.characteristics !== undefined || input.noMatch !== undefined || input.anyFeet !== undefined) {
        const previous = JSON.parse(current.characteristics ?? '[]') as string[];
        updates.push('characteristics = ?');
        binds.push(
          storedCharacteristics({
            ...input,
            characteristics: input.characteristics ?? previous,
            noMatch: input.noMatch ?? previous.includes('no_match'),
            anyFeet: input.anyFeet ?? previous.includes('any_feet'),
          }),
        );
      }
      updates.push('is_draft = ?', 'is_listed = ?', 'published_at = ?', 'updated_at = NULL');
      binds.push(isDraft ? 1 : 0, isDraft ? 0 : 1, publishedAt, input.uuid, userId);
      await transaction.runAsync(`UPDATE board_climbs SET ${updates.join(', ')} WHERE uuid = ? AND user_id = ?`, binds);
      const entityKey = climbMutationEntityKey('spray', input.uuid);
      const failedWrite = await transaction.getFirstAsync<{
        operation: 'create' | 'update';
        payload: string;
        idempotency_key: string;
      }>(
        "SELECT operation, payload, idempotency_key FROM pending_mutations WHERE table_name = 'board_climbs' AND entity_key = ? AND status = 'dead_letter' ORDER BY id ASC LIMIT 1",
        [entityKey],
      );
      if (failedWrite) {
        const original = JSON.parse(failedWrite.payload) as Record<string, unknown>;
        const supplied = Object.fromEntries(Object.entries(input).filter(([, content]) => content !== undefined));
        let repairedKey = failedWrite.idempotency_key;
        if (failedWrite.operation === 'update') {
          // A dead letter may already have landed remotely before its canonical
          // read failed. Its receipt must keep identifying that original payload.
          // Saving a repaired form is a NEW operation; move its dependents with
          // it atomically so they cannot overtake the corrected climb write.
          repairedKey = `climb:update:${randomUUID()}`;
          await transaction.runAsync('UPDATE pending_mutations SET depends_on_key = ? WHERE depends_on_key = ?', [
            repairedKey,
            failedWrite.idempotency_key,
          ]);
          await transaction.runAsync(
            "UPDATE pending_mutations SET idempotency_key = ? WHERE idempotency_key = ? AND status = 'dead_letter'",
            [repairedKey, failedWrite.idempotency_key],
          );
        }
        await enqueue(
          transaction,
          'board_climbs',
          failedWrite.operation,
          { ...original, ...supplied, sprayWallUuid: wall.wallUuid },
          repairedKey,
          { entityKey, reviveDeadLetter: true },
        );
      }
      if (!failedWrite || failedWrite.operation === 'create' || dependsOnKey !== failedWrite.idempotency_key) {
        await enqueue(transaction, 'board_climbs', 'update', { ...input, sprayWallUuid: wall.wallUuid }, operationKey, {
          entityKey,
          ...(dependsOnKey ? { dependsOnKey } : {}),
        });
      }
    },
    generation,
    () => !hasPurgeLanded(purgeToken, purgeNamespaceKey(scope)),
  );
  return { uuid: input.uuid, createdAt: existing.created_at, publishedAt, isDraft, delivery: 'queued' };
}
