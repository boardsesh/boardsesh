import { describe, expect, it } from 'vitest';
import { sprayDetailRows } from '../spray-detail-rows';
import { SPRAY_HOLD_EDITOR_PATH, SPRAY_RESET_PATH } from '../../../lib/spray/spray-routes';

const wall = { uuid: 'wall-uuid-1', boardType: 'spray', canEdit: true };

describe('sprayDetailRows', () => {
  it('offers the hold editor and a new photo on a wall the viewer may edit', () => {
    const rows = sprayDetailRows(wall);

    expect(rows.map((row) => row.key)).toEqual(['editHolds', 'newPhoto']);
    expect(rows[0].href).toBe(`${SPRAY_HOLD_EDITOR_PATH}?boardUuid=wall-uuid-1`);
    expect(rows[1].href).toBe(`${SPRAY_RESET_PATH}?boardUuid=wall-uuid-1`);
  });

  // The gate. Every one of these rows leads into a screen the server refuses for
  // anyone else, so offering it is a dead end at best.
  it('offers nothing on a wall the viewer may only climb on', () => {
    expect(sprayDetailRows({ ...wall, canEdit: false })).toEqual([]);
  });

  // `canEdit` is optional on UserBoard — a partial board built from an offline
  // snapshot or a board path carries no answer, and "no answer" must not open the
  // owner's doors.
  it('offers nothing when edit access is unknown', () => {
    expect(sprayDetailRows({ uuid: 'wall-uuid-1', boardType: 'spray' })).toEqual([]);
  });

  it('offers nothing on a catalogue board, however much access the viewer has', () => {
    for (const boardType of ['kilter', 'tension', 'moonboard', 'woods']) {
      expect(sprayDetailRows({ ...wall, boardType })).toEqual([]);
    }
  });

  // An unrecognised board string is not a wall. `toBoardName` is what decides,
  // rather than a bare `=== 'spray'`, so a board type we cannot name never
  // reaches a wall-only screen.
  it('offers nothing for an unknown board type', () => {
    expect(sprayDetailRows({ ...wall, boardType: 'sprayy' })).toEqual([]);
    expect(sprayDetailRows({ ...wall, boardType: '' })).toEqual([]);
  });

  it('offers nothing when there is no board at all', () => {
    expect(sprayDetailRows(null)).toEqual([]);
    expect(sprayDetailRows(undefined)).toEqual([]);
  });

  // A uuid is a uuid today, but the href is a URL either way and a raw `&` in it
  // would silently split into a second query parameter.
  it('escapes the uuid it puts in the query string', () => {
    const rows = sprayDetailRows({ ...wall, uuid: 'a&b=c' });
    expect(rows[0].href).toBe(`${SPRAY_HOLD_EDITOR_PATH}?boardUuid=a%26b%3Dc`);
  });
});
