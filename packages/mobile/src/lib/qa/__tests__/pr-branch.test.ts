import { describe, expect, it } from 'vitest';
import { parsePrBranch, parsePrNumberList, prBranchName } from '../pr-branch';

describe('parsePrBranch', () => {
  it('reads the number out of a pr-<n> branch', () => {
    expect(parsePrBranch('pr-4792')).toBe(4792);
    expect(parsePrBranch('pr-1')).toBe(1);
  });

  it('is null for anything that is not a PR preview branch', () => {
    // Production and unrelated branches share the list with PR previews, so the
    // parse is what keeps them out of the tester's pick list.
    expect(parsePrBranch('production')).toBeNull();
    expect(parsePrBranch('feature-native-update')).toBeNull();
    expect(parsePrBranch('preview-3')).toBeNull();
    expect(parsePrBranch('')).toBeNull();
  });

  it('is null for null and undefined', () => {
    expect(parsePrBranch(null)).toBeNull();
    expect(parsePrBranch(undefined)).toBeNull();
  });

  it('rejects a padded or signed number rather than guessing the PR', () => {
    // `pr-04792` is not a name the preview workflow publishes; accepting it would
    // file a verdict against a PR number the string never actually named.
    expect(parsePrBranch('pr-04792')).toBeNull();
    expect(parsePrBranch('pr-0')).toBeNull();
    expect(parsePrBranch('pr--1')).toBeNull();
    expect(parsePrBranch('pr-1.5')).toBeNull();
  });

  it('is anchored at both ends', () => {
    expect(parsePrBranch('xpr-12')).toBeNull();
    expect(parsePrBranch('pr-12-fix')).toBeNull();
    expect(parsePrBranch(' pr-12')).toBeNull();
    expect(parsePrBranch('pr-12\n')).toBeNull();
  });

  it('round-trips with prBranchName', () => {
    expect(parsePrBranch(prBranchName(4792))).toBe(4792);
  });
});

describe('prBranchName', () => {
  it('formats the branch the OTA preview workflow publishes', () => {
    expect(prBranchName(4792)).toBe('pr-4792');
  });
});

describe('parsePrNumberList', () => {
  it('reads the comma-separated route param the gate hands over', () => {
    expect(parsePrNumberList('4792,4800')).toEqual([4792, 4800]);
  });

  it('is empty when the param is absent or blank', () => {
    expect(parsePrNumberList(undefined)).toEqual([]);
    expect(parsePrNumberList('')).toEqual([]);
  });

  it('takes the first value when Expo Router hands back an array', () => {
    expect(parsePrNumberList(['1,2', '3'])).toEqual([1, 2]);
  });

  it('drops junk rather than throwing on a hand-typed deep link', () => {
    // Degrade to "list them yourself", never to a crash.
    expect(parsePrNumberList('4792,,abc,-3,0,4800')).toEqual([4792, 4800]);
  });

  it('tolerates whitespace and de-duplicates', () => {
    expect(parsePrNumberList(' 1 , 2 , 1 ')).toEqual([1, 2]);
  });
});
