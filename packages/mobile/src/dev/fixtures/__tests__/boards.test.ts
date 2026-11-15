import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { STORY_BOARDS } from '../boards';
import { getBoardRenderData } from '../../../lib/board-details';
describe('story board fixtures', () => {
  it.each(Object.entries(STORY_BOARDS))('%s has visible climbs on real valid holds and roles', (name, fixture) => {
    const { board, spray, climbs } = fixture;
    const geometry = spray
      ? { boardWidth: spray.width, boardHeight: spray.height, holdsData: spray.holds }
      : getBoardRenderData({ ...board, setIds: board.setIds.split(',').map(Number) });
    expect(geometry, name).not.toBeNull();
    expect(geometry!.boardWidth).toBeGreaterThan(0);
    expect(geometry!.boardHeight).toBeGreaterThan(0);
    expect(geometry!.holdsData.length).toBeGreaterThan(0);
    const ids = new Set(geometry!.holdsData.map((hold) => hold.id));
    expect(ids.size).toBe(geometry!.holdsData.length);
    for (const hold of geometry!.holdsData) {
      expect(Number.isFinite(hold.cx) && Number.isFinite(hold.cy)).toBe(true);
      expect(hold.r).toBeGreaterThan(0);
    }
    expect(climbs.length).toBeGreaterThan(0);
    for (const climb of climbs) {
      expect(climb.frames).toMatch(/^(p\d+r\d+)+$/);
      const markers = [...climb.frames.matchAll(/p(\d+)r(\d+)/g)];
      expect(markers.length).toBeGreaterThan(0);
      for (const marker of markers) {
        expect(ids.has(Number(marker[1])), `${name}/${climb.name}: hold ${marker[1]}`).toBe(true);
        expect(HOLD_STATE_MAP[board.boardName][Number(marker[2])], `${name}: role ${marker[2]}`).toBeDefined();
      }
    }
  });
  it.each(['spray-liz', 'spray-cherry', 'spray-bowlo'])('%s bundles its original photograph', (name) => {
    const photo = readFileSync(resolve(import.meta.dirname, '../spray', `${name}.jpg`));
    expect(photo[0]).toBe(0xff);
    expect(photo[1]).toBe(0xd8);
    expect(photo.length).toBeGreaterThan(100_000);
  });
});
