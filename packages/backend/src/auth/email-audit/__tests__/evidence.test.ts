import { describe, expect, it } from 'vite-plus/test';
import {
  AccountEmailEvidenceError,
  assertEvidenceSession,
  buildAccountEmailEvidence,
  classifyGroup,
  FIXED_SYSTEM_ACCOUNT_IDS,
  OWN_DATA_RULES,
  referencingColumnRole,
  referencingRowKeyRoles,
  type CollectedEvidence,
  type EvidenceMemberFacts,
  type EvidenceUserRow,
  type ReferencingColumn,
} from '../evidence';

// Synthetic only: no real address, ID or name.
const COLUMNS: ReferencingColumn[] = [
  { schema: 'public', table: 'boardsesh_ticks', column: 'user_id', indexed: true },
  { schema: 'public', table: 'playlists', column: 'owner_id', indexed: false },
  { schema: 'public', table: 'user_follows', column: 'follower_id', indexed: true },
  { schema: 'public', table: 'user_follows', column: 'following_id', indexed: true },
  { schema: 'public', table: 'feed_items', column: 'actor_id', indexed: false },
  { schema: 'public', table: 'feed_items', column: 'recipient_id', indexed: true },
  { schema: 'public', table: 'notifications', column: 'recipient_id', indexed: true },
  { schema: 'public', table: 'user_climb_percentiles', column: 'user_id', indexed: true },
  { schema: 'public', table: 'user_profiles', column: 'user_id', indexed: true },
  { schema: 'public', table: 'auth_password_recovery_tokens', column: 'user_id', indexed: false },
  { schema: 'public', table: 'oauth_grants', column: 'user_id', indexed: false },
  { schema: 'public', table: 'user_follow_requests', column: 'recipient_id', indexed: true },
  { schema: 'public', table: 'user_follow_requests', column: 'requester_id', indexed: false },
  { schema: 'public', table: 'community_roles', column: 'user_id', indexed: false },
  { schema: 'public', table: 'community_roles', column: 'granted_by', indexed: false },
  { schema: 'public', table: 'resource_grants', column: 'user_id', indexed: true },
];
const PENDING_INVITE = 'public.resource_grants.user_id:pending-invite';

const TICKS = 'public.boardsesh_ticks.user_id';
const PERCENTILES = 'public.user_climb_percentiles.user_id';
const PROFILES = 'public.user_profiles.user_id';

interface MemberShape {
  readonly id: string;
  readonly email: string;
  readonly joinedAt: string;
  readonly data?: boolean;
  readonly stamped?: boolean;
  readonly password?: boolean;
  readonly providers?: readonly string[];
  readonly liveTokens?: number;
  readonly rows?: Readonly<Record<string, number>>;
  readonly facts?: Partial<EvidenceMemberFacts>;
}

function memberFacts(shape: MemberShape): EvidenceMemberFacts {
  return {
    userId: shape.id,
    name: `Name ${shape.id}`,
    profileDisplayName: `Climber ${shape.id}`,
    joinedAt: shape.joinedAt,
    emailVerifiedAt: shape.stamped ? shape.joinedAt : null,
    verifiedStamp: shape.stamped ? 'at_signup' : 'none',
    stampedLaterWhileVerificationRequired: false,
    hasPassword: shape.password ?? true,
    providers: shape.providers ?? [],
    liveRefreshTokens: shape.liveTokens ?? 0,
    lastActiveDay: null,
    lastTickAt: null,
    communityRoles: [],
    gymsOwned: 0,
    gymAdminMemberships: 0,
    pendingLinks: { legacyReset: 0, legacyVerify: 0, stagedRecovery: 0, stagedVerification: 0 },
    stagedVerificationCompleted: false,
    // Like production: every user has a percentile row and a profile.
    rowsByColumn: { [PERCENTILES]: 1, [PROFILES]: 1, ...(shape.data ? { [TICKS]: 4 } : {}), ...shape.rows },
    ...shape.facts,
  };
}

