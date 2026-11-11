import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authEmailResolutionLog,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import type { EvidenceWorksheet } from '../email-audit/evidence';
import { normalizeAccountEmail } from '../normalize-email';
import { sqlNormalizedAccountEmail } from '../account-email-sql';

/** Fixed messages only. Neither database messages nor private inputs may escape the CLI. */
export class EmailResolutionError extends Error {
  constructor(
    readonly code: 'CONFIGURATION' | 'PRIVATE_FILE' | 'DECISION' | 'PLAN_HASH' | 'DRIFT' | 'DATABASE' | 'LIMIT',
  ) {
    super(`Account email resolution refused: ${code}`);
  }
}
export const digest = (contents: string): string => createHash('sha256').update(contents).digest('hex');
export type EvidenceKind = 'owner-knows' | 'batch-approved' | 'mailbox-reply' | 'no-reply-14-days';
export interface Decision {
  readonly group: string;
  readonly keeper: string;
  readonly evidenceKind: EvidenceKind;
  readonly contactedAt?: string;
}
export interface Decisions {
  readonly formatVersion: 1;
  readonly evidenceSha256: string;
  readonly groups: readonly Decision[];
  readonly normalizeStandalone: boolean;
}
export interface ResolutionMember {
  readonly userId: string;
  readonly before: string;
  readonly after: string;
  readonly action: 'keep' | 'retire' | 'normalize';
}
export interface ResolutionGroup {
  readonly label: string;
  readonly reference: string;
  readonly address: string;
  readonly evidenceKind: EvidenceKind;
  readonly members: readonly ResolutionMember[];
  readonly status: 'ready' | 'skipped' | 'deferred';
}
export interface ResolutionPlan {
  readonly formatVersion: 1;
  readonly document: 'boardsesh-account-email-resolution';
  readonly batchId: string;
  readonly unselectedGroups: number;
  readonly targetFingerprint: string;
  readonly evidenceSha256: string;
  readonly decisionsSha256: string;
  readonly groups: readonly ResolutionGroup[];
}
export type ResolutionDatabase = PostgresJsDatabase;
type Transaction = Parameters<Parameters<ResolutionDatabase['transaction']>[0]>[0];

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}
const kinds = new Set<EvidenceKind>(['owner-knows', 'batch-approved', 'mailbox-reply', 'no-reply-14-days']);

export function parseDecisions(candidate: unknown, evidenceSha256: string): Decisions {
  if (
    !isRecord(candidate) ||
    candidate.formatVersion !== 1 ||
    candidate.evidenceSha256 !== evidenceSha256 ||
    !Array.isArray(candidate.groups) ||
    candidate.groups.length > 2000 ||
    typeof candidate.normalizeStandalone !== 'boolean'
  )
    throw new EmailResolutionError('DECISION');
  const seen = new Set<string>();
  const groups: Decision[] = [];
  for (const entry of candidate.groups) {
    if (
      !isRecord(entry) ||
      typeof entry.group !== 'string' ||
      !/^G\d{2,4}$/.test(entry.group) ||
      typeof entry.keeper !== 'string' ||
      !/^(?:[A-Z]|M\d{2,4})$/.test(entry.keeper) ||
      typeof entry.evidenceKind !== 'string' ||
      !kinds.has(entry.evidenceKind as EvidenceKind) ||
      seen.has(entry.group) ||
      (entry.contactedAt !== undefined && typeof entry.contactedAt !== 'string')
    )
      throw new EmailResolutionError('DECISION');
    seen.add(entry.group);
    groups.push({
      group: entry.group,
      keeper: entry.keeper,
      evidenceKind: entry.evidenceKind as EvidenceKind,
      ...(typeof entry.contactedAt === 'string' ? { contactedAt: entry.contactedAt } : {}),
    });
  }
  return { formatVersion: 1, evidenceSha256, groups, normalizeStandalone: candidate.normalizeStandalone };
}

