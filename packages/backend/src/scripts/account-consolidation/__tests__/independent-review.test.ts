import { describe, expect, it } from 'vite-plus/test';
import {
  buildAccountEmailEvidence,
  type CollectedEvidence,
  type EvidenceMemberFacts,
} from '../../../auth/email-audit/evidence';
import {
  buildAccountConsolidationPlan,
  fingerprintConsolidationPlan,
  fingerprintConsolidationTick,
  type ConsolidationTick,
} from '../planner';

const ADDRESS = 'consolidation-review@example.test';
const EVIDENCE_SHA = 'a'.repeat(64);

type MemberInput = {
  readonly id: string;
  readonly email: string;
  readonly ticks: number;
  readonly providers?: readonly string[];
  readonly password?: boolean;
};
function worksheet(members: readonly MemberInput[]) {
  const facts = new Map<string, EvidenceMemberFacts>(
    members.map((member) => [
      member.id,
      {
        userId: member.id,
        name: 'Synthetic review',
        profileDisplayName: null,
        joinedAt: '2026-01-01 00:00:00',
        emailVerifiedAt: null,
        verifiedStamp: 'none',
        stampedLaterWhileVerificationRequired: false,
        hasPassword: member.password ?? true,
        providers: member.providers ?? [],
        liveRefreshTokens: 0,
        lastActiveDay: null,
        lastTickAt: null,
        communityRoles: [],
        gymsOwned: 0,
        gymAdminMemberships: 0,
        pendingLinks: { legacyReset: 0, legacyVerify: 0, stagedRecovery: 0, stagedVerification: 0 },
        stagedVerificationCompleted: false,
        rowsByColumn: Object.fromEntries(member.ticks ? [['public.boardsesh_ticks.user_id', member.ticks]] : []),
      },
    ]),
  );
  const evidence: CollectedEvidence = {
    snapshot: {
      startedAt: '2026-11-11T00:00:00.000Z',
      target: 'standby',
      isolation: 'repeatable read',
      readOnly: true,
      replayAgeSeconds: 0.1,
      serverVersion: '180006',
      targetFingerprint: 'f'.repeat(64),
    },
    referencingColumns: [{ schema: 'public', table: 'boardsesh_ticks', column: 'user_id', indexed: true }],
    users: members.map((member) => ({
      userId: member.id,
      email: member.email,
      sqlLower: member.email.toLowerCase(),
      sqlLowerTwice: member.email.toLowerCase(),
    })),
    members: facts,
    usersWithoutLoginMethod: 3,
    fixedSystemAccountsWithoutLogin: 3,
  };
  return buildAccountEmailEvidence(evidence).worksheet;
}
function tick(id: string, userId: string, extra: Partial<ConsolidationTick> = {}): ConsolidationTick {
  return {
    rowFingerprint: '0'.repeat(64),
    id,
    uuid: `review-tick-${id}`,
    userId,
    boardType: 'tension',
    climbUuid: 'review-climb',
    angle: 40,
    climbedAt: '2026-11-11 12:00:00',
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    quality: null,
    difficulty: null,
    isBenchmark: false,
    comment: '',
    climbRevision: null,
    origin: 'native',
    sessionId: null,
    sessionOrigin: null,
    boardId: null,
    auroraId: null,
    auroraType: null,
    kilterId: null,
    kilterType: null,
    kilterDetachedAt: null,
    updatedAt: '2026-11-11 12:00:00',
    ...extra,
  };
}
function pairWorksheet() {
  return worksheet([
    { id: 'canonical', email: ADDRESS, ticks: 1 },
    { id: 'source', email: ADDRESS.toUpperCase(), ticks: 1 },
  ]);
}

