import { describe, expect, it } from 'vite-plus/test';
import { intersectInferredPrivacy, type InferredPrivacy } from '../services/inferred-sessions/privacy';

function policy(
  audience: InferredPrivacy['audience'],
  grants: [string, 'approved' | 'revoked'][] = [],
  inheritFollowers = false,
): InferredPrivacy {
  return { audience, grants: new Map(grants), inheritFollowers };
}

describe('inferred session privacy intersections', () => {
  it('clones a split source policy including its grants and follower inheritance', () => {
    const original = policy(
      'invite_only',
      [
        ['friend', 'approved'],
        ['removed', 'revoked'],
      ],
      true,
    );
    expect(intersectInferredPrivacy([original])).toEqual(original);
  });
  it('keeps an unlisted half of a merge off the listings', () => {
    expect(intersectInferredPrivacy([policy('public'), policy('unlisted')]).audience).toBe('unlisted');
    expect(intersectInferredPrivacy([policy('unlisted'), policy('followers')]).audience).toBe('invite_only');
  });
  it('never widens an owner-only source when merging into public activity', () => {
    expect(intersectInferredPrivacy([policy('public'), policy('only_me')]).audience).toBe('only_me');
  });
  it('keeps only common explicit grants and unions revocations', () => {
    const merged = intersectInferredPrivacy([
      policy('invite_only', [
        ['friend', 'approved'],
        ['one-side', 'approved'],
        ['removed', 'approved'],
      ]),
      policy('invite_only', [
        ['friend', 'approved'],
        ['removed', 'revoked'],
      ]),
    ]);
    expect(merged.audience).toBe('invite_only');
    expect([...merged.grants]).toEqual([
      ['friend', 'approved'],
      ['removed', 'revoked'],
    ]);
  });
  it('retains dynamic follower access without converting it into permanent grants', () => {
    const merged = intersectInferredPrivacy([
      policy('followers'),
      policy('invite_only', [['one-side', 'approved']], true),
    ]);
    expect(merged.audience).toBe('followers');
    expect(merged.grants.size).toBe(0);
  });
});