function collect(
  groups: readonly (readonly MemberShape[])[],
  extra: Partial<Omit<CollectedEvidence, 'members' | 'users'>> & { readonly users?: readonly EvidenceUserRow[] } = {},
): CollectedEvidence {
  const shapes = groups.flat();
  const users = [
    ...shapes.map((shape) => ({
      userId: shape.id,
      email: shape.email,
      sqlLower: shape.email.toLowerCase(),
      sqlLowerTwice: shape.email.toLowerCase(),
    })),
    ...(extra.users ?? []),
  ];
  return {
    snapshot: {
      startedAt: '2026-11-11T00:00:00.000Z',
      target: 'standby',
      isolation: 'repeatable read',
      readOnly: true,
      replayAgeSeconds: 0.2,
      serverVersion: '180006',
      targetFingerprint: 'f'.repeat(64),
    },
    referencingColumns: COLUMNS,
    usersWithoutLoginMethod: FIXED_SYSTEM_ACCOUNT_IDS.length,
    fixedSystemAccountsWithoutLogin: FIXED_SYSTEM_ACCOUNT_IDS.length,
    ...extra,
    users,
    members: new Map(shapes.map((shape) => [shape.id, memberFacts(shape)])),
  };
}

let sequence = 0;
/** A two-member group on a fresh synthetic address; the first member joined first. */
function pair(
  first: Omit<MemberShape, 'id' | 'email' | 'joinedAt'>,
  second: Omit<MemberShape, 'id' | 'email' | 'joinedAt'>,
) {
  sequence += 1;
  const local = `pair${String(sequence).padStart(3, '0')}`;
  return [
    { id: `${local}-a`, email: `${local}@example.test`, joinedAt: '2026-02-01 10:00:00', ...first },
    { id: `${local}-b`, email: `${local.toUpperCase()}@Example.test`, joinedAt: '2026-05-01 10:00:00', ...second },
  ];
}

function onlyGroup(collected: CollectedEvidence) {
  const { worksheet } = buildAccountEmailEvidence(collected);
  expect(worksheet.groups).toHaveLength(1);
  const [group] = worksheet.groups;
  if (!group) throw new Error('Expected one group.');
  return group;
}

describe('own-data rules', () => {
  it('treats housekeeping, derived and caused-by-others columns as excluded and everything else as own data', () => {
    const roles = Object.fromEntries(
      COLUMNS.map((column) => [`${column.table}.${column.column}`, referencingColumnRole(column)]),
    );
    expect(roles).toEqual({
      'boardsesh_ticks.user_id': 'own-data',
      'playlists.owner_id': 'own-data',
      'user_follows.follower_id': 'own-data',
      'user_follows.following_id': 'caused-by-others',
      'feed_items.actor_id': 'own-data',
      'feed_items.recipient_id': 'caused-by-others',
      'notifications.recipient_id': 'caused-by-others',
      'user_climb_percentiles.user_id': 'derived',
      'user_profiles.user_id': 'housekeeping',
      'auth_password_recovery_tokens.user_id': 'housekeeping',
      'oauth_grants.user_id': 'housekeeping',
      'user_follow_requests.recipient_id': 'caused-by-others',
      'user_follow_requests.requester_id': 'own-data',
      'community_roles.user_id': 'caused-by-others',
      'community_roles.granted_by': 'own-data',
      'resource_grants.user_id': 'own-data',
    });
    // A pending invite from someone else is split out of resource_grants and excluded; other grants stay own data.
    const rowKeys = referencingRowKeyRoles(COLUMNS);
    expect(rowKeys.get(PENDING_INVITE)?.role).toBe('caused-by-others');
    expect(rowKeys.get('public.resource_grants.user_id')?.role).toBe('own-data');
    expect(rowKeys.has('public.boardsesh_ticks.user_id:pending-invite')).toBe(false);
    // A table nobody listed is own data, so a new table counts by default.
    expect(referencingColumnRole({ table: 'trip_reports', column: 'author_id' })).toBe('own-data');
  });

  it('keeps a member with only excluded rows empty and still shows those rows', () => {
    const group = onlyGroup(
      collect([
        pair(
          { data: true, stamped: true },
          {
            rows: {
              'public.feed_items.recipient_id': 9,
              'public.notifications.recipient_id': 3,
              'public.user_follows.following_id': 2,
              'public.auth_password_recovery_tokens.user_id': 1,
              'public.oauth_grants.user_id': 1,
            },
          },
        ),
      ]),
    );
    expect(group.kind).toBe('C');
    const empty = group.members[1];
    expect(empty?.hasOwnData).toBe(false);
    expect(empty?.ownData.rows).toEqual({});
    expect(empty?.excludedRows).toMatchObject({
      [PERCENTILES]: 1,
      [PROFILES]: 1,
      'public.feed_items.recipient_id': 9,
      'public.user_follows.following_id': 2,
    });
  });

  it('sorts own rows into the worksheet categories', () => {
    const group = onlyGroup(
      collect([
        pair(
          {
            data: true,
            rows: {
              'public.playlists.owner_id': 2,
              'public.user_follows.follower_id': 5,
              'public.feed_items.actor_id': 7,
            },
          },
          { data: true },
        ),
      ]),
    );
    expect(group.members[0]?.ownData.summary).toEqual({
      ticks: 4,
      playlists: 2,
      climbsSet: 0,
      wallsAndBoards: 0,
      followsGiven: 5,
      sessions: 0,
      other: 7,
    });
  });
});

