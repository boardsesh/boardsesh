import { describe, expect, it } from 'vite-plus/test';
import {
  intersectInferredPrivacy,
  movedContentNeedsRestriction,
  narrowsInferredPrivacy,
  type InferredPrivacy,
} from '../services/inferred-sessions/privacy';

function policy(
  audience: InferredPrivacy['audience'],
  grants: [string, 'approved' | 'revoked'][] = [],
  inheritFollowers = false,
): InferredPrivacy {
  return { audience, grants: new Map(grants), inheritFollowers };
}

describe('inferred session privacy intersections', () => {
  it('preserves a revoked viewer when public content moves to a wider parent', () => {
    const source = policy('public', [['removed', 'revoked']]);
    expect(movedContentNeedsRestriction(source, policy('public'))).toBe(true);
    expect(movedContentNeedsRestriction(source, policy('public', [['removed', 'approved']]))).toBe(true);
    expect(movedContentNeedsRestriction(source, policy('public', [['removed', 'revoked']]))).toBe(false);
    expect(movedContentNeedsRestriction(source, intersectInferredPrivacy([source, policy('public')]))).toBe(false);
  });
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

describe('narrowsInferredPrivacy', () => {
  it('reports no narrowing for equal policies or a merge of equal audiences', () => {
    const shared = policy('followers', [['friend', 'approved']]);
    expect(narrowsInferredPrivacy(shared, policy('followers', [['friend', 'approved']]))).toBe(false);
    expect(
      narrowsInferredPrivacy(policy('public'), intersectInferredPrivacy([policy('public'), policy('public')])),
    ).toBe(false);
    expect(narrowsInferredPrivacy(policy('only_me'), policy('only_me'))).toBe(false);
  });
  it('reports narrowing when a merge intersects a wider policy down', () => {
    const merged = intersectInferredPrivacy([policy('public'), policy('only_me')]);
    expect(narrowsInferredPrivacy(policy('public'), merged)).toBe(true);
    expect(narrowsInferredPrivacy(policy('public'), policy('followers'))).toBe(true);
    expect(narrowsInferredPrivacy(policy('followers'), policy('invite_only'))).toBe(true);
    expect(narrowsInferredPrivacy(policy('invite_only', [], true), policy('invite_only'))).toBe(true);
  });
  it('reports narrowing when an approved viewer loses a grant or a viewer is newly revoked', () => {
    expect(narrowsInferredPrivacy(policy('invite_only', [['friend', 'approved']]), policy('invite_only'))).toBe(true);
    expect(narrowsInferredPrivacy(policy('public'), policy('public', [['removed', 'revoked']]))).toBe(true);
    expect(
      narrowsInferredPrivacy(policy('public', [['removed', 'revoked']]), policy('public', [['removed', 'revoked']])),
    ).toBe(false);
  });
  it('reports no narrowing when the next policy is wider', () => {
    expect(narrowsInferredPrivacy(policy('followers'), policy('public'))).toBe(false);
    expect(narrowsInferredPrivacy(policy('only_me'), policy('public'))).toBe(false);
  });
});
