import { describe, it, expect } from 'vitest';
import { WEB_BASE_URL } from '../../env';
import { buildSprayWallShareUrl, sprayWallVisibility } from '../spray-share';

const WALL_UUID = '11111111-2222-3333-4444-555555555555';

describe('buildSprayWallShareUrl', () => {
  it('leaves a public wall without a capability param', () => {
    expect(
      buildSprayWallShareUrl({
        slug: 'brewery-spray',
        angle: 40,
        wallUuid: WALL_UUID,
        isPublic: true,
        isUnlisted: false,
      }),
    ).toBe(`${WEB_BASE_URL}/b/brewery-spray/40/list`);
  });

  it('carries the wall uuid for an unlisted wall', () => {
    expect(
      buildSprayWallShareUrl({
        slug: 'brewery-spray',
        angle: 40,
        wallUuid: WALL_UUID,
        isPublic: false,
        isUnlisted: true,
      }),
    ).toBe(`${WEB_BASE_URL}/b/brewery-spray/40/list?wall=${WALL_UUID}`);
  });

  it('drops the capability param once an unlisted wall goes public', () => {
    expect(
      buildSprayWallShareUrl({
        slug: 'brewery-spray',
        angle: 40,
        wallUuid: WALL_UUID,
        isPublic: true,
        isUnlisted: true,
      }),
    ).toBe(`${WEB_BASE_URL}/b/brewery-spray/40/list`);
  });

  it('returns null for a private wall', () => {
    expect(
      buildSprayWallShareUrl({
        slug: 'brewery-spray',
        angle: 40,
        wallUuid: WALL_UUID,
        isPublic: false,
        isUnlisted: false,
      }),
    ).toBeNull();
  });

  it('omits the angle segment when no angle is given', () => {
    expect(
      buildSprayWallShareUrl({ slug: 'brewery-spray', wallUuid: WALL_UUID, isPublic: true, isUnlisted: false }),
    ).toBe(`${WEB_BASE_URL}/b/brewery-spray`);
    expect(
      buildSprayWallShareUrl({
        slug: 'brewery-spray',
        angle: null,
        wallUuid: WALL_UUID,
        isPublic: false,
        isUnlisted: true,
      }),
    ).toBe(`${WEB_BASE_URL}/b/brewery-spray?wall=${WALL_UUID}`);
  });

  it('encodes the slug and the uuid', () => {
    expect(
      buildSprayWallShareUrl({
        slug: 'marco/spray wall',
        angle: 40,
        wallUuid: 'wall uuid&x',
        isPublic: false,
        isUnlisted: true,
      }),
    ).toBe(`${WEB_BASE_URL}/b/marco%2Fspray%20wall/40/list?wall=wall%20uuid%26x`);
  });
});

describe('sprayWallVisibility', () => {
  it('reads the two flags as one value, public first', () => {
    expect(sprayWallVisibility({ isPublic: true, isUnlisted: true })).toBe('public');
    expect(sprayWallVisibility({ isPublic: false, isUnlisted: true })).toBe('unlisted');
    expect(sprayWallVisibility({ isPublic: false, isUnlisted: false })).toBe('private');
  });
});