describe('group kinds', () => {
  it('A: two members with own data get the contact email and no proposed keeper', () => {
    const collected = collect([pair({ data: true, stamped: true }, { data: true })]);
    const { worksheet, summary } = buildAccountEmailEvidence(collected);
    const [group] = worksheet.groups;
    expect(group).toMatchObject({
      group: 'G01',
      kind: 'A',
      proposal: { contact: true, keep: null, retireAddress: [] },
    });
    expect(summary.contactEmails).toBe(1);
    expect(worksheet.contactList).toEqual([
      {
        group: 'G01',
        address: group?.address,
        members: [
          { member: 'A', displayName: expect.stringContaining('Climber'), joined: '2026-02' },
          { member: 'B', displayName: expect.stringContaining('Climber'), joined: '2026-05' },
        ],
      },
    ]);
  });

  it('B: a stamped empty member against an unstamped data holder follows the C/D rule with no email', () => {
    const group = onlyGroup(collect([pair({ stamped: true }, { data: true, stamped: false })]));
    expect(group.kind).toBe('B');
    expect(group.proposal).toMatchObject({ contact: false, keep: 'B', retireAddress: ['A'] });
  });

  it('B wins over D, as in the audit query order', () => {
    expect(
      onlyGroup(collect([pair({ stamped: true, providers: ['google'] }, { data: true, stamped: false })])).kind,
    ).toBe('B');
  });

  it('C: the empty members have no live provider link and no live token', () => {
    const group = onlyGroup(collect([pair({ data: true, stamped: true }, { stamped: false })]));
    expect(group.kind).toBe('C');
    expect(group.proposal).toMatchObject({ contact: false, keep: 'A', retireAddress: ['B'] });
  });

  it('C: a Facebook-only link is no login method', () => {
    const group = onlyGroup(
      collect([pair({ data: true, stamped: true }, { password: false, providers: ['facebook'] })]),
    );
    expect(group.kind).toBe('C');
    expect(group.members[1]?.hasLoginMethod).toBe(false);
  });

  it('D: an empty member with a Google/Apple link or a live refresh token', () => {
    expect(onlyGroup(collect([pair({ data: true, stamped: true }, { providers: ['apple'] })])).kind).toBe('D');
    expect(onlyGroup(collect([pair({ data: true, stamped: true }, { liveTokens: 1 })])).kind).toBe('D');
    expect(onlyGroup(collect([pair({ data: true, stamped: true }, { liveTokens: 1 })])).proposal).toMatchObject({
      contact: false,
      keep: 'A',
      retireAddress: ['B'],
    });
  });

  it('E: keeps the earliest member with a password, then one with a provider, else none', () => {
    expect(
      onlyGroup(collect([pair({ password: false, providers: ['google'] }, { password: true })])).proposal,
    ).toMatchObject({
      contact: false,
      keep: 'B',
      retireAddress: ['A'],
    });
    expect(
      onlyGroup(collect([pair({ password: false, providers: ['google'] }, { password: false })])).proposal,
    ).toMatchObject({
      keep: 'A',
      retireAddress: ['B'],
    });
    const stranded = onlyGroup(collect([pair({ password: false }, { password: false, providers: ['facebook'] })]));
    expect(stranded.kind).toBe('E');
    expect(stranded.proposal).toMatchObject({ contact: false, keep: null, retireAddress: [] });
  });

  it('classifyGroup is the audit order: 2+ data, B, D, C, then E', () => {
    const member = (hasOwnData: boolean, stamped = false, hasLiveProvider = false, hasLiveRefreshToken = false) => ({
      hasOwnData,
      stamped,
      hasLiveProvider,
      hasLiveRefreshToken,
    });
    expect(classifyGroup([member(true), member(true), member(false, true)])).toBe('A');
    expect(classifyGroup([member(true, false), member(false, true, true)])).toBe('B');
    expect(classifyGroup([member(true, true), member(false, true, false, true)])).toBe('D');
    expect(classifyGroup([member(true, true), member(false, true)])).toBe('C');
    expect(classifyGroup([member(false, true, true), member(false)])).toBe('E');
  });
});

