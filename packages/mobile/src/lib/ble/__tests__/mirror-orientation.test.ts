import { describe, it, expect } from 'vitest';
import { resolveMirroredOrientation } from '../mirror-orientation';

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