export function parseWorksheet(candidate: unknown): EvidenceWorksheet {
  if (
    !isRecord(candidate) ||
    candidate.formatVersion !== 1 ||
    candidate.document !== 'boardsesh-account-email-evidence' ||
    !Array.isArray(candidate.groups) ||
    candidate.groups.length > 2000
  )
    throw new EmailResolutionError('DECISION');
  const references = new Set<string>();
  const identities = new Set<string>();
  for (const group of candidate.groups) {
    if (
      !isRecord(group) ||
      typeof group.group !== 'string' ||
      !/^G\d{2,4}$/.test(group.group) ||
      references.has(group.group) ||
      typeof group.address !== 'string' ||
      !group.address ||
      group.address !== normalizeAccountEmail(group.address) ||
      !['A', 'B', 'C', 'D', 'E'].includes(String(group.kind)) ||
      !Array.isArray(group.members) ||
      group.members.length < 2 ||
      group.members.length > 2000
    )
      throw new EmailResolutionError('DECISION');
    references.add(group.group);
    const labels = new Set<string>();
    for (const member of group.members) {
      if (
        !isRecord(member) ||
        typeof member.member !== 'string' ||
        labels.has(member.member) ||
        typeof member.userId !== 'string' ||
        !member.userId ||
        identities.has(member.userId) ||
        typeof member.storedEmail !== 'string' ||
        normalizeAccountEmail(member.storedEmail) !== group.address
      )
        throw new EmailResolutionError('DECISION');
      labels.add(member.member);
      identities.add(member.userId);
    }
  }
  return candidate as unknown as EvidenceWorksheet;
}

function retiredAddress(reference: string, userId: string): string {
  return `${digest(`${reference}:${userId}`)}@retired.boardsesh.invalid`;
}

async function hasLiveLinks(transaction: Transaction, addresses: readonly string[]): Promise<boolean> {
  const identifiers = addresses.flatMap((address) => [address, `password-reset:${address}`]);
  const links = await transaction
    .select({ identifier: verificationTokens.identifier })
    .from(verificationTokens)
    .where(and(inArray(verificationTokens.identifier, identifiers), sql`${verificationTokens.expires} > now()`))
    .limit(1);
  return links.length !== 0;
}

