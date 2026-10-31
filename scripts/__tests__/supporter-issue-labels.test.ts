import { describe, expect, it } from 'vitest';
import {
  CURRENT_SPONSORS_QUERY,
  labelSupporterIssues,
  planSupporterLabels,
  sponsorLoginsFrom,
  type GithubGraphql,
  type OpenIssue,
  type SupporterLabelDeps,
} from '../lib/supporter-issue-labels';

describe('sponsorLoginsFrom', () => {
  it('keeps people, lowercased, and drops organizations and empty entities', () => {
    const logins = sponsorLoginsFrom([
      { sponsorEntity: { __typename: 'User', login: 'Alpha' } },
      { sponsorEntity: { __typename: 'Organization', login: 'some-gym' } },
      { sponsorEntity: null },
      { sponsorEntity: { __typename: 'User', login: '' } },
    ]);
    expect([...logins]).toEqual(['alpha']);
  });
});

describe('planSupporterLabels', () => {
  const sponsors = new Set(['alpha', 'beta']);

  it('labels open issues by sponsors that do not carry the label yet', () => {
    const issues: OpenIssue[] = [
      { number: 12, authorLogin: 'Alpha', labels: ['bug'] },
      { number: 5, authorLogin: 'beta', labels: [] },
      { number: 7, authorLogin: 'gamma', labels: ['bug'] },
      { number: 9, authorLogin: null, labels: [] },
    ];
    expect(planSupporterLabels(issues, sponsors)).toEqual([5, 12]);
  });

  it('is idempotent: an issue that already has the label, in any case, is skipped', () => {
    const issues: OpenIssue[] = [
      { number: 3, authorLogin: 'alpha', labels: ['supporter'] },
      { number: 4, authorLogin: 'alpha', labels: ['Supporter', 'bug'] },
    ];
    expect(planSupporterLabels(issues, sponsors)).toEqual([]);
  });

  it('lists an issue once even when it is returned twice', () => {
    const issue: OpenIssue = { number: 8, authorLogin: 'alpha', labels: [] };
    expect(planSupporterLabels([issue, issue], sponsors)).toEqual([8]);
  });
});

type Recorded = { ensured: string[]; added: Array<[number, string]>; logs: string[] };

function fakeDeps(options: {
  sponsorPages: Array<Array<{ __typename: string; login: string }>>;
  issuesByAuthor: Record<string, Array<{ number: number; labels: string[] }>>;
  dryRun?: boolean;
  failOn?: number;
  sponsorErrors?: boolean;
}): { deps: SupporterLabelDeps; recorded: Recorded; sponsorQueries: Record<string, string>[] } {
  const recorded: Recorded = { ensured: [], added: [], logs: [] };
  const sponsorQueries: Record<string, string>[] = [];
  const sponsorsGraphql: GithubGraphql = (query, variables) => {
    expect(query).toBe(CURRENT_SPONSORS_QUERY);
    sponsorQueries.push(variables);
    if (options.sponsorErrors) return { errors: [{ message: 'Resource not accessible by integration' }] };
    const pageIndex = variables.cursor ? Number(variables.cursor) : 0;
    const hasNextPage = pageIndex + 1 < options.sponsorPages.length;
    return {
      data: {
        organization: {
          sponsorshipsAsMaintainer: {
            pageInfo: { hasNextPage, endCursor: hasNextPage ? String(pageIndex + 1) : null },
            nodes: options.sponsorPages[pageIndex].map((sponsorEntity) => ({ sponsorEntity })),
          },
        },
      },
    };
  };
  const issuesGraphql: GithubGraphql = (_query, variables) => ({
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: (options.issuesByAuthor[variables.author] ?? []).map((issue) => ({
            number: issue.number,
            author: { login: variables.author },
            labels: { nodes: issue.labels.map((name) => ({ name })) },
          })),
        },
      },
    },
  });
  const deps: SupporterLabelDeps = {
    owner: 'boardsesh',
    repo: 'boardsesh',
    sponsorOrg: 'boardsesh',
    sponsorsGraphql,
    issuesGraphql,
    ensureLabel: (name) => recorded.ensured.push(name),
    addLabel: (issueNumber, label) => {
      if (issueNumber === options.failOn) throw new Error(`issue ${issueNumber} is locked`);
      recorded.added.push([issueNumber, label]);
    },
    dryRun: options.dryRun ?? false,
    log: (line) => recorded.logs.push(line),
  };
  return { deps, recorded, sponsorQueries };
}

