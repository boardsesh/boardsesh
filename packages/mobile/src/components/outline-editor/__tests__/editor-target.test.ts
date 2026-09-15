import { describe, expect, it } from 'vitest';
import {
  editorTargetCapabilities,
  isSprayWallTarget,
  type CatalogueEditorTarget,
  type SprayWallEditorTarget,
} from '../editor-target';

const catalogue: CatalogueEditorTarget = {
  kind: 'catalogue',
  boardName: 'kilter',
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27',
};

const sprayWall: SprayWallEditorTarget = {
  kind: 'sprayWall',
  wallUuid: '0f2b1a5c-0000-4000-8000-000000000000',
  layoutId: 4001,
  versionId: '77',
  viewerCanEdit: true,
};

describe('editorTargetCapabilities', () => {
  it('leaves the catalogue target exactly as it was', () => {
    expect(editorTargetCapabilities(catalogue)).toEqual({
      outlineKinds: ['SILHOUETTE', 'LED_INNER'],
      canEditHolds: false,
      canReviewCandidates: false,
      fingerDrawDefault: false,
      localized: false,
      accessRule: 'admin',
    });
  });

  it('gives a wall the hold tools, candidate review and a finger that draws', () => {
    expect(editorTargetCapabilities(sprayWall)).toEqual({
      outlineKinds: ['SILHOUETTE'],
      canEditHolds: true,
      canReviewCandidates: true,
      fingerDrawDefault: true,
      localized: true,
      accessRule: 'wallOwner',
    });
  });

  it('never offers the LED ring on a wall, which has no LEDs at all', () => {
    expect(editorTargetCapabilities(sprayWall).outlineKinds).not.toContain('LED_INNER');
  });

  it('keeps the stylus-only default on the catalogue target, where a Pencil is the point', () => {
    expect(editorTargetCapabilities(catalogue).fingerDrawDefault).toBe(false);
  });

  it('gates the two targets under different rules', () => {
    expect(editorTargetCapabilities(catalogue).accessRule).toBe('admin');
    expect(editorTargetCapabilities(sprayWall).accessRule).toBe('wallOwner');
  });

  it('answers the same object every time, so a capability is never a fresh render dep', () => {
    expect(editorTargetCapabilities(sprayWall)).toBe(editorTargetCapabilities({ ...sprayWall, layoutId: 9 }));
  });
});

describe('isSprayWallTarget', () => {
  it('narrows', () => {
    expect(isSprayWallTarget(sprayWall)).toBe(true);
    expect(isSprayWallTarget(catalogue)).toBe(false);
  });
});
