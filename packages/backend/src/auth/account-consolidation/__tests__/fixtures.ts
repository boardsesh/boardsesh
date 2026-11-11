import {
  buildAccountEmailEvidence,
  type EvidenceMemberFacts,
  type CollectedEvidence,
} from '../../email-audit/evidence';
import type { ConsolidationTick } from '../planner';
export interface MemberSpec {
  userId: string;
  email: string;
  password?: boolean;
  providers?: string[];
  ticks?: number;
  otherData?: boolean;
}
export function evidenceFixture(members: MemberSpec[]) {
  const facts = members.map((member): [string, EvidenceMemberFacts] => [
    member.userId,
    {
      userId: member.userId,
      name: 'Synthetic',
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
      rowsByColumn: {
        ...(member.ticks ? { 'public.boardsesh_ticks.user_id': member.ticks } : {}),
        ...(member.otherData ? { 'public.board_sessions.created_by_user_id': 1 } : {}),
      },
    },
  ]);
  const collected: CollectedEvidence = {
    snapshot: {
      startedAt: '2026-11-11T00:00:00.000Z',
      target: 'standby',
      isolation: 'repeatable read',
      readOnly: true,
      replayAgeSeconds: 0.1,
      serverVersion: '180006',
      targetFingerprint: 'f'.repeat(64),
    },
    referencingColumns: [
      { schema: 'public', table: 'boardsesh_ticks', column: 'user_id', indexed: true },
      { schema: 'public', table: 'board_sessions', column: 'created_by_user_id', indexed: true },
    ],
    users: members.map((member) => ({
      userId: member.userId,
      email: member.email,
      sqlLower: member.email.toLowerCase(),
      sqlLowerTwice: member.email.toLowerCase(),
    })),
    members: new Map(facts),
    usersWithoutLoginMethod: 3,
    fixedSystemAccountsWithoutLogin: 3,
  };
  return buildAccountEmailEvidence(collected).worksheet;
}
export function tickFixture(overrides: Partial<ConsolidationTick> = {}): ConsolidationTick {
  return {
    rowFingerprint: '0'.repeat(64),
    id: '1',
    uuid: 'tick-one',
    userId: 'canonical',
    boardType: 'tension',
    climbUuid: 'synthetic-climb',
    angle: 40,
    climbedAt: '2026-01-01 12:00:00.000001',
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: 3,
    difficulty: 16,
    isBenchmark: false,
    comment: '',
    climbRevision: null,
    origin: 'json_import',
    sessionId: 'session-one',
    sessionOrigin: 'inferred',
    boardId: null,
    auroraId: 'json-import-one',
    auroraType: 'ascents',
    kilterId: null,
    kilterType: null,
    kilterDetachedAt: null,
    updatedAt: '2026-01-01 12:00:00.000001',
    ...overrides,
  };
}