describe('labelSupporterIssues', () => {
  it('pages through current sponsors, public and private, and labels only their unlabelled open issues', () => {
    const { deps, recorded, sponsorQueries } = fakeDeps({
      sponsorPages: [
        [{ __typename: 'User', login: 'alpha' }],
        [
          { __typename: 'Organization', login: 'gym' },
          { __typename: 'User', login: 'beta' },
        ],
      ],
      issuesByAuthor: {
        alpha: [
          { number: 10, labels: ['bug'] },
          { number: 11, labels: ['supporter'] },
        ],
        beta: [{ number: 20, labels: [] }],
      },
    });

    const result = labelSupporterIssues(deps);

    expect(CURRENT_SPONSORS_QUERY).toContain('activeOnly: true');
    expect(CURRENT_SPONSORS_QUERY).toContain('includePrivate: true');
    expect(sponsorQueries).toEqual([{ login: 'boardsesh' }, { login: 'boardsesh', cursor: '1' }]);
    expect(recorded.ensured).toEqual(['supporter']);
    expect(recorded.added).toEqual([
      [10, 'supporter'],
      [20, 'supporter'],
    ]);
    expect(result).toEqual({ sponsors: 2, openIssuesBySponsors: 3, labelled: 2, failed: 0 });
  });

  it('logs counts only, never a sponsor login or an issue number', () => {
    const { deps, recorded } = fakeDeps({
      sponsorPages: [[{ __typename: 'User', login: 'private-sponsor' }]],
      issuesByAuthor: { 'private-sponsor': [{ number: 4242, labels: [] }] },
    });
    labelSupporterIssues(deps);
    const log = recorded.logs.join('\n');
    expect(log).not.toContain('private-sponsor');
    expect(log).not.toContain('4242');
    expect(log).toContain('1 labelled, 0 failed');
  });

  it('writes nothing on a dry run', () => {
    const { deps, recorded } = fakeDeps({
      sponsorPages: [[{ __typename: 'User', login: 'alpha' }]],
      issuesByAuthor: { alpha: [{ number: 1, labels: [] }] },
      dryRun: true,
    });
    labelSupporterIssues(deps);
    expect(recorded.ensured).toEqual([]);
    expect(recorded.added).toEqual([]);
    expect(recorded.logs.join('\n')).toContain('1 would be labelled (dry run)');
  });

  it('fails before any write when sponsorships cannot be read', () => {
    const { deps, recorded } = fakeDeps({ sponsorPages: [[]], issuesByAuthor: {}, sponsorErrors: true });
    expect(() => labelSupporterIssues(deps)).toThrow('Resource not accessible by integration');
    expect(recorded.ensured).toEqual([]);
    expect(recorded.added).toEqual([]);
  });

  it('keeps labelling after one write fails, and reports the failure count', () => {
    const { deps, recorded } = fakeDeps({
      sponsorPages: [[{ __typename: 'User', login: 'alpha' }]],
      issuesByAuthor: {
        alpha: [
          { number: 1, labels: [] },
          { number: 2, labels: [] },
        ],
      },
      failOn: 1,
    });
    const result = labelSupporterIssues(deps);
    expect(recorded.added).toEqual([[2, 'supporter']]);
    expect(result).toMatchObject({ labelled: 1, failed: 1 });
  });

  it('touches nothing when no sponsor has an open issue to label', () => {
    const { deps, recorded } = fakeDeps({
      sponsorPages: [[{ __typename: 'User', login: 'alpha' }]],
      issuesByAuthor: { alpha: [{ number: 1, labels: ['supporter'] }] },
    });
    labelSupporterIssues(deps);
    expect(recorded.ensured).toEqual([]);
    expect(recorded.added).toEqual([]);
  });
});
