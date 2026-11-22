import { describe, expect, it, vi } from 'vitest';
import type { SprayEditorHold } from '../spray-hold-editor-reducer';
import { cachedHoldPathData } from '../spray-hold-path';
import {
  EMPTY_SPRAY_HOLD_PATH_CHUNKS,
  SPRAY_HOLD_PATH_CHUNK_SIZE,
  reconcileSprayHoldPathChunks,
} from '../spray-hold-path-chunks';

function hold(id: number): SprayEditorHold {
  return {
    id,
    cx: id * 3,
    cy: id * 2,
    r: 10,
    outline: [-1, -1, 1, -1, 1, 1, -1, 1],
    source: 'MANUAL',
    confidence: null,
    review: 'accepted',
    dirty: false,
  };
}

function wall(count: number): SprayEditorHold[] {
  return Array.from({ length: count }, (_, index) => hold(index + 1));
}

describe('bounded native hold paths', () => {
  it.each([50, 530, 1500])('bounds every native path on a %s-hold wall', (count) => {
    const holds = wall(count);
    const result = reconcileSprayHoldPathChunks(EMPTY_SPRAY_HOLD_PATH_CHUNKS, holds, null);
    expect(result.chunks).toHaveLength(Math.ceil(count / SPRAY_HOLD_PATH_CHUNK_SIZE));
    expect(result.chunks.flatMap((chunk) => chunk.entries.map((entry) => entry.hold.id))).toEqual(
      holds.map((entry) => entry.id),
    );
    for (const chunk of result.chunks) {
      expect(chunk.entries.length).toBeLessThanOrEqual(32);
      expect(chunk.on.match(/M/g)).toHaveLength(chunk.entries.length);
    }
  });

  it('a newly sorted local id changes only the last partial chunk', () => {
    const holds = wall(530);
    const initial = reconcileSprayHoldPathChunks(EMPTY_SPRAY_HOLD_PATH_CHUNKS, holds, null);
    const added = reconcileSprayHoldPathChunks(initial, [hold(-1), ...holds], null);
    expect(added.chunks).toHaveLength(initial.chunks.length);
    for (let index = 0; index < initial.chunks.length - 1; index += 1) {
      expect(added.chunks[index]).toBe(initial.chunks[index]);
    }
    expect(added.chunks.at(-1)?.entries.at(-1)?.hold.id).toBe(-1);
    expect(initial.chunks.at(-1)?.entries).toHaveLength(18);
  });

  it('reuses deletion gaps without moving unrelated holds or growing chunks', () => {
    let holds = wall(64);
    let result = reconcileSprayHoldPathChunks(EMPTY_SPRAY_HOLD_PATH_CHUNKS, holds, null);
    const untouched = result.chunks[1];
    for (let index = 0; index < 100; index += 1) {
      const removedId = holds[0].id;
      holds = holds.filter((entry) => entry.id !== removedId);
      result = reconcileSprayHoldPathChunks(result, holds, null);
      holds = [hold(-index - 1), ...holds];
      result = reconcileSprayHoldPathChunks(result, holds, null);
      expect(result.chunks).toHaveLength(2);
      expect(result.chunks[1]).toBe(untouched);
    }
  });

  it('selection only changes the chunks containing the previous and next ghost', () => {
    const holds = wall(1500);
    const initial = reconcileSprayHoldPathChunks(EMPTY_SPRAY_HOLD_PATH_CHUNKS, holds, 1);
    const selected = reconcileSprayHoldPathChunks(initial, holds, 100);
    const changed = selected.chunks.filter((chunk, index) => chunk !== initial.chunks[index]);
    expect(changed).toHaveLength(2);
    expect(
      selected.chunks
        .flatMap((chunk) => chunk.entries)
        .filter((entry) => entry.role === 'off')
        .map((entry) => entry.hold.id),
    ).toEqual([100]);
  });

  it.each(['move', 'resize', 'outline'] as const)('updates a %s even when the id is unchanged', (change) => {
    const holds = wall(64);
    const original = holds[2];
    const replacement =
      change === 'move'
        ? { ...original, cx: original.cx + 5 }
        : change === 'resize'
          ? { ...original, r: original.r * 2 }
          : { ...original, outline: [-1, -1, 2, -1, 1, 1, -1, 1] };
    const initial = reconcileSprayHoldPathChunks(EMPTY_SPRAY_HOLD_PATH_CHUNKS, holds, null);
    const edited = reconcileSprayHoldPathChunks(
      initial,
      holds.map((entry) => (entry.id === original.id ? replacement : entry)),
      null,
    );
    expect(edited.chunks[0].on).not.toBe(initial.chunks[0].on);
    expect(edited.chunks[1]).toBe(initial.chunks[1]);
    const undone = reconcileSprayHoldPathChunks(edited, holds, null);
    expect(undone.chunks[0].on).toBe(initial.chunks[0].on);
    expect(undone.chunks[1]).toBe(initial.chunks[1]);
  });

  it('does not mutate a committed cache when another render is abandoned', () => {
    const holds = wall(50);
    const initial = reconcileSprayHoldPathChunks(EMPTY_SPRAY_HOLD_PATH_CHUNKS, holds, null);
    reconcileSprayHoldPathChunks(initial, [hold(-1), ...holds], 1);
    expect(reconcileSprayHoldPathChunks(initial, holds, null)).toBe(initial);
    expect(initial.chunks.flatMap((chunk) => chunk.entries)).toHaveLength(50);
    expect(initial.nextKey).toBe(2);
  });

  it('releases removed geometry and reuses an emptied chunk', () => {
    const initial = reconcileSprayHoldPathChunks(EMPTY_SPRAY_HOLD_PATH_CHUNKS, wall(50), null);
    const emptied = reconcileSprayHoldPathChunks(initial, [], null);
    expect(emptied.chunks.every((chunk) => chunk.entries.length === 0 && chunk.on === '')).toBe(true);
    const restored = reconcileSprayHoldPathChunks(emptied, wall(50), null);
    expect(restored.chunks.map((chunk) => chunk.key)).toEqual(initial.chunks.map((chunk) => chunk.key));
  });

  it('shares immutable geometry paths between the board and loupe', () => {
    const outline = vi.fn(() => [-1, -1, 1, -1, 1, 1, -1, 1]);
    const geometry = hold(1);
    Object.defineProperty(geometry, 'outline', { get: outline });
    const first = cachedHoldPathData(geometry);
    const readsAfterFirstPath = outline.mock.calls.length;
    expect(cachedHoldPathData(geometry)).toBe(first);
    expect(outline).toHaveBeenCalledTimes(readsAfterFirstPath);
  });
});
