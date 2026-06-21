import { describe, it, expect } from 'vitest';
import {
  isBotLogin,
  aggregateContributors,
  transformSponsors,
  type AuthorRef,
  type RawSponsorNode,
} from '../lib/acknowledgements-transform';

describe('isBotLogin', () => {
  it('flags [bot] suffixes, known automation, and AI assistants', () => {
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(isBotLogin('github-actions')).toBe(true);
    expect(isBotLogin('some-bot')).toBe(true);
    expect(isBotLogin('claude')).toBe(true);
    expect(isBotLogin('Codex')).toBe(true);
  });

  it('keeps real people and treats an empty login as a bot', () => {
    expect(isBotLogin('marcodejongh')).toBe(false);
    expect(isBotLogin('')).toBe(true);
  });
});

describe('aggregateContributors', () => {
  const prAuthors: AuthorRef[] = [
    { login: 'alpha', typename: 'User', name: 'Alpha', url: 'https://github.com/alpha' },
    { login: 'alpha', typename: 'User' },
    { login: 'beta', typename: 'User' },
    { login: 'dependabot[bot]', typename: 'Bot' },
  ];
  const issueAuthors: AuthorRef[] = [
    { login: 'beta', typename: 'User' },
    { login: 'beta', typename: 'User' },
    { login: 'gamma', typename: 'User' },
    { login: 'claude', typename: 'User' },
  ];

  it('ranks by combined pull requests + issues and drops bots/AI', () => {
    const result = aggregateContributors(prAuthors, issueAuthors);

    // beta: 1 PR + 2 issues = 3; alpha: 2 PRs = 2; gamma: 1 issue = 1. Bots gone.
    expect(result.map((entry) => entry.login)).toEqual(['beta', 'alpha', 'gamma']);
    expect(result.find((entry) => entry.login === 'beta')).toMatchObject({
      pullRequests: 1,
      issues: 2,
      contributions: 3,
    });
    expect(result.find((entry) => entry.login === 'alpha')).toMatchObject({
      pullRequests: 2,
      issues: 0,
      contributions: 2,
    });
  });

  it('backfills display name and a profile URL', () => {
    const [, alpha] = aggregateContributors(prAuthors, issueAuthors);
    expect(alpha.name).toBe('Alpha');
    expect(aggregateContributors([{ login: 'nourl', typename: 'User' }], [])[0].htmlUrl).toBe(
      'https://github.com/nourl',
    );
  });
});

describe('transformSponsors', () => {
  it('maps user and organization sponsor entities and skips null entities', () => {
    const nodes: RawSponsorNode[] = [
      { sponsorEntity: { __typename: 'User', login: 'patron', name: 'Patron', avatarUrl: 'av', url: 'u' } },
      { sponsorEntity: null },
      { sponsorEntity: { __typename: 'Organization', login: 'sponsorco', name: null, avatarUrl: 'av2', url: 'u2' } },
    ];
    const result = transformSponsors(nodes);
    expect(result).toEqual([
      { login: 'patron', name: 'Patron', avatarUrl: 'av', url: 'u' },
      { login: 'sponsorco', name: null, avatarUrl: 'av2', url: 'u2' },
    ]);
  });

  it('backfills a profile URL when the entity omits one', () => {
    const [first] = transformSponsors([{ sponsorEntity: { login: 'patron' } }]);
    expect(first.url).toBe('https://github.com/patron');
  });
});
