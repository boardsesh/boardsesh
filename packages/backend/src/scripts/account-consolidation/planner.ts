import type { ConsolidationGroupState } from './state';
import { createHash } from 'node:crypto';
import type { EvidenceWorksheet, WorksheetGroup, WorksheetMember } from '../../auth/email-audit/evidence';

export type ConsolidationErrorCode =
  | 'COUPLED_GROUPS'
  | 'CONFIGURATION'
  | 'INVALID_EVIDENCE'
  | 'INPUT_LIMIT'
  | 'UNSAFE_PLAN'
  | 'DATABASE'
  | 'PRIVATE_FILE';
export class ConsolidationError extends Error {
  constructor(readonly code: ConsolidationErrorCode) {
    super('Account consolidation could not complete.');
    this.name = 'ConsolidationError';
  }
}

/** Noncredential facts; timestamps and bigint IDs retain the database's exact text. */
export interface ConsolidationTick {
  readonly rowFingerprint: string;
  readonly id: string;
  readonly uuid: string;
  readonly userId: string;
  readonly boardType: string;
  readonly climbUuid: string;
  readonly angle: number;
  readonly climbedAt: string;
  readonly isMirror: boolean | null;
  readonly status: 'flash' | 'send' | 'attempt';
  readonly attemptCount: number;
  readonly quality: number | null;
  readonly difficulty: number | null;
  readonly isBenchmark: boolean | null;
  readonly comment: string | null;
  readonly climbRevision: number | null;
  readonly origin: string;
  readonly sessionId: string | null;
  readonly sessionOrigin: 'explicit' | 'inferred' | null;
  readonly boardId: string | null;
  readonly auroraId: string | null;
  readonly auroraType: string | null;
  readonly kilterId: string | null;
  readonly kilterType: string | null;
  readonly kilterDetachedAt: string | null;
  readonly updatedAt: string;
}
export interface TickConsolidation {
  readonly retainedUuid: string;
  readonly retiredUuid: string;
  readonly retainedId: string;
  readonly retiredId: string;
  readonly beforeFingerprints: readonly string[];
  readonly sourceSessionIds: readonly string[];
  readonly auroraIds: readonly string[];
  readonly kilterIds: readonly string[];
  readonly resultingLinkage: {
    readonly boardId: string | null;
    readonly auroraId: string | null;
    readonly auroraType: string | null;
    readonly kilterId: string | null;
    readonly kilterType: string | null;
    readonly origin: string;
  };
}
export interface ConsolidationGroupPlan {
  readonly group: string;
  readonly normalizedEmail: string;
  readonly memberUserIds: readonly string[];
  readonly survivorUserId: string | null;
  readonly sourceUserIds: readonly string[];
  readonly survivorPolicy: 'unique-lowercase' | 'seven-lowercase-google-data-holder' | null;
  readonly password: 'retain-survivor-only' | 'provider-only' | 'unresolved';
  readonly preserveProviderLinks: readonly { readonly fromUserId: string; readonly providers: readonly string[] }[];
  readonly memberFingerprint: string;
  readonly referenceState?: ConsolidationGroupState | null;
  readonly tickMerges: readonly TickConsolidation[];
  readonly blockers: readonly string[];
}
export interface AccountConsolidationPlan {
  readonly formatVersion: 1;
  readonly document: 'boardsesh-account-consolidation-plan';
  readonly sourceEvidenceSha256: string;
  readonly snapshot: EvidenceWorksheet['snapshot'];
  readonly policyVersion: 'lowercase-consolidation-fresh-signin-v2';
  readonly sourceAuthentication: 'fresh-signin-required';
  readonly groups: readonly ConsolidationGroupPlan[];
  readonly execution: {
    readonly codeAvailable: true;
    readonly available: false;
    readonly requiredCapabilities: readonly string[];
  };
  readonly summary: {
    readonly groups: number;
    readonly members: number;
    readonly survivorsSelected: number;
    readonly sourcesSelected: number;
    readonly duplicateTickPairs: number;
    readonly groupsWithDataBlockers: number;
    readonly readyToApply: 0;
  };
}