/** Plan only: caller uses a READ ONLY transaction. No proposals select winners. */
export async function buildResolutionPlan(
  database: ResolutionDatabase,
  worksheet: EvidenceWorksheet,
  decisions: Decisions,
  options: {
    readonly evidenceSha256: string;
    readonly decisionsSha256: string;
    readonly targetFingerprint: string;
    readonly swapKeeper?: string;
    readonly now?: Date;
  },
): Promise<ResolutionPlan> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const groups: ResolutionGroup[] = [];
    const now = options.now ?? new Date();
    for (const decision of decisions.groups) {
      if (options.swapKeeper && decision.group !== options.swapKeeper) continue;
      const evidence = worksheet.groups.find((group) => group.group === decision.group);
      if (!evidence || !evidence.members.some((member) => member.member === decision.keeper))
        throw new EmailResolutionError('DECISION');
      if (evidence.kind === 'A' && decision.evidenceKind === 'batch-approved')
        throw new EmailResolutionError('DECISION');
      if (decision.evidenceKind === 'no-reply-14-days') {
        const contacted = decision.contactedAt ? Date.parse(decision.contactedAt) : NaN;
        if (
          !Number.isFinite(contacted) ||
          contacted > now.getTime() - 14 * 86400000 ||
          decision.keeper !== evidence.mostRecentlyActive
        )
          throw new EmailResolutionError('DECISION');
      }
      const reference = digest(`${options.evidenceSha256}:${evidence.group}`);
      const memberIds = evidence.members.map((member) => member.userId);
      const current = await transaction
        .select({ userId: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, memberIds));
      const history = await transaction
        .select()
        .from(authEmailResolutionLog)
        .where(eq(authEmailResolutionLog.groupReference, reference));
      const hasHistory = history.length !== 0;
      if (options.swapKeeper && !hasHistory) throw new EmailResolutionError('DECISION');
      const desired = evidence.members.map((member): ResolutionMember => ({
        userId: member.userId,
        before: current.find((row) => row.userId === member.userId)?.email ?? '',
        after: member.member === decision.keeper ? evidence.address : retiredAddress(reference, member.userId),
        action: member.member === decision.keeper ? 'keep' : 'retire',
      }));
      const normalizedOwners = await transaction
        .select({ userId: users.id })
        .from(users)
        .where(sql`${sqlNormalizedAccountEmail(users.email)} = ${evidence.address}`);
      const unexpectedOwner = normalizedOwners.some((row) => !memberIds.includes(row.userId));
      const matchesEvidence =
        current.length === memberIds.length &&
        evidence.members.every((member) =>
          current.some((row) => row.userId === member.userId && row.email === member.storedEmail),
        );
      const completed = current.length === desired.length && desired.every((member) => member.before === member.after);
      const validPrevious =
        hasHistory &&
        current.length === memberIds.length &&
        current.filter((row) => row.email === evidence.address).length === 1 &&
        current.every((row) => row.email === evidence.address || row.email === retiredAddress(reference, row.userId));
      let status: ResolutionGroup['status'] = 'ready';
      if (unexpectedOwner || (!matchesEvidence && !(options.swapKeeper && validPrevious)) || (completed && hasHistory))
        status = 'skipped';
      if (
        status === 'ready' &&
        (await hasLiveLinks(transaction, [...current.map((row) => row.email), evidence.address]))
      )
        status = 'deferred';
      groups.push({
        label: evidence.group,
        reference,
        address: evidence.address,
        evidenceKind: decision.evidenceKind,
        members: desired,
        status,
      });
    }
    if (options.swapKeeper && !decisions.groups.some((decision) => decision.group === options.swapKeeper))
      throw new EmailResolutionError('DECISION');
    if (decisions.normalizeStandalone && !options.swapKeeper) {
      const candidates = await transaction
        .select({ userId: users.id, email: users.email })
        .from(users)
        .where(sql`${users.email} <> ${sqlNormalizedAccountEmail(users.email)}`)
        .limit(100001);
      if (candidates.length > 100000) throw new EmailResolutionError('LIMIT');
      const grouped = new Set(worksheet.groups.flatMap((group) => group.members.map((member) => member.userId)));
      for (const candidate of candidates) {
        if (grouped.has(candidate.userId)) continue;
        const address = normalizeAccountEmail(candidate.email);
        const owners = await transaction
          .select({ userId: users.id })
          .from(users)
          .where(sql`${sqlNormalizedAccountEmail(users.email)} = ${address}`)
          .limit(2);
        const reference = digest(`${options.evidenceSha256}:standalone:${candidate.userId}`);
        const status =
          !address || /[^\x20-\x7e]/.test(address) || owners.length !== 1
            ? 'skipped'
            : (await hasLiveLinks(transaction, [candidate.email, address]))
              ? 'deferred'
              : 'ready';
        groups.push({
          label: `S${groups.length + 1}`,
          reference,
          address,
          evidenceKind: 'batch-approved',
          status,
          members: [{ userId: candidate.userId, before: candidate.email, after: address, action: 'normalize' }],
        });
      }
    }
    return {
      formatVersion: 1,
      document: 'boardsesh-account-email-resolution',
      batchId: randomUUID(),
      unselectedGroups: worksheet.groups.filter(
        (group) => !decisions.groups.some((decision) => decision.group === group.group),
      ).length,
      targetFingerprint: options.targetFingerprint,
      evidenceSha256: options.evidenceSha256,
      decisionsSha256: options.decisionsSha256,
      groups,
    };
  });
}

