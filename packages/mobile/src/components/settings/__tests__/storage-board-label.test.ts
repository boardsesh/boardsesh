// Pure, zero-mock coverage: the label resolves from bundled static data, so if these
// pass, the Manage Storage screen names boards correctly with no network and no auth.

import { describe, it, expect } from 'vitest';
import { storageBoardLabel } from '../storage-board-label';

const unknownScope = ({ layoutId, sizeId }: { layoutId: number; sizeId: number }) =>
  `Layout ${layoutId} · Size ${sizeId}`;

describe('storageBoardLabel', () => {
  it('names a known layout and size from bundled data', () => {
    // Real ids from the generated Aurora tables: Kilter layout 1, size 7 = "12 x 14".
    const label = storageBoardLabel('kilter:1:7', unknownScope);

    expect(label).toEqual({ title: 'Kilter Board Original', subtitle: 'Kilter · 12 x 14' });
  });

  it('falls back to the board name when the layout is newer than the bundled tables', () => {
    const label = storageBoardLabel('kilter:9999:7', unknownScope);

    expect(label).toEqual({ title: 'Kilter', subtitle: 'Layout 9999 · Size 7' });
  });

  it('falls back for a board type the bundled data does not know', () => {
    const label = storageBoardLabel('someboard:1:7', unknownScope);

    // Still a usable, removable row — an orphaned scope is the one you most need to
    // reclaim, so it must never be the one that can't render.
    expect(label?.subtitle).toBe('Layout 1 · Size 7');
    expect(label?.title).toBeTruthy();
  });

  it('keeps the layout name when only the size is unknown', () => {
    const label = storageBoardLabel('kilter:1:9999', unknownScope);

    expect(label?.title).toBe('Kilter Board Original');
    expect(label?.subtitle).toBe('Kilter · Layout 1 · Size 9999');
  });

  // A malformed entry has no rows behind it, so the screen skips the row rather than
  // rendering a Remove button that would delete nothing.
  it('returns null for a malformed scope key', () => {
    expect(storageBoardLabel('kilter', unknownScope)).toBeNull();
    expect(storageBoardLabel('kilter:notanumber:5', unknownScope)).toBeNull();
  });
});