describe('independent consolidation planner review', () => {
  it('retains the unique existing lowercase owner and never advertises execution readiness', () => {
    const plan = buildAccountConsolidationPlan(pairWorksheet(), [tick('1', 'source'), tick('2', 'canonical')], {
      evidenceSha256: EVIDENCE_SHA,
    });
    expect(plan.groups[0]).toMatchObject({
      survivorUserId: 'canonical',
      sourceUserIds: ['source'],
      password: 'retain-survivor-only',
    });
    expect(plan.groups[0]?.tickMerges[0]).toMatchObject({
      retainedUuid: 'review-tick-2',
      retiredUuid: 'review-tick-1',
    });
    expect(plan.execution.available).toBe(false);
    expect(plan.summary.readyToApply).toBe(0);
  });

  it('does not infer approval for a seven-member semantic lookalike group', () => {
    const members: MemberInput[] = Array.from({ length: 7 }, (_, index) => ({
      id: `review-member-${index}`,
      email: ADDRESS,
      ticks: index === 0 ? 1 : 0,
      providers: index === 0 ? ['google'] : [],
      password: index !== 0,
    }));
    const evidence = worksheet(members);
    const rows = [tick('1', members[0]!.id)];
    const unapproved = buildAccountConsolidationPlan(evidence, rows, { evidenceSha256: EVIDENCE_SHA });
    expect(unapproved.groups[0]?.survivorUserId).toBeNull();
    expect(unapproved.groups[0]?.blockers).toContain('SURVIVOR_AMBIGUOUS');
    const incorrectMembership = buildAccountConsolidationPlan(evidence, rows, {
      evidenceSha256: EVIDENCE_SHA,
      approvedExceptions: [
        {
          normalizedEmail: ADDRESS,
          survivorUserId: members[0]!.id,
          memberUserIds: members.slice(0, 6).map((member) => member.id),
        },
      ],
    });
    expect(incorrectMembership.groups[0]?.survivorUserId).toBeNull();
    const approved = buildAccountConsolidationPlan(evidence, rows, {
      evidenceSha256: EVIDENCE_SHA,
      approvedExceptions: [
        {
          normalizedEmail: ADDRESS,
          survivorUserId: members[0]!.id,
          memberUserIds: members.map((member) => member.id),
        },
      ],
    });
    expect(approved.groups[0]).toMatchObject({ survivorUserId: members[0]!.id, password: 'provider-only' });
  });

  it('refuses omitted ticks and duplicate record identities rather than producing a partial plan', () => {
    expect(() =>
      buildAccountConsolidationPlan(pairWorksheet(), [tick('1', 'canonical')], { evidenceSha256: EVIDENCE_SHA }),
    ).toThrow();
    expect(() =>
      buildAccountConsolidationPlan(pairWorksheet(), [tick('1', 'canonical'), tick('1', 'source')], {
        evidenceSha256: EVIDENCE_SHA,
      }),
    ).toThrow();
  });

  it('keeps a payload conflict out of automatic tick consolidation', () => {
    const plan = buildAccountConsolidationPlan(
      pairWorksheet(),
      [tick('1', 'canonical'), tick('2', 'source', { status: 'attempt' })],
      { evidenceSha256: EVIDENCE_SHA },
    );
    expect(plan.groups[0]?.tickMerges).toEqual([]);
    expect(plan.groups[0]?.blockers).toContain('TICK_PAYLOAD_CONFLICT');
  });

  it.each([
    ['auroraType', 'ascents', 'bids'],
    ['kilterType', 'logs', 'attempts'],
  ] as const)('refuses mismatched upstream type field %s', (field, firstType, secondType) => {
    const plan = buildAccountConsolidationPlan(
      pairWorksheet(),
      [tick('1', 'canonical', { [field]: firstType }), tick('2', 'source', { [field]: secondType })],
      { evidenceSha256: EVIDENCE_SHA },
    );
    expect(plan.groups[0]?.tickMerges).toEqual([]);
    expect(plan.groups[0]?.blockers).toContain('TICK_LINKAGE_CONFLICT');
  });

  it('fingerprints exact nullable source fields even when semantic payloads compare equally', () => {
    const original = tick('1', 'canonical', { comment: null, isMirror: null, isBenchmark: null });
    for (const changed of [{ comment: '' }, { isMirror: false }, { isBenchmark: false }]) {
      expect(fingerprintConsolidationTick({ ...original, ...changed })).not.toBe(
        fingerprintConsolidationTick(original),
      );
    }
  });

  it('produces the same plan fingerprint for differently ordered identical input rows', () => {
    const evidence = pairWorksheet();
    const first = tick('1', 'canonical');
    const second = tick('2', 'source');
    const forward = buildAccountConsolidationPlan(evidence, [first, second], { evidenceSha256: EVIDENCE_SHA });
    const reverse = buildAccountConsolidationPlan(evidence, [second, first], { evidenceSha256: EVIDENCE_SHA });
    expect(fingerprintConsolidationPlan(forward)).toBe(fingerprintConsolidationPlan(reverse));
  });
});
