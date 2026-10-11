import { beforeEach, describe, expect, it, vi } from 'vitest';
const authority = vi.hoisted(() => ({ privacy: 0, credential: 0, revoke: undefined as (() => void) | undefined }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  getPrivacyRevocationGeneration: () => authority.privacy,
  getPrivacyCredentialGeneration: () => authority.credential,
  subscribeToPrivacyRevocations: (listener: () => void) => {
    authority.revoke = listener;
    return () => {};
  },
}));
import {
  buildOpeningLayoutKey,
  clearOpeningLayoutCache,
  readOpeningLayout,
  rememberOpeningLayout,
  type OpeningLayoutIdentity,
} from '../opening-layout-cache';

const identity: OpeningLayoutIdentity = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '26,27',
  boardWidth: 1080,
  boardHeight: 1440,
  climbUuid: 'climb-1',
  frames: 'p1r12',
  viewportWidth: 390,
  viewportHeight: 844,
  fontScale: 1,
  pixelRatio: 3,
  locale: 'en-US',
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
  preferencesFingerprint: 'all',
  firstSectionId: 'stats',
  presentation: 'sheet',
  paneInset: 0,
  headerFingerprint: 'normal',
  controlsFingerprint: 'standard',
  lostBanner: false,
  playbackFingerprint: 'static',
};
const measurements = {
  viewportHeight: 763,
  headerBottomY: 108,
  firstSectionHeaderHeight: 52,
  containerSize: { width: 390, height: 590 },
};

describe('opening layout reuse', () => {
  beforeEach(() => {
    clearOpeningLayoutCache();
    authority.privacy = 0;
    authority.credential = 0;
  });
  it('copies complete positive geometry and freezes it', () => {
    const key = buildOpeningLayoutKey(identity);
    const original = { ...measurements, containerSize: { ...measurements.containerSize } };
    expect(rememberOpeningLayout(key, original)).toBe(true);
    original.containerSize.height = 2;
    expect(readOpeningLayout(key)).toEqual(measurements);
    expect(Object.isFrozen(readOpeningLayout(key))).toBe(true);
    expect(Object.isFrozen(readOpeningLayout(key)?.containerSize)).toBe(true);
  });
  it.each([
    { fontScale: 1.2 },
    { pixelRatio: 2 },
    { locale: 'fr' },
    { boardWidth: 1200 },
    { frames: 'p2r13' },
    { climbUuid: 'climb-2' },
    { viewportWidth: 844 },
    { insets: { top: 59, right: 0, bottom: 34, left: 0 } },
    { preferencesFingerprint: 'changed' },
    { firstSectionId: 'comments' },
    { presentation: 'pane' as const },
    { paneInset: 20 },
    { headerFingerprint: 'long-title' },
    { controlsFingerprint: 'light-only' },
    { lostBanner: true },
    { playbackFingerprint: 'animated' },
  ])('invalidates the changed layout model %j', (change) => {
    const key = buildOpeningLayoutKey(identity);
    rememberOpeningLayout(key, measurements);
    expect(readOpeningLayout(buildOpeningLayoutKey({ ...identity, ...change }))).toBeUndefined();
  });
  it('rejects unknown, incomplete and zero measurements', () => {
    const key = buildOpeningLayoutKey(identity);
    expect(readOpeningLayout('unknown')).toBeUndefined();
    expect(rememberOpeningLayout('unknown', measurements)).toBe(false);
    expect(rememberOpeningLayout(key, { ...measurements, headerBottomY: 0 })).toBe(false);
    expect(rememberOpeningLayout(key, { ...measurements, firstSectionHeaderHeight: 0 })).toBe(false);
    expect(rememberOpeningLayout(key, { ...measurements, containerSize: { width: 0, height: 10 } })).toBe(false);
    expect(rememberOpeningLayout(key, { ...measurements, headerBottomY: 800 })).toBe(false);
    expect(buildOpeningLayoutKey({ ...identity, viewportHeight: 0 })).toBeUndefined();
    expect(buildOpeningLayoutKey({ ...identity, preferencesFingerprint: '' })).toBeUndefined();
    expect(buildOpeningLayoutKey({ ...identity, insets: { ...identity.insets, top: Number.NaN } })).toBeUndefined();
  });
  it('permits zero section height only when no section is displayed', () => {
    expect(
      rememberOpeningLayout(buildOpeningLayoutKey({ ...identity, firstSectionId: null }), {
        ...measurements,
        firstSectionHeaderHeight: 0,
      }),
    ).toBe(true);
  });
  it.each(['privacy', 'credential'] as const)(
    'rejects an already captured key after %s withdrawal, before React updates',
    (field) => {
      const key = buildOpeningLayoutKey(identity);
      rememberOpeningLayout(key, measurements);
      authority[field] += 1;
      expect(readOpeningLayout(key)).toBeUndefined();
      expect(rememberOpeningLayout(key, measurements)).toBe(false);
      expect(buildOpeningLayoutKey(identity)).not.toBe(key);
    },
  );
  it('clears synchronously through the privacy listener', () => {
    const key = buildOpeningLayoutKey(identity);
    rememberOpeningLayout(key, measurements);
    authority.revoke?.();
    expect(readOpeningLayout(key)).toBeUndefined();
  });
  it('bounds geometry at 32 models and promotes reads', () => {
    const keys = Array.from({ length: 33 }, (_, index) =>
      buildOpeningLayoutKey({ ...identity, climbUuid: `climb-${index}` }),
    );
    for (const key of keys.slice(0, 32)) rememberOpeningLayout(key, measurements);
    expect(readOpeningLayout(keys[0])).toEqual(measurements);
    rememberOpeningLayout(keys[32], measurements);
    expect(readOpeningLayout(keys[1])).toBeUndefined();
    expect(readOpeningLayout(keys[0])).toEqual(measurements);
    expect(readOpeningLayout(keys[32])).toEqual(measurements);
  });
});
