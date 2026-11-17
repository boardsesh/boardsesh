import { describe, expect, it } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { presentAuroraClimb, resolveBoardPresenceAngle, withAuroraActionOrientation } from '../presentation';

const occurrence: BoardPresenceClimb = {
  source: 'aurora',
  climbUuid: 'climb',
  angle: null,
  grade: null,
  mirrored: null,
  sentAt: '2026-11-17T06:53:45.349160Z',
  seq: 7,
};

describe('Aurora display presentation', () => {
  it('lets two viewers use different selected angles without changing occurrence metadata', () => {
    const shallow = presentAuroraClimb(occurrence, 20, '6a');
    const steep = presentAuroraClimb(occurrence, 45, '7a');
    expect(shallow).toMatchObject({ angle: 20, grade: '6a', mirrored: null, seq: 7, sentAt: occurrence.sentAt });
    expect(steep).toMatchObject({ angle: 45, grade: '7a', mirrored: null, seq: 7, sentAt: occurrence.sentAt });
    expect(occurrence).toMatchObject({ angle: null, grade: null, mirrored: null });
  });

  it('retains an explicitly selected zero-degree angle', () => {
    expect(resolveBoardPresenceAngle(occurrence, 0)).toBe(0);
    expect(presentAuroraClimb(occurrence, 0, null).angle).toBe(0);
  });

  it('preserves recorded Kilter and native metadata', () => {
    for (const source of ['kilter', 'boardsesh'] as const) {
      const recorded = { ...occurrence, source, angle: 40, grade: '7a' };
      expect(resolveBoardPresenceAngle(recorded, 20)).toBe(40);
      expect(presentAuroraClimb(recorded, 20, '6a')).toBe(recorded);
    }
  });
});

it('resolves the current Aurora action orientation without changing catalog or event metadata', () => {
  const catalog = { uuid: 'climb', mirrored: false };
  expect(withAuroraActionOrientation(catalog, 'aurora', true)).toEqual({ uuid: 'climb', mirrored: true });
  expect(withAuroraActionOrientation(catalog, 'aurora', false)).toEqual(catalog);
  expect(withAuroraActionOrientation(catalog, 'kilter', true)).toBe(catalog);
  expect(catalog.mirrored).toBe(false);
  expect(occurrence.mirrored).toBeNull();
});