async function reconcileReservations(transaction: Transaction, group: ResolutionGroup): Promise<void> {
  const [manifest] = await transaction
    .select()
    .from(authEmailProjection)
    .where(eq(authEmailProjection.isCurrent, true));
  if (!manifest) return;
  // Caller holds the gate, every key, and users in that order. Reservation locks follow users.
  const keys = [
    ...new Set(group.members.flatMap((member) => [normalizeAccountEmail(member.before), member.after])),
  ].sort();
  const reservations = await transaction
    .select()
    .from(authEmailReservations)
    .where(inArray(authEmailReservations.normalizedEmail, keys))
    .orderBy(authEmailReservations.normalizedEmail)
    .for('update');
  if (reservations.some((reservation) => !['owned', 'blocked_ambiguous'].includes(reservation.state)))
    throw new EmailResolutionError('DRIFT');
  let addedKeys = 0;
  let removedAmbiguities = 0;
  let removedKeys = 0;
  for (const key of keys) {
    const owner = group.members.find((member) => member.after === key);
    const prior = reservations.find((reservation) => reservation.normalizedEmail === key);
    if (prior && prior.state === 'owned' && !group.members.some((member) => member.userId === prior.ownerUserId))
      throw new EmailResolutionError('DRIFT');
    if (!owner) {
      if (prior) {
        await transaction
          .delete(authEmailReservationMembers)
          .where(eq(authEmailReservationMembers.normalizedEmail, key));
        await transaction.delete(authEmailReservations).where(eq(authEmailReservations.normalizedEmail, key));
        removedKeys += 1;
        if (prior.state === 'blocked_ambiguous') removedAmbiguities += 1;
      }
      continue;
    }
    if (!prior) addedKeys += 1;
    if (prior?.state === 'blocked_ambiguous') removedAmbiguities += 1;
    await transaction.delete(authEmailReservationMembers).where(eq(authEmailReservationMembers.normalizedEmail, key));
    await transaction
      .insert(authEmailReservations)
      .values({
        normalizedEmail: key,
        basisProjectionId: manifest.projectionId,
        state: 'owned',
        ownerUserId: owner.userId,
      })
      .onConflictDoUpdate({
        target: authEmailReservations.normalizedEmail,
        set: { state: 'owned', ownerUserId: owner.userId },
      });
    await transaction.insert(authEmailReservationMembers).values({ normalizedEmail: key, userId: owner.userId });
  }
  if (addedKeys || removedKeys || removedAmbiguities)
    await transaction
      .update(authEmailProjection)
      .set({
        keyCount: sql`${authEmailProjection.keyCount} + ${addedKeys} - ${removedKeys}`,
        ambiguousKeyCount: sql`${authEmailProjection.ambiguousKeyCount} - ${removedAmbiguities}`,
      })
      .where(eq(authEmailProjection.projectionId, manifest.projectionId));
}

/** Each group commits atomically. Login credentials, sessions and product data are never changed. */
export async function applyResolutionPlan(database: ResolutionDatabase, plan: ResolutionPlan) {
  const counts = { applied: 0, skipped: 0, deferred: 0 };
  for (const group of plan.groups) {
    if (group.status !== 'ready') {
      counts[group.status] += 1;
      continue;
    }
    const result = await database.transaction(async (transaction): Promise<'applied' | 'skipped' | 'deferred'> => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '2000ms'`);
      await transaction.execute(sql`SET LOCAL statement_timeout = '10000ms'`);
      await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      const keys = [
        ...new Set(group.members.flatMap((member) => [normalizeAccountEmail(member.before), member.after])),
      ].sort();
      // Same namespace as lockEmailKeyForCreation. Multiple keys are sorted to prevent AB/BA waits.
      for (const key of keys)
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(${0x454d4b59}, hashtext(${key}))`);
      const memberIds = group.members.map((member) => member.userId);
      const current = await transaction
        .select({ userId: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, memberIds))
        .orderBy(users.id)
        .for('update');
      const logged = await transaction
        .select({ userId: authEmailResolutionLog.userId })
        .from(authEmailResolutionLog)
        .where(
          and(
            eq(authEmailResolutionLog.batchId, plan.batchId),
            eq(authEmailResolutionLog.groupReference, group.reference),
          ),
        );
      if (logged.length) return 'skipped';
      const owners = await transaction
        .select({ userId: users.id })
        .from(users)
        .where(sql`${sqlNormalizedAccountEmail(users.email)} = ${group.address}`);
      if (
        current.length !== group.members.length ||
        group.members.some(
          (member) => !current.some((row) => row.userId === member.userId && row.email === member.before),
        ) ||
        owners.some((owner) => !memberIds.includes(owner.userId))
      )
        return 'skipped';
      if (await hasLiveLinks(transaction, [...current.map((row) => row.email), group.address])) return 'deferred';
      await reconcileReservations(transaction, group);
      // Retire first: swapping also works after the unique email index has shipped.
      for (const member of [...group.members].sort(
        (left, right) => Number(left.action === 'keep') - Number(right.action === 'keep'),
      )) {
        await transaction
          .update(users)
          .set({ email: member.after, updatedAt: new Date() })
          .where(eq(users.id, member.userId));
        await transaction.insert(authEmailResolutionLog).values({
          batchId: plan.batchId,
          groupReference: group.reference,
          userId: member.userId,
          action: member.action,
          evidenceKind: group.evidenceKind,
        });
      }
      return 'applied';
    });
    counts[result] += 1;
  }
  return counts;
}
