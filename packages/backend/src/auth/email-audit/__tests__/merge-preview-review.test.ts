import { describe, expect, it } from 'vite-plus/test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAccountEmailEvidence, type CollectedEvidence, type EvidenceMemberFacts } from '../evidence';
import { buildAccountEmailMergePreview } from '../merge-preview';
import type { MergeConflictFacts } from '../merge-snapshot';
import { runAccountEmailMergePreviewCli } from '../../../scripts/account-email-merge-preview';

const CANARY = 'private-review-canary';
const ADDRESS = `${CANARY}@example.test`;

function facts(userId: string, hasOwnData: boolean): EvidenceMemberFacts {
  return {
    userId,
    name: CANARY,
    profileDisplayName: CANARY,
    joinedAt: '2026-01-01 00:00:00',
    emailVerifiedAt: '2026-01-01 00:00:00',
    verifiedStamp: 'at_signup',
    stampedLaterWhileVerificationRequired: false,
    hasPassword: true,
    providers: ['google'],
    liveRefreshTokens: 1,
    lastActiveDay: '2026-11-11',
    lastTickAt: hasOwnData ? '2026-11-11 12:00:00' : null,
    communityRoles: [],
    gymsOwned: 0,
    gymAdminMemberships: 0,
    pendingLinks: { legacyReset: 0, legacyVerify: 0, stagedRecovery: 0, stagedVerification: 0 },
    stagedVerificationCompleted: true,
    rowsByColumn: hasOwnData ? { 'public.boardsesh_ticks.user_id': 4 } : {},
  };
}

function fixture(secondHasData = false): CollectedEvidence {
  const members = [`${CANARY}-a`, `${CANARY}-b`];
  return {
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
    users: members.map((userId, index) => ({
      userId,
      email: index === 0 ? ADDRESS : ADDRESS.toUpperCase(),
      sqlLower: ADDRESS,
      sqlLowerTwice: ADDRESS,
    })),
    members: new Map(members.map((userId, index) => [userId, facts(userId, index === 0 || secondHasData)])),
    usersWithoutLoginMethod: 3,
    fixedSystemAccountsWithoutLogin: 3,
  };
}

const NO_CONFLICTS: MergeConflictFacts = { uniqueIndexes: [], tickCandidates: [], boardMappings: [], limitations: [] };

describe('independent merge-preview safety review', () => {
  it('does not carry a retirement keeper into an approved merge, even with every historical proof flag', () => {
    const evidence = fixture();
    // This is a regression trap: the earlier retirement worksheet proposes A.
    expect(buildAccountEmailEvidence(evidence).worksheet.groups[0]?.proposal.keep).toBe('A');
    const preview = buildAccountEmailMergePreview(evidence, NO_CONFLICTS);
    expect(preview.summary.readyToMerge).toBe(0);
    expect(preview.coverage.status).toBe('incomplete_for_merge');
    expect(preview.groups[0]).toMatchObject({
      status: 'blocked_pending_ownership_and_rehearsal',
      survivingUserId: null,
      review: { passwordChoiceRequired: true, sessionAndOfflineReconciliationRequired: true },
    });
    expect(preview.groups[0]?.members).toHaveLength(2);
  });

  it('preserves counts as candidates without deduplicating any tick or claiming ownership', () => {
    const evidence = fixture(true);
    const before = buildAccountEmailEvidence(evidence).worksheet.groups[0]?.members;
    const preview = buildAccountEmailMergePreview(evidence, {
      ...NO_CONFLICTS,
      tickCandidates: [{ address: ADDRESS, duplicateKeys: 2, rows: 4 }],
      boardMappings: [{ address: ADDRESS, boardType: 'kilter', accounts: 2, distinctUpstreamIdentities: 2 }],
    });
    expect(preview.summary).toMatchObject({
      readyToMerge: 0,
      groupsWithDataOnMultipleAccounts: 1,
      groupsWithTickCandidates: 1,
      groupsWithDifferentBoardIdentities: 1,
    });
    expect(preview.groups[0]?.members).toEqual(before);
    expect(preview.groups[0]?.review.tickCandidates).toEqual([{ address: ADDRESS, duplicateKeys: 2, rows: 4 }]);
    expect(preview.groups[0]?.survivingUserId).toBeNull();
  });

  it('keeps unsupported indexes visible instead of reporting complete coverage', () => {
    const preview = buildAccountEmailMergePreview(fixture(), {
      ...NO_CONFLICTS,
      uniqueIndexes: [
        {
          schema: 'public',
          table: 'user_activity_days',
          index: 'partial_review_index',
          analysis: 'unsupported',
          reason: 'Partial index needs manual review.',
          collisions: [],
        },
      ],
    });
    expect(preview.summary).toMatchObject({ countedUniqueIndexes: 0, unsupportedUniqueIndexes: 1, readyToMerge: 0 });
    expect(preview.coverage.uniqueIndexes[0]?.analysis).toBe('unsupported');
    expect(preview.coverage.status).toBe('incomplete_for_merge');
  });

  it('refuses unreconciled evidence rather than generating a planning receipt', () => {
    expect(() =>
      buildAccountEmailMergePreview({ ...fixture(), fixedSystemAccountsWithoutLogin: 2 }, NO_CONFLICTS),
    ).toThrow('reconciled evidence');
  });

  it('keeps private addresses, member IDs and names out of the public counts', () => {
    const preview = buildAccountEmailMergePreview(fixture(), NO_CONFLICTS);
    expect(JSON.stringify(preview.summary)).not.toContain(CANARY);
    expect(JSON.stringify(preview.groups)).toContain(CANARY);
  });

  it.each(['--apply', '--merge', '--delete', '--keep'])(
    'refuses the mutation flag %s before connecting',
    async (flag) => {
      let output = '';
      const exitCode = await runAccountEmailMergePreviewCli(['--out', `${CANARY}.json`, flag], {}, (chunk) => {
        output += chunk;
      });
      expect(exitCode).toBe(1);
      expect(JSON.parse(output)).toMatchObject({ status: 'incomplete', code: 'CONFIGURATION' });
      expect(output).not.toContain(CANARY);
    },
  );

  it('ignores ambient application DSNs and does not write a partial worksheet', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boardsesh-merge-review-'));
    let output = '';
    const exitCode = await runAccountEmailMergePreviewCli(
      ['--out', join(directory, `${CANARY}.json`)],
      {
        DATABASE_URL: `postgresql://user:${CANARY}@db.example.test/production`,
        ACCOUNT_EMAIL_EVIDENCE_DATABASE_URL: `postgresql://user:${CANARY}@db.example.test/production`,
      },
      (chunk) => {
        output += chunk;
      },
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ status: 'incomplete', code: 'CONFIGURATION' });
    expect(output).not.toContain(CANARY);
    expect(readdirSync(directory)).toEqual([]);
  });
});
