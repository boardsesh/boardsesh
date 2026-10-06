import { describe, expect, it } from 'vitest';
import { sprayDetailRows, viewerOwnsSprayWall, type SprayDetailRowContext } from '../spray-detail-rows';
import { SPRAY_HOLD_EDITOR_PATH, SPRAY_NEW_WALL_PATH } from '../../../lib/spray/spray-routes';
import { LIVE_SPRAY_WALL_ARCHIVE_STATE } from '../../../lib/spray/spray-wall-registry';

const wall = { uuid: 'wall-uuid-1', boardType: 'spray', canEdit: true, ownerId: 'owner-1' };

const free = LIVE_SPRAY_WALL_ARCHIVE_STATE;
const locked = { ...LIVE_SPRAY_WALL_ARCHIVE_STATE, holdsLocked: true };
const archived = {
  ...LIVE_SPRAY_WALL_ARCHIVE_STATE,
  archivedAt: '2026-10-01T09:00:00.000Z',
  replacedByWallUuid: 'new-wall',
  holdsLocked: true,
};

const asOwner = (archive: SprayDetailRowContext['archive']): SprayDetailRowContext => ({
  viewerUserId: 'owner-1',
  archive,
});
const asEditor = (archive: SprayDetailRowContext['archive']): SprayDetailRowContext => ({
  viewerUserId: 'gym-admin',
  archive,
});

const resetHref = `${SPRAY_NEW_WALL_PATH}?resetOf=wall-uuid-1`;
const editHref = `${SPRAY_HOLD_EDITOR_PATH}?wallUuid=wall-uuid-1`;

describe('sprayDetailRows', () => {
  // The matrix the sheet is built from: who is looking, and whether the wall's
  // holds are still free.
  it.each([
    ['the owner, holds free', wall, asOwner(free), ['editHolds', 'resetWall']],
    ['the owner, holds locked', wall, asOwner(locked), ['holdsLocked', 'resetWall']],
    ['an editor who is not the owner, holds free', wall, asEditor(free), ['editHolds']],
    ['an editor who is not the owner, holds locked', wall, asEditor(locked), ['holdsLocked']],
    ['a climber who only follows the wall', { ...wall, canEdit: false }, asEditor(free), []],
    ['the owner of an archived wall', wall, asOwner(archived), []],
    ['an editor of an archived wall', wall, asEditor(archived), []],
    // An unpublished wall never registers from a published version, so the
    // registry has no archive state for it and nothing is offered.
    ['the owner of a wall that has not published', wall, asOwner(null), []],
  ])('offers %s exactly the right rows', (_label, board, context, keys) => {
    expect(sprayDetailRows(board, context).map((row) => row.key)).toEqual(keys);
  });

  it('opens the hold editor, and puts the reset behind a confirm', () => {
    const rows = sprayDetailRows(wall, asOwner(free));
    expect(rows[0]).toEqual({ key: 'editHolds', icon: 'edit', href: editHref, confirmsReset: false });
    expect(rows[1]).toEqual({ key: 'resetWall', icon: 'camera', href: resetHref, confirmsReset: true });
  });

  // The locked row explains to everyone, and leads somewhere only for the owner.
  it('lets only the owner act on "Holds are locked"', () => {
    expect(sprayDetailRows(wall, asOwner(locked))[0]).toEqual({
      key: 'holdsLocked',
      icon: 'lock',
      href: resetHref,
      confirmsReset: true,
    });
    expect(sprayDetailRows(wall, asEditor(locked))[0]).toEqual({
      key: 'holdsLocked',
      icon: 'lock',
      href: null,
      confirmsReset: false,
    });
  });

  // Reset is owner-only on the server (`SPRAY_WALL_RESET_OWNER_ONLY`): edit
  // rights alone never show it, and ownership shows it on a row whose edit
  // answer is missing.
  it('decides reset on ownership, not on edit access', () => {
    expect(sprayDetailRows({ ...wall, canEdit: false }, asOwner(free)).map((row) => row.key)).toEqual(['resetWall']);
    expect(sprayDetailRows({ ...wall, ownerId: undefined }, asOwner(free)).map((row) => row.key)).toEqual([
      'editHolds',
    ]);
  });

  // `canEdit` is optional on UserBoard: "no answer" must not open the hold editor.
  it('offers no hold editor when edit access is unknown', () => {
    expect(sprayDetailRows({ uuid: 'wall-uuid-1', boardType: 'spray' }, asEditor(free))).toEqual([]);
  });

  it('offers nothing on a catalogue board, however much access the viewer has', () => {
    for (const boardType of ['kilter', 'tension', 'moonboard', 'woods']) {
      expect(sprayDetailRows({ ...wall, boardType }, asOwner(free))).toEqual([]);
    }
  });

  // `toBoardName` decides, rather than a bare `=== 'spray'`.
  it('offers nothing for an unknown board type', () => {
    expect(sprayDetailRows({ ...wall, boardType: 'sprayy' }, asOwner(free))).toEqual([]);
    expect(sprayDetailRows({ ...wall, boardType: '' }, asOwner(free))).toEqual([]);
  });

  it('offers nothing when there is no board at all', () => {
    expect(sprayDetailRows(null, asOwner(free))).toEqual([]);
    expect(sprayDetailRows(undefined, asOwner(free))).toEqual([]);
  });

  // A raw `&` in the uuid would silently split into a second query parameter.
  it('escapes the uuid it puts in the query string', () => {
    const rows = sprayDetailRows({ ...wall, uuid: 'a&b=c' }, asOwner(free));
    expect(rows[0].href).toBe(`${SPRAY_HOLD_EDITOR_PATH}?wallUuid=a%26b%3Dc`);
    expect(rows[1].href).toBe(`${SPRAY_NEW_WALL_PATH}?resetOf=a%26b%3Dc`);
  });
});

describe('viewerOwnsSprayWall', () => {
  it('needs both ids, and equal ones', () => {
    expect(viewerOwnsSprayWall({ ownerId: 'owner-1' }, 'owner-1')).toBe(true);
    expect(viewerOwnsSprayWall({ ownerId: 'owner-1' }, 'someone')).toBe(false);
    expect(viewerOwnsSprayWall({ ownerId: 'owner-1' }, null)).toBe(false);
    expect(viewerOwnsSprayWall({ ownerId: '' }, '')).toBe(false);
    expect(viewerOwnsSprayWall({}, undefined)).toBe(false);
  });
});
