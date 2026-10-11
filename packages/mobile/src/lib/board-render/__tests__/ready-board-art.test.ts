import { beforeEach, describe, expect, it, vi } from 'vitest';
const authority = vi.hoisted(() => ({ privacy: 1, credential: 2, spray: 'private-1', version: '-sv1' }));
vi.mock('../../privacy/privacy-cache', () => ({
  getPrivacyRevocationGeneration: () => authority.privacy,
  getPrivacyCredentialGeneration: () => authority.credential,
}));
vi.mock('../../spray/spray-privacy-generation', () => ({
  sprayPrivacyGeneration: () => authority.spray,
  sprayOverlayLayoutId: () => null,
}));
vi.mock('../../spray/spray-wall-registry', () => ({
  sprayCacheToken: (board: string) => (board === 'spray' ? authority.version : ''),
}));
import { cacheRenderedOverlay, _resetOverlayIndexForTests } from '../../overlay-index';
import { captureReadyBoardArt, isReadyBoardArtCurrent, type ReadyBoardArtIdentity } from '../ready-board-art';

const identity: ReadyBoardArtIdentity = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: '3,4',
  frames: 'p1r12',
  renderSignature: 'blue.aura',
  colorScheme: 'dark',
};
function snapshot(board: 'kilter' | 'spray' = 'kilter') {
  const entry = cacheRenderedOverlay('render-key', 'file:///same.png');
  return captureReadyBoardArt({
    ...identity,
    boardName: board,
    climbUuid: 'climb-1',
    mirrored: false,
    quality: 'full',
    overlayCacheKey: 'render-key',
    overlayUri: entry.uri,
    overlayGeneration: entry.generation,
    overlayLoadKey: `${entry.generation}:0`,
    backgroundPaths: ['/board.webp'],
  });
}

describe('ready artwork snapshot authority', () => {
  beforeEach(() => {
    _resetOverlayIndexForTests();
    authority.privacy = 1;
    authority.credential = 2;
    authority.spray = 'private-1';
    authority.version = '-sv1';
  });
  it('copies and freezes backgrounds instead of retaining mutable row state', () => {
    const ready = snapshot();
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready.backgroundPaths)).toBe(true);
    expect(isReadyBoardArtCurrent(ready, { ...identity, climbUuid: 'climb-1', mirrored: false })).toBe(true);
    expect('read' in ready).toBe(false);
  });
  it('rejects old generations even when native rewrites the same URI', () => {
    const ready = snapshot();
    cacheRenderedOverlay(ready.overlayCacheKey, ready.overlayUri);
    expect(isReadyBoardArtCurrent(ready, identity)).toBe(false);
  });
  it.each(['frames', 'renderSignature', 'colorScheme', 'setIds'] as const)('rejects a changed %s', (field) => {
    expect(isReadyBoardArtCurrent(snapshot(), { ...identity, [field]: 'changed' })).toBe(false);
  });
  it('rejects a recycled climb UUID or mirror intent', () => {
    const ready = snapshot();
    expect(isReadyBoardArtCurrent(ready, { ...identity, climbUuid: 'climb-2' })).toBe(false);
    expect(isReadyBoardArtCurrent(ready, { ...identity, mirrored: true })).toBe(false);
  });
  it.each(['privacy', 'credential'] as const)('rejects a %s withdrawal synchronously', (field) => {
    const ready = snapshot();
    authority[field] += 1;
    expect(isReadyBoardArtCurrent(ready, identity)).toBe(false);
  });
  it.each(['spray', 'version'] as const)('rejects a spray %s withdrawal/reset', (field) => {
    const ready = snapshot('spray');
    authority[field] = 'changed';
    expect(isReadyBoardArtCurrent(ready, { ...identity, boardName: 'spray' })).toBe(false);
  });
});
