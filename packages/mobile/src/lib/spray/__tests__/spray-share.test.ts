import { describe, it, expect } from 'vitest';
import { WEB_BASE_URL } from '../../env';
import { buildSprayClimbSharePath, buildSprayWallShareUrl, sprayWallVisibility } from '../spray-share';

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

describe('buildSprayClimbSharePath', () => {
  const CLIMB_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const PUBLIC_WALL = {
    slug: 'brewery-spray',
    angle: 40,
    climbUuid: CLIMB_UUID,
    climbName: 'Blue Traverse',
    wallUuid: WALL_UUID,
    isPublic: true,
    isUnlisted: false,
  };

  it('points a public wall at the /b/ view www renders, never the numeric /spray/ path', () => {
    const path = buildSprayClimbSharePath(PUBLIC_WALL);
    expect(path).toBe(`/b/brewery-spray/40/view/blue-traverse-${CLIMB_UUID}`);
    expect(path).not.toContain('/spray/');
  });

  it('carries the wall capability for an unlisted wall', () => {
    expect(buildSprayClimbSharePath({ ...PUBLIC_WALL, isPublic: false, isUnlisted: true })).toBe(
      `/b/brewery-spray/40/view/blue-traverse-${CLIMB_UUID}?wall=${WALL_UUID}`,
    );
  });

  it('has no link for a private wall, which www answers with a 404', () => {
    expect(buildSprayClimbSharePath({ ...PUBLIC_WALL, isPublic: false, isUnlisted: false })).toBeNull();
  });

  it('has no link without a slug rather than falling back to a dead numeric one', () => {
    expect(buildSprayClimbSharePath({ ...PUBLIC_WALL, slug: null })).toBeNull();
    expect(buildSprayClimbSharePath({ ...PUBLIC_WALL, slug: undefined })).toBeNull();
    expect(buildSprayClimbSharePath({ ...PUBLIC_WALL, slug: '' })).toBeNull();
  });

  it('falls back to the bare uuid when the name slugs to nothing, as web does', () => {
    expect(buildSprayClimbSharePath({ ...PUBLIC_WALL, climbName: '!!!' })).toBe(
      `/b/brewery-spray/40/view/${CLIMB_UUID}`,
    );
    expect(buildSprayClimbSharePath({ ...PUBLIC_WALL, climbName: '   ' })).toBe(
      `/b/brewery-spray/40/view/${CLIMB_UUID}`,
    );
  });

  it("names an unnamed climb the way www's canonical does", () => {
    // www's `resolveClimbDisplayName(null, 'spray')` is `spray Climb`.
    expect(buildSprayClimbSharePath({ ...PUBLIC_WALL, climbName: null })).toBe(
      `/b/brewery-spray/40/view/spray-climb-${CLIMB_UUID}`,
    );
    expect(buildSprayClimbSharePath({ ...PUBLIC_WALL, climbName: '' })).toBe(
      `/b/brewery-spray/40/view/spray-climb-${CLIMB_UUID}`,
    );
  });

  it('round-trips through the segment parser both hosts use', async () => {
    const { extractUuidFromClimbSegment } = await import('@boardsesh/play-view/readable-url-utils');
    const path = buildSprayClimbSharePath({ ...PUBLIC_WALL, climbName: 'Crimp & Pray 2' }) ?? '';
    const segment = path.split('/').at(-1) ?? '';
    expect(segment).toBe(`crimp-pray-2-${CLIMB_UUID}`);
    expect(extractUuidFromClimbSegment(segment)).toBe(CLIMB_UUID);
  });
});