export function consolidationDigest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}
function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function orderedMembers(group: WorksheetGroup): WorksheetMember[] {
  return [...group.members].sort((left, right) => compareText(left.userId, right.userId));
}
export interface ApprovedConsolidationException {
  readonly normalizedEmail: string;
  readonly survivorUserId: string;
  readonly memberUserIds: readonly string[];
}
function chooseSurvivor(
  group: WorksheetGroup,
  approvedExceptions: readonly ApprovedConsolidationException[],
): { member: WorksheetMember; policy: NonNullable<ConsolidationGroupPlan['survivorPolicy']> } | null {
  const lowercase = group.members.filter((member) => member.storedEmail === group.address);
  if (lowercase.length === 1) return { member: lowercase[0], policy: 'unique-lowercase' };
  // The owner approved this exact exceptional shape, not a mutable worksheet label.
  if (group.members.length !== 7 || lowercase.length !== 7) return null;
  const approval = approvedExceptions.find((exception) => exception.normalizedEmail === group.address);
  if (
    !approval ||
    JSON.stringify([...approval.memberUserIds].sort(compareText)) !==
      JSON.stringify(group.members.map((member) => member.userId).sort(compareText))
  )
    return null;
  const googleData = group.members.filter((member) => member.hasOwnData && member.providers.includes('google'));
  if (googleData.length !== 1) return null;
  const survivor = googleData[0];
  if (survivor.userId !== approval.survivorUserId) return null;
  if (
    group.members.some(
      (member) => member !== survivor && (member.hasOwnData || !member.hasPassword || member.providers.length !== 0),
    )
  )
    return null;
  return { member: survivor, policy: 'seven-lowercase-google-data-holder' };
}
function payload(tick: ConsolidationTick) {
  return [
    tick.boardType,
    tick.climbUuid,
    tick.angle,
    tick.climbedAt,
    tick.isMirror ?? false,
    tick.status,
    tick.attemptCount,
    tick.quality,
    tick.difficulty,
    tick.isBenchmark ?? false,
    tick.comment ?? '',
    tick.climbRevision,
  ];
}
export function fingerprintConsolidationTick(tick: ConsolidationTick): string {
  return consolidationDigest(
    JSON.stringify([
      tick.rowFingerprint,
      tick.id,
      tick.uuid,
      tick.userId,
      [
        tick.boardType,
        tick.climbUuid,
        tick.angle,
        tick.climbedAt,
        tick.isMirror,
        tick.status,
        tick.attemptCount,
        tick.quality,
        tick.difficulty,
        tick.isBenchmark,
        tick.comment,
        tick.climbRevision,
      ],
      tick.origin,
      tick.sessionId,
      tick.sessionOrigin,
      tick.boardId,
      tick.auroraId,
      tick.auroraType,
      tick.kilterId,
      tick.kilterType,
      tick.kilterDetachedAt,
      tick.updatedAt,
    ]),
  );
}
function uniqueText(entries: readonly (string | null)[]): string[] {
  return [...new Set(entries.filter((entry): entry is string => entry !== null))].sort(compareText);
}

