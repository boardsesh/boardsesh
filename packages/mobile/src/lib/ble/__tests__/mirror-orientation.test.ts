import { describe, it, expect } from 'vitest';
import { nextMirrorIntentAction, resolveMirroredOrientation } from '../mirror-orientation';

describe('resolveMirroredOrientation', () => {
  it('falls back to the climb when nobody has said anything', () => {
    expect(resolveMirroredOrientation({ climbMirrored: true })).toBe(true);
    expect(resolveMirroredOrientation({ climbMirrored: false })).toBe(false);
    expect(resolveMirroredOrientation({})).toBe(false);
    expect(resolveMirroredOrientation({ climbMirrored: null })).toBe(false);
  });

  it('lets a stated intent override the climb in both directions', () => {
    // The `false` case is the one that needs the tri-state: turning a mirrored
    // ascent's flip off must stick, not be undone by its own flag.
    expect(resolveMirroredOrientation({ statedIntent: false, climbMirrored: true })).toBe(false);
    expect(resolveMirroredOrientation({ statedIntent: true, climbMirrored: false })).toBe(true);
  });

  it('lets an explicit tap override a stated intent in both directions', () => {
    expect(resolveMirroredOrientation({ explicitFlip: false, statedIntent: true, climbMirrored: true })).toBe(false);
    expect(resolveMirroredOrientation({ explicitFlip: true, statedIntent: false, climbMirrored: false })).toBe(true);
  });

  it('treats undefined as "nobody said", not as un-mirrored', () => {
    expect(resolveMirroredOrientation({ explicitFlip: undefined, statedIntent: undefined, climbMirrored: true })).toBe(
      true,
    );
    expect(resolveMirroredOrientation({ explicitFlip: undefined, statedIntent: true, climbMirrored: false })).toBe(
      true,
    );
  });
});

describe('nextMirrorIntentAction', () => {
  const A = 'climb-a';
  const B = 'climb-b';

  it('records a tap made on the climb on screen', () => {
    expect(
      nextMirrorIntentAction({ isPreview: false, displayedClimbUuid: A, mirrorFlip: { climbUuid: A, mirrored: true } }),
    ).toEqual({ kind: 'state', climbUuid: A, mirrored: true });
    // Turning a flip off is just as explicit, and must be recorded — otherwise
    // a climb that is mirrored by default could never be un-flipped.
    expect(
      nextMirrorIntentAction({
        isPreview: false,
        displayedClimbUuid: A,
        mirrorFlip: { climbUuid: A, mirrored: false },
      }),
    ).toEqual({ kind: 'state', climbUuid: A, mirrored: false });
  });

  it('records nothing for a climb nobody tapped', () => {
    // The sticky-default bug: stating a value derived from `climb.mirrored` here
    // would go on to outrank a fresher one from a crew member's item.
    expect(nextMirrorIntentAction({ isPreview: false, displayedClimbUuid: A, mirrorFlip: null })).toEqual({
      kind: 'retain',
      climbUuid: A,
    });
  });

  it('drops a flip parked on a climb we have navigated away from', () => {
    expect(
      nextMirrorIntentAction({ isPreview: false, displayedClimbUuid: B, mirrorFlip: { climbUuid: A, mirrored: true } }),
    ).toEqual({ kind: 'retain', climbUuid: B });
  });

  it('says nothing at all while a preview is pinned', () => {
    // Mirroring what you are merely looking at must not re-light the live climb.
    expect(
      nextMirrorIntentAction({ isPreview: true, displayedClimbUuid: A, mirrorFlip: { climbUuid: A, mirrored: true } }),
    ).toEqual({ kind: 'none' });
  });

  it('says nothing when there is no climb on screen', () => {
    expect(nextMirrorIntentAction({ isPreview: false, displayedClimbUuid: undefined, mirrorFlip: null })).toEqual({
      kind: 'none',
    });
  });
});