describe('mutation checks on the own-data exclusions', () => {
  // Every group has one data holder; each empty member carries exactly one excluded row kind.
  const groups = [
    pair({ data: true, stamped: true }, { rows: { 'public.feed_items.recipient_id': 1 } }),
    pair({ data: true, stamped: true }, { rows: { 'public.notifications.recipient_id': 1 } }),
    pair({ data: true, stamped: true }, { rows: { 'public.user_follows.following_id': 1 } }),
    pair({ data: true, stamped: true }, { rows: { 'public.user_follow_requests.recipient_id': 1 } }),
    pair({ data: true, stamped: true }, { rows: { 'public.community_roles.user_id': 1 } }),
    pair({ data: true, stamped: true }, { rows: { [PENDING_INVITE]: 1 } }),
    pair({ data: true, stamped: true }, {}),
  ];
  const baseline = buildAccountEmailEvidence(collect(groups)).summary.groupsByKind;

  it('classifies the baseline as one-data-holder groups', () => {
    expect(baseline).toEqual({ A: 0, B: 0, C: 7, D: 0, E: 0 });
  });

  it('dropping the user_climb_percentiles exclusion turns every group into a contact group', () => {
    const mutated = buildAccountEmailEvidence(collect(groups), { ...OWN_DATA_RULES, derivedTables: [] }).summary;
    expect(mutated.groupsByKind).not.toEqual(baseline);
    expect(mutated.groupsByKind).toEqual({ A: 7, B: 0, C: 0, D: 0, E: 0 });
    expect(mutated.contactEmails).toBe(7);
  });

  it('dropping the pending-invite row exclusion changes the counts', () => {
    const mutated = buildAccountEmailEvidence(collect(groups), { ...OWN_DATA_RULES, causedByOthersRows: [] }).summary;
    expect(mutated.groupsByKind).toEqual({ A: 1, B: 0, C: 6, D: 0, E: 0 });
  });

  it.each(OWN_DATA_RULES.causedByOthers.map((rule) => [`${rule.table}.${rule.column}`, rule] as const))(
    'dropping the %s exclusion changes the counts',
    (_label, dropped) => {
      const rules = {
        ...OWN_DATA_RULES,
        causedByOthers: OWN_DATA_RULES.causedByOthers.filter((rule) => rule !== dropped),
      };
      const mutated = buildAccountEmailEvidence(collect(groups), rules).summary.groupsByKind;
      expect(mutated).not.toEqual(baseline);
      expect(mutated).toEqual({ A: 1, B: 0, C: 6, D: 0, E: 0 });
    },
  );

  it('dropping the housekeeping exclusion changes the counts', () => {
    const mutated = buildAccountEmailEvidence(collect(groups), { ...OWN_DATA_RULES, housekeepingTables: [] }).summary
      .groupsByKind;
    expect(mutated).toEqual({ A: 7, B: 0, C: 0, D: 0, E: 0 });
  });
});

