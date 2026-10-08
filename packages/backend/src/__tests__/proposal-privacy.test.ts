import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as schema from '@boardsesh/db/schema';
import { sqlText } from '@boardsesh/db/test-utils';
import { batchEnrichProposals, enrichProposal } from '../graphql/resolvers/social/proposals/enrichment';

const { mockDb, visibleProfiles, predicates } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  visibleProfiles: [] as Array<{
    id: string;
    name: string;
    image: string | null;
    displayName: string;
    avatarUrl: string | null;
  }>,
  predicates: [] as unknown[],
}));
vi.mock('../db/client', () => ({ db: mockDb }));
vi.mock('../graphql/resolvers/social/community-settings', () => ({
  resolveCommunitySetting: vi.fn().mockResolvedValue('5'),
  DEFAULTS: { approval_threshold: '5' },
}));

const proposal = {
  id: 1,
  uuid: 'proposal-1',
  climbUuid: 'catalog-climb',
  boardType: 'kilter',
  angle: null,
  proposerId: 'private-author',
  type: 'grade',
  proposedValue: '20',
  currentValue: '19',
  status: 'approved',
  reason: 'A private personal account of this climb',
  resolvedAt: new Date('2026-01-02T00:00:00Z'),
  resolvedBy: 'private-reviewer',
  createdAt: new Date('2026-01-01T00:00:00Z'),
} as typeof schema.climbProposals.$inferSelect;

beforeEach(() => {
  visibleProfiles.length = 0;
  predicates.length = 0;
  mockDb.select.mockImplementation(() => {
    let table: unknown;
    const chain = {
      from(source: unknown) {
        table = source;
        return chain;
      },
      leftJoin() {
        return chain;
      },
      where(predicate: unknown) {
        predicates.push(predicate);
        return chain;
      },
      groupBy() {
        return chain;
      },
      limit() {
        return chain;
      },
      then(resolve: (rows: unknown[]) => unknown) {
        let rows: unknown[] = [];
        if (table === schema.users) rows = visibleProfiles;
        if (table === schema.proposalVotes) rows = [{ proposalId: 1, value: 1, weight: 3 }];
        if (table === schema.boardClimbs)
          rows = [{ uuid: 'catalog-climb', boardType: 'kilter', name: 'Public climb', angle: null }];
        return Promise.resolve(rows).then(resolve);
      },
    };
    return chain;
  });
});

describe('proposal privacy projection', () => {
  it.each(['single', 'batch'])('%s hides private identities and prose while retaining weighted votes', async (mode) => {
    const result =
      mode === 'single' ? await enrichProposal(proposal, null) : (await batchEnrichProposals([proposal], null))[0];
    expect(result).toMatchObject({
      proposerId: null,
      reason: null,
      resolvedBy: null,
      weightedUpvotes: 3,
      weightedDownvotes: 0,
      upvoterCount: 1,
      climbName: 'Public climb',
    });
    expect(result.proposerDisplayName).toBeUndefined();
    expect(result.proposerAvatarUrl).toBeUndefined();
    const queryText = predicates.map(sqlText).join('\n');
    expect(queryText).toContain('is_private');
    expect(queryText).toContain('public_consent_revision');
  });

  it('preserves the authorized proposer without exposing a private resolver', async () => {
    visibleProfiles.push({
      id: proposal.proposerId,
      name: 'Name',
      displayName: 'Approved climber',
      image: null,
      avatarUrl: null,
    });
    const result = await enrichProposal(proposal, 'approved-follower');
    expect(result).toMatchObject({
      proposerId: proposal.proposerId,
      proposerDisplayName: 'Approved climber',
      reason: proposal.reason,
      resolvedBy: null,
    });
  });
});