export function buildAccountConsolidationPlan(
  worksheet: EvidenceWorksheet,
  ticks: readonly ConsolidationTick[],
  options: {
    readonly evidenceSha256: string;
    readonly approvedExceptions?: readonly ApprovedConsolidationException[];
    readonly referenceStates?: ReadonlyMap<string, ConsolidationGroupState>;
  },
): AccountConsolidationPlan {
  if (
    worksheet.document !== 'boardsesh-account-email-evidence' ||
    worksheet.formatVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(options.evidenceSha256) ||
    Object.values(worksheet.summary.checks).some((passed) => passed !== true)
  )
    throw new ConsolidationError('INVALID_EVIDENCE');
  if (worksheet.groups.length > 1000 || ticks.length > 100000) throw new ConsolidationError('INPUT_LIMIT');
  const userGroups = new Map<string, string>();
  const groupAddresses = new Set<string>();
  for (const group of worksheet.groups) {
    if (
      !group.address ||
      group.address !== group.address.trim().toLowerCase() ||
      groupAddresses.has(group.address) ||
      group.members.length < 2 ||
      group.members.length > 1000
    )
      throw new ConsolidationError('INVALID_EVIDENCE');
    groupAddresses.add(group.address);
    for (const member of group.members) {
      if (!member.userId || userGroups.has(member.userId) || member.storedEmail.trim().toLowerCase() !== group.address)
        throw new ConsolidationError('INVALID_EVIDENCE');
      userGroups.set(member.userId, group.address);
    }
  }
  const tickUuids = new Set<string>();
  const tickIds = new Set<string>();
  const ticksByAddress = new Map<string, ConsolidationTick[]>();
  for (const tick of ticks) {
    const address = userGroups.get(tick.userId);
    if (
      !address ||
      !/^[a-f0-9]{64}$/.test(tick.rowFingerprint) ||
      !/^[1-9]\d*$/.test(tick.id) ||
      !tick.uuid ||
      tickUuids.has(tick.uuid) ||
      tickIds.has(tick.id) ||
      !Number.isSafeInteger(tick.angle) ||
      !Number.isSafeInteger(tick.attemptCount) ||
      tick.attemptCount < 1 ||
      !tick.climbedAt ||
      !tick.updatedAt
    )
      throw new ConsolidationError('INVALID_EVIDENCE');
    tickIds.add(tick.id);
    tickUuids.add(tick.uuid);
    const entries = ticksByAddress.get(address) ?? [];
    entries.push(tick);
    ticksByAddress.set(address, entries);
  }
  const groups = [...worksheet.groups]
    .sort((left, right) => compareText(left.address, right.address))
    .map((group): ConsolidationGroupPlan => {
      const selected = chooseSurvivor(group, options.approvedExceptions ?? []);
      const members = orderedMembers(group);
      const blockers: string[] = [];
      if (!selected) blockers.push('SURVIVOR_AMBIGUOUS');
      const groupTicks = ticksByAddress.get(group.address) ?? [];
      const expectedTicks = members.reduce(
        (total, member) => total + (member.ownData.rows['public.boardsesh_ticks.user_id'] ?? 0),
        0,
      );
      if (groupTicks.length !== expectedTicks) throw new ConsolidationError('INVALID_EVIDENCE');
      const byEvent = new Map<string, ConsolidationTick[]>();
      for (const tick of groupTicks) {
        const key = JSON.stringify([tick.boardType, tick.climbUuid, tick.angle, tick.climbedAt]);
        const entries = byEvent.get(key) ?? [];
        entries.push(tick);
        byEvent.set(key, entries);
      }
      const tickMerges: TickConsolidation[] = [];
      for (const [, eventTicks] of [...byEvent].sort(([left], [right]) => compareText(left, right))) {
        if (new Set(eventTicks.map((tick) => tick.userId)).size < 2) continue;
        if (eventTicks.length !== 2) {
          blockers.push('AMBIGUOUS_TICK_MULTIPLICITY');
          continue;
        }
        if (new Set(eventTicks.map((tick) => JSON.stringify(payload(tick)))).size !== 1) {
          blockers.push('TICK_PAYLOAD_CONFLICT');
          continue;
        }
        const realAurora = uniqueText(
          eventTicks.map((tick) => (tick.auroraId?.startsWith('json-import-') ? null : tick.auroraId)),
        );
        if (
          realAurora.length > 1 ||
          uniqueText(eventTicks.map((tick) => tick.kilterId)).length > 1 ||
          new Set(eventTicks.map((tick) => tick.origin)).size > 1 ||
          uniqueText(eventTicks.map((tick) => tick.boardId)).length > 1 ||
          uniqueText(eventTicks.map((tick) => tick.auroraType)).length > 1 ||
          uniqueText(eventTicks.map((tick) => tick.kilterType)).length > 1 ||
          eventTicks.some((tick) => tick.kilterDetachedAt !== null)
        ) {
          blockers.push('TICK_LINKAGE_CONFLICT');
          continue;
        }
        if (
          uniqueText(eventTicks.map((tick) => tick.sessionId)).length > 1 &&
          eventTicks.some(
            (tick) => tick.sessionOrigin === 'explicit' || (tick.sessionId !== null && tick.sessionOrigin === null),
          )
        ) {
          blockers.push('EXPLICIT_SESSION_CONFLICT');
          continue;
        }
        if (!selected) continue;
        const ordered = [...eventTicks].sort((left, right) => {
          const preferred =
            Number(right.userId === selected.member.userId) - Number(left.userId === selected.member.userId);
          return (
            preferred ||
            (BigInt(left.id) < BigInt(right.id)
              ? -1
              : BigInt(left.id) > BigInt(right.id)
                ? 1
                : compareText(left.uuid, right.uuid))
          );
        });
        const [retained, retired] = ordered;
        tickMerges.push({
          retainedUuid: retained.uuid,
          retiredUuid: retired.uuid,
          retainedId: retained.id,
          retiredId: retired.id,
          beforeFingerprints: ordered.map(fingerprintConsolidationTick),
          sourceSessionIds: uniqueText(ordered.map((tick) => tick.sessionId)),
          auroraIds: uniqueText(ordered.map((tick) => tick.auroraId)),
          kilterIds: uniqueText(ordered.map((tick) => tick.kilterId)),
          resultingLinkage: {
            boardId: uniqueText(ordered.map((tick) => tick.boardId))[0] ?? null,
            auroraId: realAurora[0] ?? retained.auroraId ?? retired.auroraId,
            auroraType: uniqueText(ordered.map((tick) => tick.auroraType))[0] ?? null,
            kilterId: uniqueText(ordered.map((tick) => tick.kilterId))[0] ?? null,
            kilterType: uniqueText(ordered.map((tick) => tick.kilterType))[0] ?? null,
            origin: retained.origin,
          },
        });
      }
      return {
        group: group.group,
        normalizedEmail: group.address,
        memberUserIds: members.map((member) => member.userId),
        survivorUserId: selected?.member.userId ?? null,
        sourceUserIds: selected
          ? members.filter((member) => member.userId !== selected.member.userId).map((member) => member.userId)
          : [],
        survivorPolicy: selected?.policy ?? null,
        password: !selected ? 'unresolved' : selected.member.hasPassword ? 'retain-survivor-only' : 'provider-only',
        preserveProviderLinks: members
          .filter((member) => member.providers.some((provider) => provider === 'google' || provider === 'apple'))
          .map((member) => ({
            fromUserId: member.userId,
            providers: member.providers
              .filter((provider) => provider === 'google' || provider === 'apple')
              .sort(compareText),
          })),
        referenceState: options.referenceStates?.get(group.address) ?? null,
        memberFingerprint: consolidationDigest(
          JSON.stringify(
            members.map((member) => [
              member.userId,
              member.storedEmail,
              member.hasPassword,
              member.providers,
              member.ownData,
              member.excludedRows,
              member.pendingLinks,
              member.roles,
            ]),
          ),
        ),
        tickMerges,
        blockers: [...new Set(blockers)].sort(compareText),
      };
    });
  return {
    formatVersion: 1,
    document: 'boardsesh-account-consolidation-plan',
    sourceEvidenceSha256: options.evidenceSha256,
    snapshot: worksheet.snapshot,
    policyVersion: 'lowercase-consolidation-fresh-signin-v2',
    sourceAuthentication: 'fresh-signin-required',
    groups,
    execution: {
      codeAvailable: true,
      available: false,
      requiredCapabilities: [
        'TRANSACTIONAL_REFERENCE_HANDLERS',
        'SOURCE_CREDENTIAL_RETIREMENT_AND_FRESH_SIGNIN',
        'IMPORT_AND_TICK_ALIAS_HANDLERS',
        'SESSION_AND_PRIVACY_RECONCILIATION',
        'VERIFIED_WRITER_DRAIN',
        'RESTORED_DATABASE_REHEARSAL',
      ],
    },
    summary: {
      groups: groups.length,
      members: userGroups.size,
      survivorsSelected: groups.filter((group) => group.survivorUserId !== null).length,
      sourcesSelected: groups
        .filter((group) => group.survivorUserId !== null)
        .reduce((total, group) => total + group.sourceUserIds.length, 0),
      duplicateTickPairs: groups.reduce((total, group) => total + group.tickMerges.length, 0),
      groupsWithDataBlockers: groups.filter((group) => group.blockers.length > 0).length,
      readyToApply: 0,
    },
  };
}
export function fingerprintConsolidationPlan(plan: AccountConsolidationPlan): string {
  return consolidationDigest(`${JSON.stringify(plan, null, 2)}\n`);
}