describe('proof, activity and labels', () => {
  it('counts a verification-window stamp as proof only when the address string is not shared', () => {
    const windowStamp = { facts: { stampedLaterWhileVerificationRequired: true, verifiedStamp: 'later' as const } };
    const distinct = onlyGroup(collect([pair({ data: true, ...windowStamp }, { data: true })]));
    expect(distinct.members[0]?.mailboxProof).toBe('verified-while-required');
    const shared = onlyGroup(
      collect([
        [
          { id: 'dup-a', email: 'dup@example.test', joinedAt: '2026-01-01 00:00:00', data: true, ...windowStamp },
          { id: 'dup-b', email: 'dup@example.test', joinedAt: '2026-01-02 00:00:00', data: true },
        ],
      ]),
    );
    expect(shared.exactDuplicateString).toBe(true);
    expect(shared.members[0]?.mailboxProof).toBeNull();
    const provider = onlyGroup(
      collect([
        pair({ data: true, providers: ['google'] }, { data: true, facts: { stagedVerificationCompleted: true } }),
      ]),
    );
    expect(provider.members.map((member) => member.mailboxProof)).toEqual(['google-or-apple', 'staged-verification']);
  });

  it('names the most recently active member, and nobody on a tie', () => {
    const latest = onlyGroup(
      collect([
        pair(
          { data: true, facts: { lastActiveDay: '2026-10-01', lastTickAt: '2026-10-20 08:00:00' } },
          { data: true, facts: { lastActiveDay: '2026-10-19' } },
        ),
      ]),
    );
    expect(latest.mostRecentlyActive).toBe('A');
    const tie = onlyGroup(
      collect([
        pair(
          { data: true, facts: { lastActiveDay: '2026-10-19' } },
          { data: true, facts: { lastActiveDay: '2026-10-19' } },
        ),
      ]),
    );
    expect(tie.mostRecentlyActive).toBeNull();
  });

  it('labels groups by address order and members by join date', () => {
    const { worksheet } = buildAccountEmailEvidence(
      collect([
        [
          { id: 'z-late', email: 'Zed@example.test', joinedAt: '2026-09-01 00:00:00', data: true },
          { id: 'z-early', email: 'zed@example.test', joinedAt: '2026-01-01 00:00:00', data: true },
        ],
        [
          { id: 'a-1', email: 'ann@example.test', joinedAt: '2026-01-01 00:00:00', data: true },
          { id: 'a-2', email: ' ANN@example.test', joinedAt: '2026-01-02 00:00:00' },
        ],
      ]),
    );
    expect(worksheet.groups.map((group) => [group.group, group.address])).toEqual([
      ['G01', 'ann@example.test'],
      ['G02', 'zed@example.test'],
    ]);
    expect(worksheet.groups[1]?.members.map((member) => [member.member, member.userId])).toEqual([
      ['A', 'z-early'],
      ['B', 'z-late'],
    ]);
  });
});

