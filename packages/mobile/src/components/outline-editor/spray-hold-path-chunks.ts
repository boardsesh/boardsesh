import { holdRole, type SprayEditorHold } from './spray-hold-editor-reducer';
import { cachedHoldPathData } from './spray-hold-path';

/** Keep each native SVG parse bounded even on a 1,500-hold wall. */
export const SPRAY_HOLD_PATH_CHUNK_SIZE = 32;

export type SprayHoldPathEntry = {
  readonly hold: SprayEditorHold;
  readonly role: 'on' | 'maybe' | 'off';
  readonly path: string;
};

export type SprayHoldPathChunk = {
  readonly key: number;
  readonly entries: readonly SprayHoldPathEntry[];
  readonly on: string;
  readonly maybe: string;
  readonly off: string;
};

export type SprayHoldPathChunks = {
  readonly chunks: readonly SprayHoldPathChunk[];
  readonly nextKey: number;
};

export const EMPTY_SPRAY_HOLD_PATH_CHUNKS: SprayHoldPathChunks = { chunks: [], nextKey: 0 };

type WorkingChunk = {
  key: number;
  entries: SprayHoldPathEntry[];
  original: SprayHoldPathChunk | null;
};

function entryForHold(hold: SprayEditorHold, selectedId: number | null): SprayHoldPathEntry {
  return { hold, role: hold.id === selectedId ? 'off' : holdRole(hold), path: cachedHoldPathData(hold) };
}

function finishChunk(chunk: WorkingChunk): SprayHoldPathChunk {
  if (chunk.original) return chunk.original;
  const on: string[] = [];
  const maybe: string[] = [];
  const off: string[] = [];
  for (const entry of chunk.entries) {
    if (entry.role === 'on') on.push(entry.path);
    else if (entry.role === 'maybe') maybe.push(entry.path);
    else off.push(entry.path);
  }
  return { key: chunk.key, entries: chunk.entries, on: on.join(''), maybe: maybe.join(''), off: off.join('') };
}

/**
 * Reuse chunk membership instead of slicing the newly sorted hold list. A new
 * negative local id sorts before every prior hold; re-slicing would otherwise
 * send every path back through the native parser after every addition.
 *
 * Removals leave reusable slots. Empty chunks retain their key and accept the
 * next additions, so repeated add/delete cycles cannot accumulate native nodes.
 * Unchanged chunks and path strings keep their identity, including selection
 * changes that only move the old/new selection into or out of the ghost role.
 * This function is pure; callers publish its cache only after React commits.
 */
export function reconcileSprayHoldPathChunks(
  previous: SprayHoldPathChunks,
  holds: readonly SprayEditorHold[],
  selectedId: number | null,
): SprayHoldPathChunks {
  const remainingHolds = new Map(holds.map((hold) => [hold.id, hold]));
  const workingChunks: WorkingChunk[] = previous.chunks.map((chunk) => {
    const entries: SprayHoldPathEntry[] = [];
    let unchanged = true;
    for (const entry of chunk.entries) {
      const hold = remainingHolds.get(entry.hold.id);
      if (!hold) {
        unchanged = false;
        continue;
      }
      remainingHolds.delete(hold.id);
      const role = hold.id === selectedId ? 'off' : holdRole(hold);
      if (hold === entry.hold && role === entry.role) entries.push(entry);
      else {
        unchanged = false;
        entries.push(entryForHold(hold, selectedId));
      }
    }
    return { key: chunk.key, entries, original: unchanged ? chunk : null };
  });

  let availableChunkIndex = 0;
  let nextKey = previous.nextKey;
  for (const hold of remainingHolds.values()) {
    while (
      availableChunkIndex < workingChunks.length &&
      workingChunks[availableChunkIndex].entries.length >= SPRAY_HOLD_PATH_CHUNK_SIZE
    ) {
      availableChunkIndex += 1;
    }
    let chunk = workingChunks[availableChunkIndex];
    if (!chunk) {
      chunk = { key: nextKey, entries: [], original: null };
      workingChunks.push(chunk);
      nextKey += 1;
    }
    chunk.entries.push(entryForHold(hold, selectedId));
    chunk.original = null;
  }

  const chunks = workingChunks.map(finishChunk);
  if (nextKey === previous.nextKey && chunks.every((chunk, index) => chunk === previous.chunks[index])) {
    return previous;
  }
  return { chunks, nextKey };
}
