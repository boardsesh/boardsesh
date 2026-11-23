import { describe, expect, it } from 'vitest';

import { SYSTEM_BOARD_OWNER_ID, boardOriginFor } from '../board-origin';

describe('boardOriginFor', () => {
  it('calls a board the system account owns public board data, even for a viewer with no id', () => {
    expect(boardOriginFor({ ownerId: SYSTEM_BOARD_OWNER_ID, ownerDisplayName: 'Boardsesh' }, 'viewer')).toBe('synced');
    expect(boardOriginFor({ ownerId: SYSTEM_BOARD_OWNER_ID }, null)).toBe('synced');
  });

  it("names the viewer's own board as theirs", () => {
    expect(boardOriginFor({ ownerId: 'viewer', ownerDisplayName: 'Me' }, 'viewer')).toBe('own');
  });

  it('names another climber only when the server sent both their id and name', () => {
    expect(boardOriginFor({ ownerId: 'sam', ownerDisplayName: 'Sam' }, 'viewer')).toBe('climber');
    expect(boardOriginFor({ ownerId: 'sam', ownerDisplayName: null }, 'viewer')).toBe('hidden');
    expect(boardOriginFor({ ownerId: null, ownerDisplayName: null }, 'viewer')).toBe('hidden');
  });

  it('never treats a missing owner as the signed-out viewer', () => {
    expect(boardOriginFor({ ownerId: null }, null)).toBe('hidden');
    expect(boardOriginFor({ ownerId: null }, undefined)).toBe('hidden');
  });
});