describe('address and login checks', () => {
  it('counts SQL-versus-JS lowercase disagreement, non-ASCII and whitespace rows', () => {
    const { summary } = buildAccountEmailEvidence(
      collect([], {
        users: [
          {
            userId: 'u1',
            email: 'plain@example.test',
            sqlLower: 'plain@example.test',
            sqlLowerTwice: 'plain@example.test',
          },
          {
            userId: 'u2',
            email: 'Mixed@example.test',
            sqlLower: 'mixed@example.test',
            sqlLowerTwice: 'mixed@example.test',
          },
          // JS lowercases U+0130 to "i" plus a combining dot; a libc locale gives a bare "i".
          {
            userId: 'u3',
            email: 'İnan@example.test',
            sqlLower: 'inan@example.test',
            sqlLowerTwice: 'inan@example.test',
          },
          {
            userId: 'u4',
            email: ' pad@example.test',
            sqlLower: ' pad@example.test',
            sqlLowerTwice: ' pad@example.test',
          },
        ],
      }),
    );
    expect(summary.addresses).toMatchObject({
      nonNormalized: 3,
      nonNormalizedStandalone: 3,
      edgeWhitespace: 1,
      nonAscii: 1,
      sqlLowerDiffersFromJs: 1,
      normalizedFormsAtRiskInSqlCheck: 1,
    });
    expect(summary.checks.sqlLowerMatchesJs).toBe(false);
    // SQL agrees with JS, but lowercasing again changes the text: the stored form is not proven stable.
    const unstable = buildAccountEmailEvidence(
      collect([], {
        users: [
          { userId: 'u5', email: 'Åse@example.test', sqlLower: 'åse@example.test', sqlLowerTwice: 'ase@example.test' },
        ],
      }),
    ).summary;
    expect(unstable.addresses).toMatchObject({ sqlLowerDiffersFromJs: 0, normalizedFormsAtRiskInSqlCheck: 1 });
    expect(unstable.checks.sqlLowerMatchesJs).toBe(false);
  });

  it('passes the no-login check only when the no-login rows are exactly the three fixed system accounts', () => {
    expect(buildAccountEmailEvidence(collect([])).summary.checks.noLoginRowsAreFixedSystemAccounts).toBe(true);
    const extra = buildAccountEmailEvidence(
      collect([], { usersWithoutLoginMethod: 4, fixedSystemAccountsWithoutLogin: 3 }),
    );
    expect(extra.summary.checks.noLoginRowsAreFixedSystemAccounts).toBe(false);
    const missing = buildAccountEmailEvidence(
      collect([], { usersWithoutLoginMethod: 3, fixedSystemAccountsWithoutLogin: 2 }),
    );
    expect(missing.summary.checks.noLoginRowsAreFixedSystemAccounts).toBe(false);
  });

  it('rejects a member without facts and a row count for an unknown column', () => {
    const collected = collect([pair({ data: true }, { data: true })]);
    const [first] = collected.members.keys();
    const withoutFacts = new Map(collected.members);
    if (first) withoutFacts.delete(first);
    expect(() => buildAccountEmailEvidence({ ...collected, members: withoutFacts })).toThrow(AccountEmailEvidenceError);
    const unknownColumn = new Map(collected.members);
    const facts = first ? unknownColumn.get(first) : undefined;
    if (first && facts) unknownColumn.set(first, { ...facts, rowsByColumn: { 'public.nowhere.user_id': 1 } });
    expect(() => buildAccountEmailEvidence({ ...collected, members: unknownColumn })).toThrow(
      AccountEmailEvidenceError,
    );
  });
});

describe('session guard', () => {
  it('allows a read-only standby snapshot and refuses a primary unless the owner opts in', () => {
    const standby = { isolation: 'repeatable read', readOnly: 'on', inRecovery: true };
    const primary = { ...standby, inRecovery: false };
    expect(() => assertEvidenceSession(standby, false)).not.toThrow();
    expect(() => assertEvidenceSession(primary, false)).toThrow(
      expect.objectContaining({ code: 'PRIMARY_NOT_ALLOWED' }),
    );
    expect(() => assertEvidenceSession(primary, true)).not.toThrow();
  });

  it('refuses any session that is not a REPEATABLE READ READ ONLY snapshot, even with --allow-primary', () => {
    for (const session of [
      { isolation: 'repeatable read', readOnly: 'off', inRecovery: true },
      { isolation: 'read committed', readOnly: 'on', inRecovery: true },
      { isolation: 'repeatable read', readOnly: 'off', inRecovery: false },
    ])
      expect(() => assertEvidenceSession(session, true)).toThrow(expect.objectContaining({ code: 'NOT_READ_ONLY' }));
  });
});
