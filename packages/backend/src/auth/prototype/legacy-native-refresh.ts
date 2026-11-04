import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/auth-prototype';
import type { PrototypeDatabase } from './authority';
import { ensurePrototypeMigrationEpoch } from './migration-epoch';
import { hasPrototypeLegacySourceDenial } from './legacy-source-state';

const PREFIX = 'prototype-legacy-native-refresh:';
const MAX_REFRESH_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** Exact existing mobile_refresh_tokens fields, supplied by a trusted snapshot. */
export interface PrototypeLegacyNativeRefreshRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

interface ImportedRefreshBinding {
  readonly type: 'prototype-legacy-native-refresh';
  readonly sourceId: string;
  readonly userId: string;
  readonly sourceCreatedAt: string;
  readonly originalExpiresAt: string;
  readonly sessionId: string | null;
  readonly revokedAt: string | null;
}

export class PrototypeLegacyNativeRefreshError extends Error {
  constructor() {
    super('Invalid legacy refresh snapshot or cutover boundary');
    this.name = 'PrototypeLegacyNativeRefreshError';
  }
}

function bindingIdentifier(tokenHash: string): string {
  return `${PREFIX}${createHash('sha256').update(tokenHash).digest('hex')}`;
}

function lineageIdentifier(tokenHash: string): string {
  return `credential:${createHash('sha256')
    .update(JSON.stringify(['legacy-native-refresh', tokenHash]))
    .digest('hex')}`;
}

function sourceIdentifier(sourceId: string): string {
  return `${PREFIX}source:${createHash('sha256').update(sourceId).digest('hex')}`;
}

function parsedBinding(serialized: string): ImportedRefreshBinding | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (typeof candidate !== 'object' || candidate === null) return null;
  const binding = candidate as Record<string, unknown>;
  if (
    binding.type !== 'prototype-legacy-native-refresh' ||
    typeof binding.sourceId !== 'string' ||
    typeof binding.userId !== 'string' ||
    typeof binding.sourceCreatedAt !== 'string' ||
    !Number.isFinite(Date.parse(binding.sourceCreatedAt)) ||
    typeof binding.originalExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(binding.originalExpiresAt)) ||
    !(binding.sessionId === null || typeof binding.sessionId === 'string') ||
    !(
      binding.revokedAt === null ||
      (typeof binding.revokedAt === 'string' && Number.isFinite(Date.parse(binding.revokedAt)))
    )
  )
    return null;
  return binding as unknown as ImportedRefreshBinding;
}

function matchesSource(binding: ImportedRefreshBinding, record: PrototypeLegacyNativeRefreshRecord): boolean {
  return (
    binding.sourceId === record.id &&
    binding.userId === record.userId &&
    binding.sourceCreatedAt === record.createdAt.toISOString() &&
    binding.originalExpiresAt === record.expiresAt.toISOString()
  );
}

/**
 * Disposable snapshot import, not a live migration or a replacement token issuer.
 * The immutable cutover must come from the fenced original authority. Passwords
 * and plaintext refresh secrets are neither accepted nor generated here.
 *
 * Existing records prove their owner and issuance, not original authentication
 * age. Every canonical session is explicitly non-fresh. A canonical account
 * cutoff rejects pre-cutover imports, including delayed stale snapshots; an old
 * authority continuing to issue after cutover remains an unproven rollout gate.
 */
