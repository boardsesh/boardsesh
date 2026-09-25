/// <reference types="node" />

import { describe, expect, it } from 'vitest';

import { filterToReachable, isBranchPlumbingPullRequest, selectPullRequestsInHistory } from './generate-changelog';

// Sync (main → release/next) and merge-back (release/next → main) PRs carry other
// people's commits, so counting them would duplicate every entry the train
// shipped. They are recognised by head branch AND head owner — a contributor's
// fork has a `main` too, and a PR from it is an ordinary contribution.
describe('isBranchPlumbingPullRequest', () => {
  it('drops a merge-back from this repo', () => {
    expect(isBranchPlumbingPullRequest('release/next', 'boardsesh')).toBe(true);
  });

  it('drops a sync from this repo', () => {
    expect(isBranchPlumbingPullRequest('main', 'boardsesh')).toBe(true);
  });

  it('keeps a fork PR whose head branch happens to be main', () => {
    expect(isBranchPlumbingPullRequest('main', 'some-contributor')).toBe(false);
  });

  it('keeps a fork PR whose head branch happens to be release/next', () => {
    expect(isBranchPlumbingPullRequest('release/next', 'some-contributor')).toBe(false);
  });

  it('keeps an ordinary feature branch', () => {
    expect(isBranchPlumbingPullRequest('fix/5432-thing', 'boardsesh')).toBe(false);
  });

  it('keeps a PR whose head repository was deleted (owner unknown)', () => {
    expect(isBranchPlumbingPullRequest('main', null)).toBe(false);
    expect(isBranchPlumbingPullRequest('main', undefined)).toBe(false);
  });

  it('keeps a PR with no head branch information at all', () => {
    expect(isBranchPlumbingPullRequest(undefined, 'boardsesh')).toBe(false);
  });
});

// A bundle published from `main` must not advertise a feature that exists only on
// the release train: the store binary it reaches does not contain that code. The
// rule is reachability from HEAD, not the PR's base branch — which also means the
// train's PRs appear on main by themselves once the merge-back lands.
describe('filterToReachable', () => {
  const trainPr = { number: 1, mergeCommitOid: 'aaa' };
  const mainPr = { number: 2, mergeCommitOid: 'bbb' };
  const mergeBackCommit = 'ccc';

  const reachableFrom = (commits: readonly string[]) => (oid: string) => commits.includes(oid);

  it('excludes a release/next PR from a main changelog before the merge-back', () => {
    // main's history holds its own merges only.
    const kept = filterToReachable([trainPr, mainPr], reachableFrom(['bbb']));
    expect(kept.map((pr) => pr.number)).toEqual([2]);
  });

  it('includes that same PR on main once the merge-back is reachable', () => {
    // The merge-back brings the train's merge commits into main's history.
    const kept = filterToReachable([trainPr, mainPr], reachableFrom(['bbb', 'aaa', mergeBackCommit]));
    expect(kept.map((pr) => pr.number)).toEqual([1, 2]);
  });

  it('includes a main PR on release/next after a sync merge', () => {
    // The train's history carries main's merges from the sync onwards.
    const kept = filterToReachable([trainPr, mainPr], reachableFrom(['aaa', 'bbb']));
    expect(kept.map((pr) => pr.number)).toEqual([1, 2]);
  });

  it('keeps a PR whose merge commit GitHub did not report, rather than dropping it', () => {
    const kept = filterToReachable([{ number: 3, mergeCommitOid: null }], reachableFrom([]));
    expect(kept.map((pr) => pr.number)).toEqual([3]);
  });
});

// `reachableCommits()` shells out to git, so it cannot be unit-tested without a
// fixture repository — but its FAILURE contract can be, and that is the half that
// matters: a shallow clone or a missing git must publish a slightly over-inclusive
// changelog, never an empty one.
describe('selectPullRequestsInHistory', () => {
  const prs = [
    { number: 1, mergeCommitOid: 'aaa' },
    { number: 2, mergeCommitOid: 'bbb' },
  ];

  it('keeps every PR when the history could not be read', () => {
    expect(selectPullRequestsInHistory(prs, null).map((pr) => pr.number)).toEqual([1, 2]);
  });

  it('filters by reachability when the history is available', () => {
    expect(selectPullRequestsInHistory(prs, new Set(['bbb'])).map((pr) => pr.number)).toEqual([2]);
  });

  it('drops everything only when the history genuinely contains none of them', () => {
    // An EMPTY set is different from an unreadable history: reachableCommits()
    // returns null for the latter, which the case above covers.
    expect(selectPullRequestsInHistory(prs, new Set())).toEqual([]);
  });

  it('never returns the caller its own array to mutate', () => {
    expect(selectPullRequestsInHistory(prs, null)).not.toBe(prs);
  });
});
