import { describe, expect, it } from 'vitest';
import { getBackgroundRelPaths } from '../background';
import { getBoardDetailsForBoard } from '../board-details';
import { listCatalogueEntries } from '../render-version-projection';

/**
 * Every board photo is committed twice: a `.png` and the `.webp` that
 * `packages/web/scripts/convert-to-webp.sh` makes from it. Only the WebP is ever
 * read — and the backend's Docker context now leaves the PNGs behind, which cut
 * the images tree it ships from 74 MB to 25 MB.
 *
 * That saving is only safe while this holds. A catalogue path that resolved to a
 * `.png` would exist in the repo, pass every test run from a developer's
 * checkout, and 404 only inside the built image.
 */
describe('board art resolves to WebP only', () => {
  const entries = listCatalogueEntries().map((entry) => {
    const label = `${entry.boardName}/${entry.layoutId}-${entry.sizeId}`;
    try {
      const details = getBoardDetailsForBoard({
        board_name: entry.boardName,
        layout_id: entry.layoutId,
        size_id: entry.sizeId,
        set_ids: entry.setIds,
      });
      return {
        boardName: entry.boardName,
        label,
        relPaths: [false, true].flatMap((thumbnail) => getBackgroundRelPaths(details, thumbnail)),
        // Recorded rather than swallowed: a board that stops resolving would
        // otherwise drop out of this walk silently, and a lower-bound count is
        // far too loose to notice a whole board type going missing.
        failed: false,
      };
    } catch {
      return { boardName: entry.boardName, label, relPaths: [] as string[], failed: true };
    }
  });

  const paths = entries.flatMap(({ label, relPaths }) => relPaths.map((relPath) => ({ label, relPath })));

  it('resolves every catalogue entry', () => {
    expect(entries.filter((entry) => entry.failed).map((entry) => entry.label)).toEqual([]);
  });

  it('produces art for every board in the catalogue', () => {
    const boardsWithoutArt = [...new Set(entries.map((entry) => entry.boardName))].filter(
      (boardName) => !entries.some((entry) => entry.boardName === boardName && entry.relPaths.length > 0),
    );

    expect(boardsWithoutArt).toEqual([]);
  });

  it('covers the whole catalogue, full size and thumbnail', () => {
    expect(paths.length).toBeGreaterThan(100);
  });

  it('never asks for a raster the runtime image does not ship', () => {
    const notWebp = paths.filter(({ relPath }) => !relPath.endsWith('.webp'));

    expect(
      notWebp.map(({ label, relPath }) => `${label} → ${relPath}`),
      'the backend Docker context excludes .png; a non-WebP path here 404s only inside the image',
    ).toEqual([]);
  });

  it('asks for the dark variants as WebP too', () => {
    const darkPaths = listCatalogueEntries().flatMap((entry) => {
      try {
        const details = getBoardDetailsForBoard({
          board_name: entry.boardName,
          layout_id: entry.layoutId,
          size_id: entry.sizeId,
          set_ids: entry.setIds,
        });
        return getBackgroundRelPaths(details, false, 'dark');
      } catch {
        return [];
      }
    });

    expect(darkPaths.length).toBeGreaterThan(0);
    expect(darkPaths.filter((relPath) => !relPath.endsWith('.webp'))).toEqual([]);
  });
});