export async function importPrototypeLegacyNativeRefresh(
  database: PrototypeDatabase,
  records: readonly PrototypeLegacyNativeRefreshRecord[],
  cutoverAt: Date,
  afterRecordImported?: () => Promise<void>,
) {
  const observedAt = Date.now();
  const cutoverTime = cutoverAt.getTime();
  if (
    !Number.isFinite(cutoverTime) ||
    cutoverTime > observedAt ||
    observedAt >= cutoverTime + MAX_REFRESH_LIFETIME_MS
  ) {
    throw new PrototypeLegacyNativeRefreshError();
  }
  // Copy dates as well as scalar fields before awaiting the fence. A mutable
  // caller snapshot cannot change its owner/expiry while this import waits.
  const snapshot = records.map((record) => ({
    ...record,
    createdAt: new Date(record.createdAt.getTime()),
    expiresAt: new Date(record.expiresAt.getTime()),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt.getTime()),
  }));
  const idCounts = new Map<string, number>();
  const hashCounts = new Map<string, number>();
  for (const record of snapshot) {
    idCounts.set(record.id, (idCounts.get(record.id) ?? 0) + 1);
    hashCounts.set(record.tokenHash, (hashCounts.get(record.tokenHash) ?? 0) + 1);
  }

  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
    if (Date.now() >= cutoverTime + MAX_REFRESH_LIFETIME_MS) throw new PrototypeLegacyNativeRefreshError();
    // The authority boundary must outlive both token expiry and the library's
    // blanket verification cleanup. It is permanent migration metadata.
    if (!(await ensurePrototypeMigrationEpoch(transaction, 'native-refresh', cutoverTime))) {
      throw new PrototypeLegacyNativeRefreshError();
    }

    const report = { imported: 0, alreadyBound: 0, revoked: 0, rejected: 0 };
    for (const record of snapshot) {
      const now = Date.now();
      const createdAt = record.createdAt.getTime();
      const expiresAt = record.expiresAt.getTime();
      const revokedAt = record.revokedAt?.getTime();
      if (
        !record.id.trim() ||
        !record.userId.trim() ||
        !/^[a-f0-9]{64}$/.test(record.tokenHash) ||
        idCounts.get(record.id) !== 1 ||
        hashCounts.get(record.tokenHash) !== 1 ||
        !Number.isFinite(createdAt) ||
        !Number.isFinite(expiresAt) ||
        createdAt > cutoverTime ||
        expiresAt <= createdAt ||
        expiresAt <= now ||
        expiresAt > cutoverTime + MAX_REFRESH_LIFETIME_MS ||
        (revokedAt !== undefined && (!Number.isFinite(revokedAt) || revokedAt < createdAt || revokedAt > now))
      ) {
        report.rejected += 1;
        continue;
      }
      const [owner] = await transaction
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.id, record.userId));
      const [cutoff] = await transaction
        .select({ userId: schema.prototypeUserCutoff.userId })
        .from(schema.prototypeUserCutoff)
        .where(eq(schema.prototypeUserCutoff.userId, record.userId));
      if (!owner || cutoff) {
        report.rejected += 1;
        continue;
      }
      const identifier = bindingIdentifier(record.tokenHash);
      const lineageId = lineageIdentifier(record.tokenHash);
      const sourceReferenceId = sourceIdentifier(record.id);
      const [sourceReference] = await transaction
        .select()
        .from(schema.verification)
        .where(eq(schema.verification.id, sourceReferenceId));
      if (
        sourceReference &&
        (sourceReference.value !== identifier || sourceReference.expiresAt.getTime() !== expiresAt)
      ) {
        report.rejected += 1;
        continue;
      }
      const [persisted] = await transaction
        .select()
        .from(schema.verification)
        .where(eq(schema.verification.id, identifier));
      const previous = persisted ? parsedBinding(persisted.value) : null;
      if (persisted && (!previous || !matchesSource(previous, record) || persisted.expiresAt.getTime() !== expiresAt)) {
        report.rejected += 1;
        continue;
      }

      if (previous) {
        await transaction
          .insert(schema.verification)
          .values({
            id: sourceReferenceId,
            identifier: sourceReferenceId,
            value: identifier,
            expiresAt: record.expiresAt,
          })
          .onConflictDoNothing();
        if (previous.revokedAt !== null) {
          report.revoked += 1;
          continue;
        }
        const [session] = previous.sessionId
          ? await transaction.select().from(schema.session).where(eq(schema.session.id, previous.sessionId))
          : [];
        const [lineage] = await transaction
          .select()
          .from(schema.prototypeLegacyLineage)
          .where(eq(schema.prototypeLegacyLineage.id, lineageId));
        if (
          !session ||
          session.userId !== record.userId ||
          session.expiresAt.getTime() <= now ||
          !lineage ||
          lineage.userId !== record.userId ||
          lineage.sessionId !== session.id ||
          lineage.originalExpiresAt.getTime() !== expiresAt ||
          lineage.revokedAt !== null
        ) {
          // A vanished canonical session is a durable denial, never a reason to
          // create a new session from an unchanged old snapshot.
          await transaction
            .update(schema.verification)
            .set({ value: JSON.stringify({ ...previous, revokedAt: new Date(now).toISOString() }) })
            .where(eq(schema.verification.id, identifier));
          report.revoked += 1;
          continue;
        }
        if (record.revokedAt !== null) {
          await transaction
            .update(schema.prototypeLegacyLineage)
            .set({ revokedAt: record.revokedAt })
            .where(eq(schema.prototypeLegacyLineage.id, lineageId));
          await transaction.delete(schema.session).where(eq(schema.session.id, session.id));
          await transaction
            .update(schema.verification)
            .set({ value: JSON.stringify({ ...previous, revokedAt: record.revokedAt.toISOString() }) })
            .where(eq(schema.verification.id, identifier));
          report.revoked += 1;
          continue;
        }
        // Rotation sets the old native row's revokedAt. Do not clear it and do
        // not revoke the live descendant merely because import is rerun.
        report.alreadyBound += 1;
        continue;
      }

      // A user-only old source cannot prove which canonical session authorized
      // it. Check durable denial history only for unseen admissions: an exact
      // known live binding above remains valid after another session signs out.
      if (await hasPrototypeLegacySourceDenial(transaction, record.userId)) {
        report.rejected += 1;
        continue;
      }

      const [existingToken] = await transaction
        .select({ tokenHash: schema.prototypeNativeRefresh.tokenHash })
        .from(schema.prototypeNativeRefresh)
        .where(eq(schema.prototypeNativeRefresh.tokenHash, record.tokenHash));
      const [existingLineage] = await transaction
        .select({ id: schema.prototypeLegacyLineage.id })
        .from(schema.prototypeLegacyLineage)
        .where(eq(schema.prototypeLegacyLineage.id, lineageId));
      if (existingToken || existingLineage) {
        report.rejected += 1;
        continue;
      }
      const sessionId = record.revokedAt === null ? randomUUID() : null;
      const binding: ImportedRefreshBinding = {
        type: 'prototype-legacy-native-refresh',
        sourceId: record.id,
        userId: record.userId,
        sourceCreatedAt: record.createdAt.toISOString(),
        originalExpiresAt: record.expiresAt.toISOString(),
        sessionId,
        revokedAt: record.revokedAt?.toISOString() ?? null,
      };
      if (sessionId !== null) {
        await transaction.insert(schema.session).values({
          id: sessionId,
          token: randomBytes(32).toString('hex'),
          userId: record.userId,
          createdAt: new Date(0),
          updatedAt: new Date(now),
          expiresAt: record.expiresAt,
          originalAuthenticatedAt: null,
          legacyLineageId: lineageId,
        });
        await transaction.insert(schema.prototypeLegacyLineage).values({
          id: lineageId,
          userId: record.userId,
          sessionId,
          originalAuthenticatedAt: null,
          originalExpiresAt: record.expiresAt,
        });
        await transaction.insert(schema.prototypeNativeRefresh).values({
          tokenHash: record.tokenHash,
          userId: record.userId,
          sessionId,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          revokedAt: null,
        });
        report.imported += 1;
      } else {
        report.revoked += 1;
      }
      await transaction.insert(schema.verification).values({
        id: identifier,
        identifier,
        value: JSON.stringify(binding),
        expiresAt: record.expiresAt,
      });
      await transaction.insert(schema.verification).values({
        id: sourceReferenceId,
        identifier: sourceReferenceId,
        value: identifier,
        expiresAt: record.expiresAt,
      });
      await afterRecordImported?.();
    }
    return report;
  });
}
